package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/spool"
	"github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

// Exit codes added by the lifecycle: both are non-zero so a service manager
// configured with Restart=on-failure brings the agent back up, where the
// launcher starts the right binary.
const (
	// ExitRestartForUpdate: a verified release was staged; restart to run it.
	ExitRestartForUpdate = 75
	// ExitUpdateRolledBack: the new release failed its health check and the
	// previous one was restored; restart to run it.
	ExitUpdateRolledBack = 76
)

/* ------------------------------ configuration ------------------------------ */

// SpoolConfig bounds the durable result spool.
type SpoolConfig struct {
	MaxEntries int   `json:"maxEntries"` // default 10000
	MaxBytes   int64 `json:"maxBytes"`   // default 512 MiB
}

// UpdateConfig configures the signed release channel. Everything here is LOCAL
// configuration: the control plane cannot change it, and the release keys are
// never taken from the manifest or the artifact host.
type UpdateConfig struct {
	Enabled bool `json:"enabled"`
	// Channel is the release channel followed (default "stable").
	Channel string `json:"channel"`
	// ManifestURL serves the signed release envelope for this component.
	ManifestURL string `json:"manifestUrl"`
	// PublicKeys pins the release signing keys (base64url raw Ed25519).
	PublicKeys       []protocol.KeyEntry `json:"publicKeys"`
	CheckIntervalSec int                 `json:"checkIntervalSec"` // default 3600
	HealthWindowSec  int                 `json:"healthWindowSec"`  // default 300
	MinStableSec     int                 `json:"minStableSec"`     // default 20
	MaxBoots         int                 `json:"maxBoots"`         // default 3
}

func (u UpdateConfig) validate() error {
	if u.Channel != "" && !channelRe.MatchString(u.Channel) {
		return fmt.Errorf("update.channel is invalid")
	}
	if u.CheckIntervalSec != 0 && (u.CheckIntervalSec < 60 || u.CheckIntervalSec > 86400) {
		return fmt.Errorf("update.checkIntervalSec must be between 60 and 86400")
	}
	if u.HealthWindowSec != 0 && (u.HealthWindowSec < 30 || u.HealthWindowSec > 3600) {
		return fmt.Errorf("update.healthWindowSec must be between 30 and 3600")
	}
	if u.MinStableSec != 0 && (u.MinStableSec < 5 || u.MinStableSec > 600) {
		return fmt.Errorf("update.minStableSec must be between 5 and 600")
	}
	if u.MaxBoots < 0 || u.MaxBoots > 10 {
		return fmt.Errorf("update.maxBoots must be between 1 and 10")
	}
	if !u.Enabled {
		return nil
	}
	if err := release.ValidateArtifactURL(u.ManifestURL); err != nil {
		return fmt.Errorf("update.manifestUrl: %w", err)
	}
	if len(u.PublicKeys) == 0 || len(u.PublicKeys) > 8 {
		return fmt.Errorf("update.publicKeys must pin between 1 and 8 release keys")
	}
	if _, err := protocol.NewKeySet(u.PublicKeys); err != nil {
		return fmt.Errorf("update.publicKeys: %w", err)
	}
	return nil
}

// Settings converts the config for the update manager.
func (u UpdateConfig) Settings() update.Settings {
	return update.Settings{
		Enabled: u.Enabled, Channel: u.Channel, ManifestURL: u.ManifestURL, PublicKeys: u.PublicKeys,
		CheckInterval: time.Duration(u.CheckIntervalSec) * time.Second,
		HealthWindow:  time.Duration(u.HealthWindowSec) * time.Second,
		MinStable:     time.Duration(u.MinStableSec) * time.Second,
		MaxBoots:      u.MaxBoots,
	}
}

// ComponentOf maps an agent kind to its release component name.
func ComponentOf(k Kind) string {
	if k.Name == MachineKind.Name {
		return release.ComponentZenithd
	}
	return release.ComponentRunner
}

/* --------------------------- connection tracking --------------------------- */

// Connection states reported to the control plane.
const (
	ConnOnline   = "online"
	ConnDegraded = "degraded" // recent failures, not yet offline
	ConnOffline  = "offline"
)

const (
	offlineAfterFailures = 3
	offlineAfterSilence  = 90 * time.Second // matches the server's stale threshold
)

type connTracker struct {
	mu            sync.Mutex
	now           func() time.Time
	state         string
	failures      int
	lastSuccess   time.Time
	offlineSince  time.Time
	lastRecovered time.Time
	lastOfflineS  int
	reconnect     chan struct{}
}

func newConnTracker(now func() time.Time) *connTracker {
	t := now()
	return &connTracker{now: now, state: ConnOnline, lastSuccess: t, reconnect: make(chan struct{}, 1)}
}

func (c *connTracker) success() (recovered bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.now()
	if c.state == ConnOffline {
		c.lastRecovered = t
		c.lastOfflineS = int(t.Sub(c.offlineSince).Seconds())
		recovered = true
		select {
		case c.reconnect <- struct{}{}:
		default:
		}
	}
	c.state, c.failures, c.lastSuccess = ConnOnline, 0, t
	return recovered
}

// failure records a failed control-plane call and returns true when this
// failure moved the agent to offline.
func (c *connTracker) failure() (wentOffline bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures++
	t := c.now()
	if c.state == ConnOffline {
		return false
	}
	if c.failures >= offlineAfterFailures || t.Sub(c.lastSuccess) >= offlineAfterSilence {
		c.state, c.offlineSince = ConnOffline, c.lastSuccess
		return true
	}
	c.state = ConnDegraded
	return false
}

type connectionReport struct {
	State           string  `json:"state"`
	Failures        int     `json:"consecutiveFailures"`
	OfflineSince    *string `json:"offlineSince,omitempty"`
	LastRecoveredAt *string `json:"lastRecoveredAt,omitempty"`
	LastOfflineSec  int     `json:"lastOfflineSec,omitempty"`
}

func (c *connTracker) report() connectionReport {
	c.mu.Lock()
	defer c.mu.Unlock()
	r := connectionReport{State: c.state, Failures: c.failures, LastOfflineSec: c.lastOfflineS}
	if c.state == ConnOffline {
		s := c.offlineSince.UTC().Format(time.RFC3339)
		r.OfflineSince = &s
	}
	if !c.lastRecovered.IsZero() {
		s := c.lastRecovered.UTC().Format(time.RFC3339)
		r.LastRecoveredAt = &s
	}
	return r
}

/* ------------------------------ heartbeat report ------------------------------ */

type spoolReport struct {
	Depth    int     `json:"depth"`
	Bytes    int64   `json:"bytes"`
	OldestAt *string `json:"oldestAt,omitempty"`
	Replayed int64   `json:"replayed"`
}

// lifecycleReport rides on every heartbeat. It is informational: the control
// plane stores and shows it, and never lets it change what the agent runs.
type lifecycleReport struct {
	Connection connectionReport `json:"connection"`
	Spool      spoolReport      `json:"spool"`
	Update     *update.Status   `json:"update,omitempty"`
}

func (a *Agent) lifecycle() lifecycleReport {
	r := lifecycleReport{Connection: a.conn.report(), Spool: spoolReport{Replayed: a.replayed.Load()}}
	if a.spool != nil {
		st := a.spool.Stats()
		r.Spool.Depth, r.Spool.Bytes = st.Depth, st.Bytes
		if st.OldestAt != nil {
			s := st.OldestAt.UTC().Format(time.RFC3339)
			r.Spool.OldestAt = &s
		}
	}
	if a.updater != nil {
		s := a.updater.Status()
		r.Update = &s
	}
	return r
}

/* ----------------------------- revocation marker ----------------------------- */

const revokedFileName = "revoked.json"

type revokedMarker struct {
	AgentID   string    `json:"agentId"`
	RevokedAt time.Time `json:"revokedAt"`
}

// writeRevokedMarker durably records that the control plane revoked this
// identity, so a restarted agent refuses to take work even before it can reach
// the control plane. Re-registration (a new identity) supersedes it.
func writeRevokedMarker(stateDir, agentID string, now time.Time) error {
	raw, err := json.Marshal(revokedMarker{AgentID: agentID, RevokedAt: now.UTC()})
	if err != nil {
		return err
	}
	path := filepath.Join(stateDir, revokedFileName)
	f, err := os.CreateTemp(stateDir, ".revoked-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return syncIdentityDirectory(stateDir)
}

// IsRevokedLocally reports whether the local marker revokes this identity.
func IsRevokedLocally(stateDir, agentID string) bool {
	raw, err := os.ReadFile(filepath.Join(stateDir, revokedFileName))
	if err != nil {
		return false
	}
	var m revokedMarker
	if json.Unmarshal(raw, &m) != nil {
		return true // an unreadable marker fails closed
	}
	return m.AgentID == agentID
}

func clearRevokedMarker(stateDir string) {
	_ = os.Remove(filepath.Join(stateDir, revokedFileName))
}

/* ---------------------------------- spool replay ---------------------------------- */

func (a *Agent) markInflight(jti string) bool {
	a.inflightMu.Lock()
	defer a.inflightMu.Unlock()
	if _, busy := a.inflight[jti]; busy {
		return false
	}
	a.inflight[jti] = struct{}{}
	return true
}

func (a *Agent) clearInflight(jti string) {
	a.inflightMu.Lock()
	delete(a.inflight, jti)
	a.inflightMu.Unlock()
}

// replayLoop re-posts spooled results at start, whenever the connection
// recovers, and periodically while anything is still spooled. Replay is
// idempotent on the server: an exact retry of the first outcome is accepted, a
// job that is already settled answers 409, and neither duplicates a result.
func (a *Agent) replayLoop(ctx context.Context) {
	if a.spool == nil {
		return
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-a.conn.reconnect:
			a.log.Info("control plane reachable again; replaying spooled results")
		}
		a.replaySpool(ctx)
		next := 5 * time.Minute
		if a.spool.Stats().Depth > 0 {
			next = 30 * time.Second
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(next)
	}
}

func (a *Agent) replaySpool(ctx context.Context) {
	entries := a.spool.Pending(a.opts.Identity.ID)
	if len(entries) == 0 {
		return
	}
	a.log.Info("replaying spooled results", "count", len(entries))
	for _, e := range entries {
		if ctx.Err() != nil || a.revoked.Load() {
			return
		}
		if !a.markInflight(e.JTI) {
			continue
		}
		var body ResultBody
		if err := json.Unmarshal(e.Body, &body); err != nil {
			a.clearInflight(e.JTI)
			a.spool.Quarantine(e.JTI, "undecodable")
			continue
		}
		done, err := a.sendResult(ctx, e.JTI, body)
		a.clearInflight(e.JTI)
		switch {
		case done && err == nil:
			_ = a.spool.Remove(e.JTI)
			a.replayed.Add(1)
		case done:
			a.log.Error("control plane refused a spooled result; quarantined", "job", e.JTI, "err", err)
			a.spool.Quarantine(e.JTI, "refused")
		default:
			a.spool.RecordAttempt(e.JTI, err)
			return // still unreachable or throttled: back off until the next pass
		}
	}
}

/* ------------------------------- update lifecycle ------------------------------- */

// requestExit stops the loop and makes Run return code after draining.
func (a *Agent) requestExit(code int) {
	a.exitOverride.CompareAndSwap(0, int32(code))
	if a.stopLoop != nil {
		a.stopLoop()
	}
}

// updateLoop first settles a pending release (health check, commit or
// rollback), then checks the signed channel on a jittered interval.
func (a *Agent) updateLoop(ctx context.Context) {
	if a.updater == nil {
		return
	}
	if pending, err := a.updater.PendingForRunning(); err != nil {
		a.log.Error("could not read update state", "err", err)
	} else if pending != nil {
		if !a.awaitHealth(ctx, *pending) {
			return
		}
	}
	set := a.updater.Settings()
	if !set.Enabled {
		return
	}
	delay := 30*time.Second + time.Duration(jitter()*float64(30*time.Second))
	for a.waitUpdate(ctx, delay) {
		var out update.Outcome
		var err error
		if a.updateControl != nil {
			out, err = a.updateControl.CheckAndStage(ctx, a.cfg.StateDir, ComponentOf(a.opts.Kind), a.opts.Version, set, update.ManagerOptions{HTTPClient: a.opts.UpdateHTTPClient, Now: a.opts.Now})
		} else {
			out, err = a.updater.CheckAndStage(ctx)
		}
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return
			}
			a.log.Warn("release check failed; keeping the running version", "err", err)
		case out.Staged:
			a.log.Info("verified release staged; restarting to run it after in-flight jobs finish", "version", out.Version)
			a.requestExit(ExitRestartForUpdate)
			return
		case out.Reason != "":
			a.log.Debug("no update applied", "version", out.Version, "reason", out.Reason)
		}
		delay = set.CheckInterval + time.Duration(jitter()*float64(set.CheckInterval)/10)
	}
}

// awaitHealth commits the running release once the agent has made an
// authenticated heartbeat AND poll against the control plane and stayed up for
// the minimum stable time. If the deadline passes first it rolls back.
func (a *Agent) awaitHealth(ctx context.Context, p update.Pending) bool {
	set := a.updater.Settings()
	started := a.now()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-tick.C:
		}
		now := a.now()
		if a.hbOK.Load() && a.pollOK.Load() && now.Sub(started) >= set.MinStable {
			if err := a.updater.Commit(); err != nil {
				a.log.Error("could not record the healthy release", "err", err)
				return true
			}
			a.log.Info("release passed its health check and is now committed", "version", p.Version)
			return true
		}
		if !now.Before(p.Deadline) {
			a.log.Error("release did not pass its health check in time; rolling back", "version", p.Version)
			if changed, err := a.updater.Rollback(fmt.Sprintf("health check did not pass within %s", set.HealthWindow)); err != nil {
				a.log.Error("rollback failed", "err", err)
			} else if changed {
				a.requestExit(ExitUpdateRolledBack)
			}
			return false
		}
	}
}

func jitter() float64 { return rand.Float64() }

var channelRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

var errNoState = errors.New("no state directory")

func newSpool(cfg *Common, now func() time.Time) (*spool.Spool, error) {
	if cfg.StateDir == "" {
		return nil, errNoState
	}
	return spool.Open(filepath.Join(cfg.StateDir, "spool"), cfg.Spool.MaxEntries, cfg.Spool.MaxBytes, now)
}

func newUpdater(cfg *Common, kind Kind, version string, httpc *http.Client, now func() time.Time) *update.Manager {
	if cfg.StateDir == "" {
		return nil
	}
	if !cfg.Update.Enabled && !update.NewStore(cfg.StateDir).Exists() {
		return nil
	}
	return update.NewManager(cfg.StateDir, ComponentOf(kind), version, cfg.Update.Settings(), update.ManagerOptions{HTTPClient: httpc, Now: now})
}

func (a *Agent) waitUpdate(ctx context.Context, delay time.Duration) bool {
	if a.updateControl == nil {
		return sleepCtx(ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	case <-a.updateControl.Wake():
		return true
	}
}
