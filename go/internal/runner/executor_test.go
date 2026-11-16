package runner

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
	"github.com/GODOSTROYER/zenith/go/internal/runner/kinds"
)

func testExecutor(t *testing.T, mutate func(*Config)) (*Executor, *protocoltest.ControlPlane) {
	t.Helper()
	cfg := &Config{}
	cfg.ControlPlane.URL = "https://zenith.example.com"
	cfg.ApplyDefaults(t.TempDir())
	cfg.applyDefaults()
	cfg.Kinds.ProbeHTTP = &kinds.Toggle{}
	cfg.Kinds.ProbeTCP = &kinds.Toggle{}
	cfg.Probes.AllowLoopback = true
	if mutate != nil {
		mutate(cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cp := protocoltest.New("cp-x")
	id := &agent.Identity{ID: "run_x", WorkspaceID: "ws_x"}
	ex, err := NewExecutor(cfg, id, cp.KeySet(), protocol.NewMemoryReplayCache(nil), agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), Deps{})
	if err != nil {
		t.Fatal(err)
	}
	return ex, cp
}

func signedJob(cp *protocoltest.ControlPlane, mutate func(*protocoltest.JobSpec)) string {
	spec := protocoltest.JobSpec{RunnerID: "run_x", WorkspaceID: "ws_x", Capability: "network.portCheck", Kind: "probe.tcp", Payload: map[string]any{"host": "127.0.0.1", "port": 9}}
	if mutate != nil {
		mutate(&spec)
	}
	_, tok := cp.Job(spec)
	return tok
}

func TestLimitsClampTimeoutAndOutput(t *testing.T) {
	ex, cp := testExecutor(t, func(c *Config) {
		c.Limits.MaxTimeoutSec = 10
		c.Limits.DefaultTimeoutSec = 7
		c.Limits.MaxOutputBytes = 4096
		c.Limits.DefaultOutputBytes = 2048
	})
	var vj *protocol.VerifiedJob
	get := func(mutate func(*protocoltest.JobSpec)) (time.Duration, int64, error) {
		tok := signedJob(cp, mutate)
		var err error
		vj, err = ex.verifier.VerifyJob(tok, ex.self, nil)
		if err != nil {
			t.Fatal(err)
		}
		return ex.limits(&vj.Envelope, &vj.Grant)
	}
	if to, out, _ := get(func(s *protocoltest.JobSpec) { s.TimeoutSec = 9999; s.MaxOutputBytes = 1 << 30 }); to != 10*time.Second || out != 4096 {
		t.Fatalf("requested limits are clamped to the local maximum, got %s / %d", to, out)
	}
	if to, out, err := ex.limits(&protocol.JobEnvelope{}, &protocol.GrantClaims{}); err != nil || to != 7*time.Second || out != 2048 {
		t.Fatalf("a job that names no limits gets the configured defaults, got %s / %d / %v", to, out, err)
	}
	if to, _, _ := get(func(s *protocoltest.JobSpec) { s.TimeoutSec = 3 }); to != 3*time.Second {
		t.Fatalf("a smaller request is honored: %s", to)
	}
	// grant constraints tighten further
	if to, out, err := get(func(s *protocoltest.JobSpec) {
		s.TimeoutSec = 8
		s.MaxOutputBytes = 4000
		s.Constraints = map[string]any{"maxTimeoutSec": 2, "maxOutputBytes": 100}
	}); err != nil || to != 2*time.Second || out != 100 {
		t.Fatalf("%s / %d / %v", to, out, err)
	}
	// constraints never loosen
	if to, _, _ := get(func(s *protocoltest.JobSpec) { s.TimeoutSec = 3; s.Constraints = map[string]any{"maxTimeoutSec": 500} }); to != 3*time.Second {
		t.Fatalf("a constraint cannot raise the limit: %s", to)
	}
	for _, bad := range []map[string]any{{"maxTimeoutSec": "1"}, {"maxTimeoutSec": 0}, {"maxOutputBytes": -5}, {"maxOutputBytes": true}} {
		if _, _, err := get(func(s *protocoltest.JobSpec) { s.Constraints = bad }); protocol.CodeOf(err) != protocol.CodeConstraint {
			t.Errorf("%v must be refused as a malformed constraint, got %v", bad, err)
		}
	}
}

func TestUnknownConstraintsAreIgnoredUnlessStrict(t *testing.T) {
	spec := func(s *protocoltest.JobSpec) { s.Constraints = map[string]any{"maxReplicas": 3} }
	lax, cp := testExecutor(t, nil)
	if j, rej := lax.Verify(context.Background(), signedJob(cp, spec)); j == nil {
		t.Fatalf("%v", rej)
	}
	strict, cp2 := testExecutor(t, func(c *Config) { c.RejectUnknownConstraints = true })
	if _, rej := strict.Verify(context.Background(), signedJob(cp2, spec)); rej == nil || rej.Code != protocol.CodeConstraint {
		t.Fatalf("%v", rej)
	}
}

func TestJobTimeoutIsEnforcedAroundTheKind(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-block }))
	defer srv.Close()
	defer close(block)
	ex, cp := testExecutor(t, nil)
	tok := signedJob(cp, func(s *protocoltest.JobSpec) {
		s.Kind = "probe.http"
		s.Payload = map[string]any{"url": srv.URL, "timeoutMs": 60000}
		s.TimeoutSec = 1
	})
	j, rej := ex.Verify(context.Background(), tok)
	if rej != nil {
		t.Fatal(rej)
	}
	start := time.Now()
	res := j.Run(context.Background(), agent.DiscardSink{})
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("the 1 s job timeout was not applied: %s", d)
	}
	// the probe reports its own timeout as an observation; what matters is that it stopped
	if res.Status != agent.StatusSucceeded && res.Status != agent.StatusTimedOut {
		t.Fatalf("%+v", res)
	}
	if res.StartedAt == "" || res.FinishedAt == "" {
		t.Fatal("results carry timestamps")
	}
}

func TestReplayedJobIsNotReportedButAForgedIDIsNotTrusted(t *testing.T) {
	ex, cp := testExecutor(t, nil)
	tok := signedJob(cp, nil)
	if j, rej := ex.Verify(context.Background(), tok); j == nil {
		t.Fatal(rej)
	}
	_, rej := ex.Verify(context.Background(), tok)
	if rej == nil || rej.Code != protocol.CodeReplay || rej.ID != "" {
		t.Fatalf("a replay must not produce a second result: %+v", rej)
	}
	// an unverifiable token still gets its (untrusted but well-formed) id reported so the control plane is not left waiting
	evil := cp.Sign("zenith-job+jwt", map[string]any{"jti": "job_victim"})
	_, rej = ex.Verify(context.Background(), evil+"x")
	if rej == nil || rej.ID != "job_victim" || rej.Code != protocol.CodeBadSignature {
		t.Fatalf("%+v", rej)
	}
}

func TestCapabilitiesListEnabledKindsSorted(t *testing.T) {
	ex, _ := testExecutor(t, func(c *Config) { c.Kinds.ProbeDNS = &kinds.Toggle{} })
	got := ex.Capabilities()
	want := []string{"probe.dns", "probe.http", "probe.tcp"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("%v", got)
	}
}
