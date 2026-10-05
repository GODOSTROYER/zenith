package update_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

type channel struct {
	t        *testing.T
	srv      *httptest.Server
	priv     ed25519.PrivateKey
	pub      protocol.KeyEntry
	mu       sync.Mutex
	manifest []byte
	artifact []byte
}

func newChannel(t *testing.T) *channel {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := &channel{t: t, priv: priv, pub: protocol.KeyEntry{Kid: "rel-1", PublicKey: protocol.B64Encode(pub)}}
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, _ = w.Write(c.manifest)
	})
	mux.HandleFunc("/artifact", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, _ = w.Write(c.artifact)
	})
	c.srv = httptest.NewServer(mux)
	t.Cleanup(c.srv.Close)
	return c
}

// publish signs and serves a manifest for artifact bytes. servedArtifact lets a
// test serve different bytes than the manifest signed.
func (c *channel) publish(version string, seq int64, downgrade bool, signedArtifact, servedArtifact []byte, key ed25519.PrivateKey) {
	c.t.Helper()
	sum := sha256.Sum256(signedArtifact)
	now := time.Now().UTC()
	m := release.Manifest{
		Channel: "stable", Component: release.ComponentZenithd, Version: version, Seq: seq, AllowDowngrade: downgrade,
		IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339),
		Artifacts: []release.Artifact{{OS: "linux", Arch: "amd64", URL: c.srv.URL + "/artifact", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(signedArtifact))}},
	}
	env, err := release.Sign(key, "rel-1", m)
	if err != nil {
		c.t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	c.mu.Lock()
	c.manifest, c.artifact = raw, servedArtifact
	c.mu.Unlock()
}

func manager(t *testing.T, c *channel, stateDir, running string, smoke func(context.Context, string, string, string) error) *update.Manager {
	t.Helper()
	if smoke == nil {
		smoke = func(context.Context, string, string, string) error { return nil }
	}
	return update.NewManager(stateDir, release.ComponentZenithd, running, update.Settings{
		Enabled: true, Channel: "stable", ManifestURL: c.srv.URL + "/manifest.json", PublicKeys: []protocol.KeyEntry{c.pub},
		HealthWindow: time.Minute, MaxBoots: 2,
	}, update.ManagerOptions{GOOS: "linux", GOARCH: "amd64", Smoke: smoke})
}

func TestStageVerifiesSignatureDigestAndSmokeThenActivatesAsPending(t *testing.T) {
	c := newChannel(t)
	dir := t.TempDir()
	bin := []byte("new binary bytes")
	c.publish("1.1.0", 7, false, bin, bin, c.priv)
	m := manager(t, c, dir, "1.0.0", nil)
	out, err := m.CheckAndStage(context.Background())
	if err != nil || !out.Staged || out.Version != "1.1.0" {
		t.Fatalf("expected a staged release, got %+v err=%v", out, err)
	}
	st, _ := m.Store().Load()
	if st.Active == nil || st.Active.Version != "1.1.0" || st.Pending == nil || st.LastSeq != 7 || st.Previous != nil {
		t.Fatalf("unexpected state %+v", st)
	}
	got, err := os.ReadFile(st.Active.Path)
	if err != nil || string(got) != string(bin) {
		t.Fatalf("staged file content differs: %v", err)
	}
	// a second check while pending does nothing
	if out, _ := m.CheckAndStage(context.Background()); out.Staged {
		t.Fatal("must not stage over a release that is still awaiting its health check")
	}
}

func TestStageRefusesBadSignatureDigestSmokeAndReplay(t *testing.T) {
	c := newChannel(t)
	dir := t.TempDir()
	bin := []byte("new binary bytes")

	// signed by a key that is not pinned
	_, rogue, _ := ed25519.GenerateKey(rand.Reader)
	c.publish("1.1.0", 7, false, bin, bin, rogue)
	m := manager(t, c, dir, "1.0.0", nil)
	if _, err := m.CheckAndStage(context.Background()); err == nil {
		t.Fatal("a manifest signed by an unpinned key must be refused")
	}

	// the host serves bytes that differ from the signed digest
	c.publish("1.1.0", 7, false, bin, []byte("malicious bytes!"), c.priv)
	if _, err := m.CheckAndStage(context.Background()); err == nil || !strings.Contains(err.Error(), "artifact") {
		t.Fatalf("a digest or size mismatch must be refused, got %v", err)
	}

	// the binary does not run
	c.publish("1.1.0", 7, false, bin, bin, c.priv)
	broken := manager(t, c, dir, "1.0.0", func(context.Context, string, string, string) error { return errors.New("exec format error") })
	if _, err := broken.CheckAndStage(context.Background()); err == nil || !strings.Contains(err.Error(), "smoke") {
		t.Fatalf("a failing smoke test must refuse activation, got %v", err)
	}
	if st, _ := m.Store().Load(); st.Active != nil || st.Pending != nil {
		t.Fatalf("nothing may be activated after refusals: %+v", st)
	}

	// success, commit, then a replay of the same manifest and a downgrade
	if out, err := m.CheckAndStage(context.Background()); err != nil || !out.Staged {
		t.Fatalf("expected success: %+v %v", out, err)
	}
	running := manager(t, c, dir, "1.1.0", nil)
	if err := running.Commit(); err != nil {
		t.Fatal(err)
	}
	if out, _ := running.CheckAndStage(context.Background()); out.Staged {
		t.Fatal("a replayed manifest must not apply")
	}
	c.publish("1.0.5", 8, false, bin, bin, c.priv)
	if out, _ := running.CheckAndStage(context.Background()); out.Staged {
		t.Fatal("an unsigned-as-rollback downgrade must not apply")
	}
	c.publish("1.0.5", 9, true, []byte("older binary"), []byte("older binary"), c.priv)
	if out, err := running.CheckAndStage(context.Background()); err != nil || !out.Staged {
		t.Fatalf("a signed rollback release applies: %+v %v", out, err)
	}
}

func stageOne(t *testing.T, version string) (*update.Manager, string, *channel) {
	t.Helper()
	c := newChannel(t)
	dir := t.TempDir()
	bin := []byte("binary " + version)
	c.publish(version, 3, false, bin, bin, c.priv)
	m := manager(t, c, dir, "1.0.0", nil)
	if out, err := m.CheckAndStage(context.Background()); err != nil || !out.Staged {
		t.Fatalf("stage failed: %+v %v", out, err)
	}
	return m, dir, c
}

func launch(dir string, now time.Time) (update.Plan, error) {
	return update.Decide(update.LaunchOptions{StateDir: dir, Self: "/usr/local/bin/zenithd", Now: func() time.Time { return now }, MaxBoots: 2})
}

func TestLauncherExecsPendingReleaseThenRollsBackWhenItNeverBecomesHealthy(t *testing.T) {
	m, dir, _ := stageOne(t, "1.1.0")
	st, _ := m.Store().Load()
	now := time.Now()

	for i := 0; i < 2; i++ {
		plan, err := launch(dir, now)
		if err != nil || plan.ExecPath != st.Active.Path || plan.RolledBack {
			t.Fatalf("boot %d should run the pending release: %+v %v", i+1, plan, err)
		}
	}
	// the third start finds two boots without a commit: roll back to the baseline
	plan, err := launch(dir, now)
	if err != nil || !plan.RolledBack || plan.ExecPath != "" {
		t.Fatalf("expected a rollback to the packaged binary: %+v %v", plan, err)
	}
	after, _ := m.Store().Load()
	if after.Active != nil || after.Pending != nil || after.RolledBackFrom != "1.1.0" || len(after.Failed) != 1 {
		t.Fatalf("unexpected state after rollback: %+v", after)
	}
	// the failed version is not applied again
	c := newChannel(t)
	bin := []byte("binary 1.1.0")
	c.publish("1.1.0", 4, false, bin, bin, c.priv)
	again := manager(t, c, dir, "1.0.0", nil)
	if out, _ := again.CheckAndStage(context.Background()); out.Staged {
		t.Fatal("a version that failed its health check must not be re-applied")
	}
}

func TestLauncherRollsBackAfterDeadlineAndOnTamperedBinary(t *testing.T) {
	m, dir, _ := stageOne(t, "1.1.0")
	st, _ := m.Store().Load()
	plan, err := launch(dir, st.Pending.Deadline.Add(time.Second))
	if err != nil || !plan.RolledBack || plan.ExecPath != "" {
		t.Fatalf("a passed deadline must roll back: %+v %v", plan, err)
	}

	m2, dir2, _ := stageOne(t, "1.2.0")
	st2, _ := m2.Store().Load()
	if err := os.WriteFile(st2.Active.Path, []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	plan, err = launch(dir2, time.Now())
	if err != nil || !plan.RolledBack || plan.ExecPath != "" {
		t.Fatalf("a binary that no longer matches its verified digest must never be executed: %+v %v", plan, err)
	}
}

func TestCommitClearsPendingAndKeepsPreviousForManualRollback(t *testing.T) {
	m, dir, c := stageOne(t, "1.1.0")
	running := manager(t, c, dir, "1.1.0", nil)
	if p, _ := running.PendingForRunning(); p == nil {
		t.Fatal("the running release must see its own pending record")
	}
	if err := running.Commit(); err != nil {
		t.Fatal(err)
	}
	st, _ := m.Store().Load()
	if st.Pending != nil || st.Active == nil {
		t.Fatalf("unexpected state after commit: %+v", st)
	}
	// once committed the launcher no longer counts boots
	if plan, err := launch(dir, time.Now()); err != nil || plan.ExecPath != st.Active.Path || plan.RolledBack {
		t.Fatalf("committed release keeps running: %+v %v", plan, err)
	}
	if changed, err := running.Rollback("manual rollback"); err != nil || !changed {
		t.Fatalf("manual rollback: %v %v", changed, err)
	}
	if s := running.Status(); s.State != "rolled_back" || s.RolledBackFrom != "1.1.0" {
		t.Fatalf("unexpected status %+v", s)
	}
}

func TestLauncherSkipsWhenAlreadyTheActiveRelease(t *testing.T) {
	_, dir, _ := stageOne(t, "1.1.0")
	plan, err := update.Decide(update.LaunchOptions{StateDir: dir, Self: "/x", Environ: []string{update.EnvActiveSlot + "=abc"}})
	if err != nil || plan.ExecPath != "" {
		t.Fatalf("the exec'd release must not launch again: %+v %v", plan, err)
	}
}
