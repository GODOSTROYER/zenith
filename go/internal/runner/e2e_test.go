package runner_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/agent/fakecp"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
	"github.com/GODOSTROYER/zenith/go/internal/runner"
)

type e2e struct {
	t        *testing.T
	fake     *fakecp.Server
	dir      string
	cfgPath  string
	stateDir string
	port     int
	accepts  *atomic.Int32
	getenv   func(string) string
}

func newE2E(t *testing.T, extraKinds string) *e2e {
	t.Helper()
	fake := fakecp.New(t, "runners", protocol.RunnerProtocol)
	dir := t.TempDir()
	e := &e2e{t: t, fake: fake, dir: dir, stateDir: filepath.Join(dir, "state"), accepts: &atomic.Int32{}}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	e.port = l.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			e.accepts.Add(1)
			c.Close()
		}
	}()

	cfg := fmt.Sprintf(`{
  "controlPlane": {"url": %q},
  "tls": {"caFile": %q},
  "stateDir": %q,
  "name": "e2e-runner",
  "labels": {"region": "test-1"},
  "pollWaitSec": 0,
  "shutdownGraceSec": 5,
  "kinds": {"probe.tcp": {}, "probe.http": {}, "probe.dns": {"enabled": false}%s},
  "probes": {"allowLoopback": true}
}`, fake.URL, fake.CAFile(dir), e.stateDir, extraKinds)
	e.cfgPath = filepath.Join(dir, "config.json")
	if err := os.WriteFile(e.cfgPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	e.getenv = func(string) string { return "" }
	return e
}

func (e *e2e) register() (int, string, string) {
	tokenFile := filepath.Join(e.dir, "token")
	_ = os.WriteFile(tokenFile, []byte(e.fake.Token+"\n"), 0o600)
	var out, errb bytes.Buffer
	code := runner.Main([]string{"--config", e.cfgPath, "register", "--token-file", tokenFile}, &out, &errb, e.getenv)
	return code, out.String(), errb.String()
}

// start runs the runner in the background with fast heartbeats. stop cancels
// it (SIGTERM equivalent) and returns its exit code.
func (e *e2e) start() (stop func() int, exit chan int) {
	e.t.Helper()
	cfg, err := runner.LoadConfig(e.cfgPath, e.getenv)
	if err != nil {
		e.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	exit = make(chan int, 1)
	go func() {
		exit <- runner.Run(ctx, cfg, io.Discard, e.getenv, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), runner.Deps{HeartbeatEvery: 100 * time.Millisecond})
	}()
	stop = func() int {
		cancel()
		select {
		case code := <-exit:
			exit <- code
			return code
		case <-time.After(20 * time.Second):
			e.t.Fatal("runner did not stop")
			return -1
		}
	}
	e.t.Cleanup(cancel)
	return stop, exit
}

func (e *e2e) job(spec protocoltest.JobSpec) (string, string) {
	if spec.RunnerID == "" {
		spec.RunnerID = "run_e2e"
	}
	if spec.WorkspaceID == "" {
		spec.WorkspaceID = "ws_e2e"
	}
	if spec.Capability == "" {
		spec.Capability = "network.portCheck"
	}
	return e.fake.CP.Job(spec)
}

func (e *e2e) wait(jti string) map[string]any {
	e.t.Helper()
	res, ok := e.fake.WaitResult(jti, 10*time.Second)
	if !ok {
		e.t.Fatalf("no result for %s", jti)
	}
	return res.Body
}

func TestE2ERegisterPollExecuteResultRevoke(t *testing.T) {
	e := newE2E(t, "")

	code, out, errOut := e.register()
	if code != 0 {
		t.Fatalf("register exit %d: %s", code, errOut)
	}
	if strings.Contains(out+errOut, e.fake.Token) {
		t.Fatal("the registration token must never be printed")
	}
	id, err := agent.LoadIdentity(e.stateDir, agent.RunnerKind)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out+errOut, id.PrivateKey) {
		t.Fatal("the private key must never be printed")
	}
	caps := fmt.Sprint(e.fake.Register["capabilities"])
	if !strings.Contains(caps, "probe.tcp") || !strings.Contains(caps, "probe.http") || strings.Contains(caps, "probe.dns") {
		t.Fatalf("capabilities at registration: %s", caps)
	}
	if e.fake.Register["labels"].(map[string]any)["region"] != "test-1" {
		t.Fatalf("%v", e.fake.Register)
	}
	if code, _, _ := e.register(); code == 0 {
		t.Fatal("registering twice must fail")
	}

	stop, _ := e.start()

	// 1. a valid job: probe.tcp against the local listener
	okJTI, okTok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: map[string]any{"host": "127.0.0.1", "port": e.port, "timeoutMs": 2000}})
	e.fake.Enqueue(okTok)
	res := e.wait(okJTI)
	if res["status"] != "succeeded" {
		t.Fatalf("%v", res)
	}
	result := res["result"].(map[string]any)
	if result["ok"] != true || result["remoteAddr"] != "127.0.0.1" || int(result["port"].(float64)) != e.port {
		t.Fatalf("%v", result)
	}
	if e.accepts.Load() < 1 {
		t.Fatal("the probe never connected")
	}

	// 2. a closed port is an observation, not a failure
	cl, _ := net.Listen("tcp", "127.0.0.1:0")
	closedPort := cl.Addr().(*net.TCPAddr).Port
	cl.Close()
	cJTI, cTok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: map[string]any{"host": "127.0.0.1", "port": closedPort, "timeoutMs": 1000}})
	e.fake.Enqueue(cTok)
	res = e.wait(cJTI)
	if res["status"] != "succeeded" || res["result"].(map[string]any)["ok"] != false || res["result"].(map[string]any)["errorCode"] != "connection_refused" {
		t.Fatalf("%v", res)
	}

	// 3. rejections, each reported with its reason
	tcp := map[string]any{"host": "127.0.0.1", "port": e.port}
	reject := func(name, code, jti, tok string) {
		t.Helper()
		e.fake.Enqueue(tok)
		res := e.wait(jti)
		if res["status"] != "rejected" || !strings.Contains(res["error"].(string), code) {
			t.Fatalf("%s: want rejected/%s, got %v", name, code, res)
		}
		if res["result"].(map[string]any)["reason"] != code {
			t.Fatalf("%s: %v", name, res)
		}
	}
	rejectSpec := func(name, code string, spec protocoltest.JobSpec) {
		t.Helper()
		jti, tok := e.job(spec)
		reject(name, code, jti, tok)
	}
	rejectSpec("another runner", protocol.CodeWrongTarget, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, RunnerID: "run_other"})
	rejectSpec("another workspace", protocol.CodeWrongTarget, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, WorkspaceID: "ws_other"})
	rejectSpec("grant for another capability", protocol.CodeGrantCapability, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, GrantCap: "infrastructure.apply"})
	rejectSpec("grant for another runner", protocol.CodeGrantAudience, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, GrantAud: "runner:run_other"})
	rejectSpec("missing grant", protocol.CodeGrantInvalid, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, OmitGrant: true})
	rejectSpec("expired", protocol.CodeExpired, protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp, IAT: time.Now().Add(-10 * time.Minute), EXP: time.Now().Add(-5 * time.Minute)})
	rejectSpec("disabled kind", protocol.CodeKindDisabled, protocoltest.JobSpec{Kind: "probe.dns", Payload: map[string]any{"name": "example.com"}})
	rejectSpec("unconfigured kind", protocol.CodeKindDisabled, protocoltest.JobSpec{Kind: "aws.http", Capability: "infrastructure.observe", Payload: map[string]any{}})
	rejectSpec("unknown kind", protocol.CodeKindDisabled, protocoltest.JobSpec{Kind: "shell.exec", Payload: map[string]any{"cmd": "id"}})
	rejectSpec("metadata IP", protocol.CodeGuardDenied, protocoltest.JobSpec{Kind: "probe.tcp", Payload: map[string]any{"host": "169.254.169.254", "port": 80}})
	rejectSpec("metadata host over http", protocol.CodeGuardDenied, protocoltest.JobSpec{Kind: "probe.http", Payload: map[string]any{"url": "http://metadata.google.internal/computeMetadata/v1/"}})
	rejectSpec("unknown payload field", protocol.CodeInvalidPayload, protocoltest.JobSpec{Kind: "probe.tcp", Payload: map[string]any{"host": "127.0.0.1", "port": e.port, "shell": "id"}})

	// a tampered signature, and a token signed by an unpinned key
	tjti, ttok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp})
	flipped := []byte(ttok)
	if flipped[len(flipped)-2] == 'A' {
		flipped[len(flipped)-2] = 'B'
	} else {
		flipped[len(flipped)-2] = 'A'
	}
	reject("tampered signature", protocol.CodeBadSignature, tjti, string(flipped))
	impostor := protocoltest.New("cp-impostor")
	ijti, itok := impostor.Job(protocoltest.JobSpec{RunnerID: "run_e2e", WorkspaceID: "ws_e2e", Capability: "network.portCheck", Kind: "probe.tcp", Payload: tcp})
	reject("unpinned key", protocol.CodeUnknownKey, ijti, itok)

	// 4. replay: a job delivered twice runs once and is reported once
	before := e.accepts.Load()
	rjti, rtok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp})
	e.fake.Enqueue(rtok, rtok)
	e.wait(rjti)
	time.Sleep(400 * time.Millisecond)
	if n := len(e.fake.ResultsFor(rjti)); n != 1 {
		t.Fatalf("a replayed job must be reported once, got %d results", n)
	}
	if d := e.accepts.Load() - before; d != 1 {
		t.Fatalf("a replayed job must run once, the probe connected %d times", d)
	}

	// 5. the replay cache survives a restart
	if code := stop(); code != agent.ExitOK {
		t.Fatalf("graceful stop exit %d", code)
	}
	before = e.accepts.Load()
	_, exit2 := e.start()
	e.fake.Enqueue(rtok)
	fjti, ftok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: tcp})
	e.fake.Enqueue(ftok)
	e.wait(fjti)
	if d := e.accepts.Load() - before; d != 1 {
		t.Fatalf("after a restart only the fresh job may run; probe connections: %d", d)
	}
	if n := len(e.fake.ResultsFor(rjti)); n != 1 {
		t.Fatalf("results for the replayed job: %d", n)
	}

	// 6. revocation: the next heartbeat stops the runner with exit code 3
	e.fake.Revoke()
	select {
	case code := <-exit2:
		if code != agent.ExitRevoked {
			t.Fatalf("exit code %d, want %d", code, agent.ExitRevoked)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the runner did not stop after revocation")
	}
	if bad := e.fake.BadRequests(); len(bad) != 0 {
		t.Fatalf("the control plane rejected requests: %v", bad)
	}
}

func TestE2EFirstRunRegistersFromEnvironmentToken(t *testing.T) {
	e := newE2E(t, "")
	e.getenv = func(k string) string {
		if k == "ZENITH_REGISTRATION_TOKEN" {
			return e.fake.Token
		}
		return ""
	}
	_, exit := e.start()
	jti, tok := e.job(protocoltest.JobSpec{Kind: "probe.tcp", Payload: map[string]any{"host": "127.0.0.1", "port": e.port}})
	deadline := time.Now().Add(10 * time.Second)
	for e.fake.Polls() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	e.fake.Enqueue(tok)
	if res := e.wait(jti); res["status"] != "succeeded" {
		t.Fatalf("%v", res)
	}
	if _, err := os.Stat(filepath.Join(e.stateDir, agent.IdentityFileName)); err != nil {
		t.Fatal(err)
	}
	e.fake.Revoke()
	if code := <-exit; code != agent.ExitRevoked {
		t.Fatalf("exit %d", code)
	}
}

func TestE2ERunRefusesToStartUnregistered(t *testing.T) {
	e := newE2E(t, "")
	_, exit := e.start()
	select {
	case code := <-exit:
		if code == agent.ExitOK {
			t.Fatal("an unregistered runner with no token must fail")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the runner should exit immediately when it cannot register")
	}
}

func TestCommandLine(t *testing.T) {
	e := newE2E(t, "")
	var out, errb bytes.Buffer
	if code := runner.Main([]string{"version"}, &out, &errb, e.getenv); code != 0 || !strings.Contains(out.String(), "zenith-runner") || !strings.Contains(out.String(), "zenith.runner/v1") {
		t.Fatalf("%d %s %s", code, out.String(), errb.String())
	}
	out.Reset()
	if code := runner.Main([]string{"--config", e.cfgPath, "check"}, &out, &errb, e.getenv); code != 0 || !strings.Contains(out.String(), "probe.http, probe.tcp") || strings.Contains(out.String(), "probe.dns") {
		t.Fatalf("%d %s %s", code, out.String(), errb.String())
	}
	for _, args := range [][]string{{"bogus"}, {"--nope"}, {"run", "extra"}, {"register"}} {
		if code := runner.Main(append([]string{"--config", e.cfgPath}, args...), io.Discard, io.Discard, e.getenv); code == 0 {
			t.Errorf("%v must fail", args)
		}
	}
	// an enabled kind with a broken allowlist is caught at startup by check
	bad := newE2E(t, `, "aws.http": {"allow": {"infrastructure.observe": ["*:*"]}}`)
	errb.Reset()
	if code := runner.Main([]string{"--config", bad.cfgPath, "check"}, io.Discard, &errb, e.getenv); code == 0 || !strings.Contains(errb.String(), "allow") {
		t.Fatalf("%d %s", code, errb.String())
	}
	// no kinds enabled is a configuration error
	none := filepath.Join(t.TempDir(), "c.json")
	_ = os.WriteFile(none, []byte(fmt.Sprintf(`{"controlPlane":{"url":%q},"stateDir":%q}`, e.fake.URL, t.TempDir())), 0o600)
	if code := runner.Main([]string{"--config", none, "check"}, io.Discard, &errb, e.getenv); code != agent.ExitUsage {
		t.Fatalf("%d", code)
	}
}
