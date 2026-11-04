package agent_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
)

func spooled(r *rig) int {
	files, _ := filepath.Glob(filepath.Join(r.cfg.StateDir, "spool", "*.json"))
	return len(files)
}

func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A result produced while the control plane is down is durable on disk, and a
// restarted agent delivers it once the control plane is back. This is the
// crash / outage case the spool exists for.
func TestSpooledResultSurvivesOutageAndRestartThenReplays(t *testing.T) {
	r := newRig(t, nil)
	r.fake.FailResults(1000) // every result post answers 503
	r.start(100 * time.Millisecond)
	r.fake.Enqueue("job_spool|ok")
	waitFor(t, 10*time.Second, "the result to reach the durable spool", func() bool { return spooled(r) == 1 })
	if len(r.fake.ResultsFor("job_spool")) != 0 {
		t.Fatal("the control plane must not have accepted the result yet")
	}

	// stop the agent (crash equivalent: the in-memory retry is abandoned)
	r.cancel()
	r.waitExit(30 * time.Second)
	if spooled(r) != 1 {
		t.Fatal("the spooled result must survive the agent stopping")
	}

	// control plane recovers; a new agent process replays the spool
	r.fake.FailResults(0)
	r.start(100 * time.Millisecond)
	if _, ok := r.fake.WaitResult("job_spool", 20*time.Second); !ok {
		t.Fatal("the spooled result was not replayed after restart")
	}
	waitFor(t, 5*time.Second, "the replayed result to leave the spool", func() bool { return spooled(r) == 0 })
	r.noBadRequests()
}

// A successful live post leaves nothing behind, and an already-settled job
// (409) also clears the spool entry: neither is replayed forever.
func TestSpoolIsClearedAfterAcceptanceAndAfterAlreadySettled(t *testing.T) {
	r := newRig(t, nil)
	r.start(100 * time.Millisecond)
	r.fake.MarkSettled("job_dup")
	r.fake.Enqueue("job_ok|ok", "job_dup|ok")
	if _, ok := r.fake.WaitResult("job_ok", 10*time.Second); !ok {
		t.Fatal("no result for job_ok")
	}
	waitFor(t, 10*time.Second, "the spool to drain", func() bool { return spooled(r) == 0 })
}

// Heartbeats carry the lifecycle report the control plane shows to operators.
func TestHeartbeatCarriesLifecycleReport(t *testing.T) {
	r := newRig(t, nil)
	r.start(50 * time.Millisecond)
	waitFor(t, 10*time.Second, "a heartbeat", func() bool { return len(r.fake.Heartbeats()) > 0 })
	hb := r.fake.Heartbeats()[0]
	life, ok := hb["lifecycle"].(map[string]any)
	if !ok {
		t.Fatalf("heartbeat has no lifecycle report: %v", hb)
	}
	conn, _ := life["connection"].(map[string]any)
	if conn["state"] != agent.ConnOnline {
		t.Fatalf("unexpected connection report %v", conn)
	}
	if _, ok := life["spool"].(map[string]any); !ok {
		t.Fatalf("lifecycle has no spool report: %v", life)
	}
}

// Revocation is durable locally: a restarted agent does not take work, even
// before it reaches the control plane.
func TestRevocationIsDurableAndStopsRestartedAgent(t *testing.T) {
	r := newRig(t, nil)
	r.fake.RevokeViaPoll()
	r.start(100 * time.Millisecond)
	if code := r.waitExit(10 * time.Second); code != agent.ExitRevoked {
		t.Fatalf("expected exit %d, got %d", agent.ExitRevoked, code)
	}
	if !agent.IsRevokedLocally(r.cfg.StateDir, r.id.ID) {
		t.Fatal("the revocation must be persisted locally")
	}
	polls := r.fake.Polls()
	r.start(100 * time.Millisecond)
	if code := r.waitExit(10 * time.Second); code != agent.ExitRevoked {
		t.Fatalf("a restarted revoked agent must stop with exit %d, got %d", agent.ExitRevoked, code)
	}
	if r.fake.Polls() != polls {
		t.Fatal("a revoked agent must not poll for work after restart")
	}
	if _, err := os.Stat(filepath.Join(r.cfg.StateDir, "revoked.json")); err != nil {
		t.Fatal(err)
	}
}
