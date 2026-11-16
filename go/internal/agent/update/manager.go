package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

// Defaults.
const (
	DefaultCheckInterval = time.Hour
	DefaultHealthWindow  = 5 * time.Minute
	DefaultMinStable     = 20 * time.Second
	DefaultMaxBoots      = 3
)

// Settings configure a Manager. They come from the agent's LOCAL config.
type Settings struct {
	Enabled     bool
	Channel     string
	ManifestURL string
	// PublicKeys are the pinned release signing keys. They are never learned
	// from the manifest, the artifact host or the control plane.
	PublicKeys    []protocol.KeyEntry
	CheckInterval time.Duration
	HealthWindow  time.Duration
	MinStable     time.Duration
	MaxBoots      int
}

func (s Settings) withDefaults() Settings {
	if s.CheckInterval <= 0 {
		s.CheckInterval = DefaultCheckInterval
	}
	if s.HealthWindow <= 0 {
		s.HealthWindow = DefaultHealthWindow
	}
	if s.MinStable <= 0 {
		s.MinStable = DefaultMinStable
	}
	if s.MaxBoots <= 0 {
		s.MaxBoots = DefaultMaxBoots
	}
	if s.Channel == "" {
		s.Channel = "stable"
	}
	return s
}

// Manager checks the release channel, stages verified releases, and owns the
// commit / rollback decisions. One Manager per agent process.
type Manager struct {
	store     *Store
	set       Settings
	component string
	running   string
	http      *http.Client
	now       func() time.Time
	goos      string
	goarch    string
	// smoke runs a staged binary and checks that it reports the wanted version.
	smoke func(ctx context.Context, path, component, wantVersion string) error
}

// ManagerOptions are test hooks; zero values use the real behavior.
type ManagerOptions struct {
	HTTPClient *http.Client
	Now        func() time.Time
	GOOS       string
	GOARCH     string
	Smoke      func(ctx context.Context, path, component, wantVersion string) error
}

// NewManager builds a Manager for component (release.ComponentRunner or
// release.ComponentZenithd) running version `running`.
func NewManager(stateDir, component, running string, set Settings, o ManagerOptions) *Manager {
	m := &Manager{store: NewStore(stateDir), set: set.withDefaults(), component: component, running: running, http: o.HTTPClient, now: o.Now, goos: o.GOOS, goarch: o.GOARCH, smoke: o.Smoke}
	if m.http == nil {
		m.http = NewHTTPClient(nil)
	}
	if m.now == nil {
		m.now = time.Now
	}
	if m.goos == "" {
		m.goos = runtime.GOOS
	}
	if m.goarch == "" {
		m.goarch = runtime.GOARCH
	}
	if m.smoke == nil {
		m.smoke = runSmoke
	}
	return m
}

// Settings returns the effective settings.
func (m *Manager) Settings() Settings { return m.set }

// Store exposes the state store (CLI and tests).
func (m *Manager) Store() *Store { return m.store }

// NewHTTPClient is the client used for the release channel. Release integrity
// rests on the pinned signature and the artifact digest, so system roots are
// enough; redirects are followed only over https.
func NewHTTPClient(tlsCfg *tls.Config) *http.Client {
	if tlsCfg == nil {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: tlsCfg, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" && release.ValidateArtifactURL(req.URL.String()) != nil {
				return errors.New("redirect to a non-https URL refused")
			}
			return nil
		},
	}
}

// Outcome of a check.
type Outcome struct {
	// Staged is true when a new release was installed and activated; the
	// caller must restart the process (after draining) to run it.
	Staged  bool
	Version string
	Reason  string
}

// CheckAndStage fetches the manifest, verifies it, and when it applies
// downloads, verifies and activates the release as PENDING health. Any failure
// leaves the active release untouched and is recorded in the state.
func (m *Manager) CheckAndStage(ctx context.Context) (Outcome, error) {
	out, err := m.checkAndStage(ctx)
	now := m.now().UTC()
	_, serr := m.store.Update(func(st *State) error {
		st.LastCheckAt = &now
		if err != nil {
			st.LastError = truncate(err.Error(), 300)
			st.LastErrorAt = &now
			addEvent(st, now, "check_failed", "", err.Error())
		} else {
			st.LastError = ""
			st.LastErrorAt = nil
		}
		return nil
	})
	if err == nil && serr != nil {
		err = serr
	}
	return out, err
}

func (m *Manager) checkAndStage(ctx context.Context) (Outcome, error) {
	if m.set.ManifestURL == "" || len(m.set.PublicKeys) == 0 {
		return Outcome{}, errors.New("update.manifestUrl and update.publicKeys must be configured")
	}
	st, err := m.store.Load()
	if err != nil {
		return Outcome{}, err
	}
	if st.Pending != nil {
		return Outcome{Reason: "a previous update is still awaiting its health check"}, nil
	}
	raw, err := m.fetch(ctx, m.set.ManifestURL, release.MaxManifestBytes, 30*time.Second)
	if err != nil {
		return Outcome{}, fmt.Errorf("fetch release manifest: %w", err)
	}
	mf, err := release.Verify(raw, m.set.PublicKeys, m.now())
	if err != nil {
		return Outcome{}, err
	}
	d := release.Decide(mf, m.set.Channel, m.component, m.running, st.LastSeq)
	if !d.Apply {
		return Outcome{Version: mf.Version, Reason: d.Reason}, nil
	}
	if slices.Contains(st.Failed, mf.Version) {
		return Outcome{Version: mf.Version, Reason: "this version failed its health check earlier and was rolled back"}, nil
	}
	art, ok := mf.Find(m.goos, m.goarch)
	if !ok {
		return Outcome{Version: mf.Version, Reason: "the manifest has no artifact for " + m.goos + "/" + m.goarch}, nil
	}
	slot, err := m.install(ctx, mf, art)
	if err != nil {
		return Outcome{Version: mf.Version}, err
	}
	now := m.now().UTC()
	if _, err := m.store.Update(func(cur *State) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if cur.Pending != nil {
			return errors.New("another update was staged concurrently")
		}
		cur.Component = m.component
		cur.Previous = cur.Active
		cur.Active = &slot
		cur.Pending = &Pending{Version: mf.Version, StagedAt: now, Deadline: now.Add(m.set.HealthWindow)}
		cur.LastSeq = mf.Seq
		cur.RolledBackFrom, cur.RolledBackAt, cur.RollbackReason = "", nil, ""
		addEvent(cur, now, "staged", mf.Version, "verified and activated; awaiting health check")
		return nil
	}); err != nil {
		return Outcome{Version: mf.Version}, err
	}
	return Outcome{Staged: true, Version: mf.Version}, nil
}

func (m *Manager) fetch(ctx context.Context, rawURL string, limit int64, timeout time.Duration) ([]byte, error) {
	if err := release.ValidateArtifactURL(rawURL); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, sanitize(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release channel returned %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, sanitize(err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return data, nil
}

func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// install downloads the artifact, checks size and digest against the signed
// manifest, places it under releases/ and smoke-tests it.
func (m *Manager) install(ctx context.Context, mf *release.Manifest, art release.Artifact) (Slot, error) {
	relDir := m.store.ReleasesDir()
	if err := os.MkdirAll(relDir, 0o700); err != nil {
		return Slot{}, fmt.Errorf("create releases dir: %w", err)
	}
	tmp, err := os.CreateTemp(relDir, ".download-*")
	if err != nil {
		return Slot{}, fmt.Errorf("stage artifact: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	sum, err := m.download(ctx, art, tmp)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Slot{}, err
	}
	if sum != art.SHA256 {
		return Slot{}, errors.New("artifact digest does not match the signed manifest; refusing to install")
	}
	if err := os.Chmod(tmpPath, 0o700); err != nil && runtime.GOOS != "windows" {
		return Slot{}, fmt.Errorf("stage artifact: %w", err)
	}
	slotDir := filepath.Join(relDir, mf.Version+"-"+sum[:12])
	if err := os.MkdirAll(slotDir, 0o700); err != nil {
		return Slot{}, fmt.Errorf("stage artifact: %w", err)
	}
	final := filepath.Join(slotDir, m.component)
	if err := os.Rename(tmpPath, final); err != nil {
		return Slot{}, fmt.Errorf("stage artifact: %w", err)
	}
	if err := syncDir(slotDir); err != nil {
		return Slot{}, fmt.Errorf("stage artifact: %w", err)
	}
	// Smoke test BEFORE activation: the binary must execute here and name the
	// version the signed manifest promised.
	if err := m.smoke(ctx, final, m.component, mf.Version); err != nil {
		_ = os.RemoveAll(slotDir)
		return Slot{}, fmt.Errorf("staged binary failed its smoke test: %w", err)
	}
	return Slot{Version: mf.Version, SHA256: sum, Path: final}, nil
}

func (m *Manager) download(ctx context.Context, art release.Artifact, w io.Writer) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, art.URL, nil)
	if err != nil {
		return "", err
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("download artifact: %w", sanitize(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download artifact: release host returned %d", resp.StatusCode)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, h), io.LimitReader(resp.Body, art.Size+1))
	if err != nil {
		return "", fmt.Errorf("download artifact: %w", sanitize(err))
	}
	if n != art.Size {
		return "", fmt.Errorf("artifact is %d bytes, the signed manifest says %d; refusing to install", n, art.Size)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func runSmoke(ctx context.Context, path, component, wantVersion string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("could not run `version`: %w", err)
	}
	if !strings.HasPrefix(out.String(), component+" "+wantVersion+" ") {
		return fmt.Errorf("binary reports %q, expected %s %s", firstLine(out.String()), component, wantVersion)
	}
	return nil
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return truncate(s, 100)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// PendingForRunning returns the pending record when the running version is
// the one awaiting its health check.
func (m *Manager) PendingForRunning() (*Pending, error) {
	st, err := m.store.Load()
	if err != nil {
		return nil, err
	}
	if st.Pending != nil && st.Pending.Version == m.running {
		p := *st.Pending
		return &p, nil
	}
	return nil, nil
}

// Commit marks the running release healthy: the pending state is cleared, the
// rollback record is forgotten, and release directories other than the active
// and previous slots are pruned.
func (m *Manager) Commit() error {
	now := m.now().UTC()
	st, err := m.store.Update(func(st *State) error {
		if st.Pending == nil || st.Pending.Version != m.running {
			return nil
		}
		addEvent(st, now, "committed", st.Pending.Version, "health check passed")
		st.Pending = nil
		st.RolledBackFrom, st.RolledBackAt, st.RollbackReason = "", nil, ""
		return nil
	})
	if err != nil {
		return err
	}
	m.prune(st)
	return nil
}

func (m *Manager) prune(st State) {
	keep := map[string]bool{}
	for _, s := range []*Slot{st.Active, st.Previous} {
		if s != nil {
			keep[filepath.Dir(s.Path)] = true
		}
	}
	ents, err := os.ReadDir(m.store.ReleasesDir())
	if err != nil {
		return
	}
	for _, e := range ents {
		full := filepath.Join(m.store.ReleasesDir(), e.Name())
		if e.IsDir() && !keep[full] {
			_ = os.RemoveAll(full)
		}
	}
}

// Rollback reverts to the previous slot (or the baseline binary) and records
// why. It returns false when there is nothing to roll back. The caller must
// restart the process so the launcher execs the restored slot.
func (m *Manager) Rollback(reason string) (bool, error) {
	changed := false
	_, err := m.store.Update(func(st *State) error {
		changed = rollbackState(st, m.now().UTC(), reason)
		return nil
	})
	return changed, err
}

// rollbackState reverts Active to Previous. It is shared with the launcher.
func rollbackState(st *State, now time.Time, reason string) bool {
	if st.Active == nil {
		st.Pending = nil
		return false
	}
	failed := st.Active.Version
	if !slices.Contains(st.Failed, failed) {
		st.Failed = append(st.Failed, failed)
	}
	st.Active, st.Previous = st.Previous, nil
	st.Pending = nil
	st.RolledBackFrom = failed
	st.RolledBackAt = &now
	st.RollbackReason = truncate(reason, 200)
	addEvent(st, now, "rolled_back", failed, reason)
	return true
}

// Status is the heartbeat / CLI view.
func (m *Manager) Status() Status {
	st, err := m.store.Load()
	if err != nil {
		return Status{State: "check_failed", Channel: m.set.Channel, Running: m.running, LastError: "update state unreadable"}
	}
	return StatusOf(st, m.set.Channel, m.running)
}
