package machine_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/agent/fakecp"
	"github.com/GODOSTROYER/zenith/go/internal/machine"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

type recordingRunner struct {
	mu    sync.Mutex
	calls [][]string
}

func (r *recordingRunner) Run(_ context.Context, spec ops.CmdSpec) (ops.CmdResult, error) {
	r.mu.Lock()
	r.calls = append(r.calls, append([]string{spec.Path}, spec.Args...))
	r.mu.Unlock()
	return ops.CmdResult{Stdout: []byte("Id=nginx.service\nLoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\n")}, nil
}

func (r *recordingRunner) count() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.calls) }

type mrig struct {
	t       *testing.T
	fake    *fakecp.Server
	dir     string
	allowed string
	state   string
	cfgPath string
	runner  *recordingRunner
	getenv  func(string) string
}

func newMRig(t *testing.T) *mrig {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX paths")
	}
	fake := fakecp.New(t, "machines", protocol.MachineProtocol)
	base, _ := filepath.EvalSymlinks(t.TempDir())
	r := &mrig{t: t, fake: fake, dir: base, allowed: filepath.Join(base, "var-log"), state: filepath.Join(base, "var-log", "zenithd-state"), runner: &recordingRunner{}}
	r.getenv = func(string) string { return "" }
	for _, d := range []string{r.allowed, filepath.Join(base, "outside"), r.state} {
		_ = os.MkdirAll(d, 0o755)
	}
	cfg := fmt.Sprintf(`{
  "controlPlane": {"url": %q}, "tls": {"caFile": %q}, "stateDir": %q, "name": "vm-1", "pollWaitSec": 0, "shutdownGraceSec": 5,
  "services": {"restartAllow": ["nginx.service"]},
  "files": {"readAllow": [%q]}
}`, fake.URL, fake.CAFile(base), r.state, r.allowed)
	r.cfgPath = filepath.Join(base, "zenithd.json")
	if err := os.WriteFile(r.cfgPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *mrig) register() int {
	tokenFile := filepath.Join(r.dir, "token")
	_ = os.WriteFile(tokenFile, []byte(r.fake.Token), 0o600)
	var out, errb bytes.Buffer
	code := machine.Main([]string{"--config", r.cfgPath, "register", "--token-file", tokenFile}, &out, &errb, r.getenv)
	if strings.Contains(out.String()+errb.String(), r.fake.Token) {
		r.t.Fatal("the token must never be printed")
	}
	return code
}

func (r *mrig) start() (chan int, context.CancelFunc) {
	cfg, err := machine.LoadConfig(r.cfgPath, r.getenv)
	if err != nil {
		r.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	exit := make(chan int, 1)
	go func() {
		exit <- machine.Run(ctx, cfg, r.cfgPath, io.Discard, r.getenv, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard),
			machine.Deps{Runner: r.runner, HeartbeatEvery: 100 * time.Millisecond})
	}()
	r.t.Cleanup(cancel)
	return exit, cancel
}

func (r *mrig) req(spec protocoltest.MachineSpec) (string, string) {
	if spec.MachineID == "" {
		spec.MachineID = "mac_e2e"
	}
	if spec.WorkspaceID == "" {
		spec.WorkspaceID = "ws_e2e"
	}
	return r.fake.CP.Machine(spec)
}

func (r *mrig) wait(jti string) map[string]any {
	r.t.Helper()
	res, ok := r.fake.WaitResult(jti, 10*time.Second)
	if !ok {
		r.t.Fatalf("no result for %s", jti)
	}
	return res.Body
}

func readAudit(t *testing.T, path string) []map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("audit line is not JSON: %q", line)
		}
		out = append(out, m)
	}
	return out
}

func TestE2EMachineOperationsGuardsAndAudit(t *testing.T) {
	r := newMRig(t)
	if code := r.register(); code != 0 {
		t.Fatalf("register exit %d", code)
	}
	caps := fmt.Sprint(r.fake.Register["capabilities"])
	for _, want := range []string{"service.status", "machine.service.restart", "file.read", "network.portCheck", "system.logs"} {
		if !strings.Contains(caps, want) {
			t.Errorf("capabilities %s should contain %s", caps, want)
		}
	}
	for _, off := range []string{"machine.exec", "container.exec", "container.list", "file.write"} {
		if strings.Contains(caps, off) {
			t.Errorf("capabilities %s must not advertise %s", caps, off)
		}
	}

	secretFile := filepath.Join(r.allowed, "app.log")
	if err := os.WriteFile(secretFile, []byte("line one\nUNIQUE-FILE-CONTENT-MARKER-42\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(r.dir, "outside", "secret.txt"), []byte("top secret"), 0o644)
	_ = os.Symlink(filepath.Join(r.dir, "outside", "secret.txt"), filepath.Join(r.allowed, "escape"))
	_ = os.WriteFile(filepath.Join(r.state, "identity.json.copy"), []byte("x"), 0o644)

	exit, _ := r.start()

	// accepted operations
	okStatusID, tok := r.req(protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}})
	r.fake.Enqueue(tok)
	res := r.wait(okStatusID)
	result := res["result"].(map[string]any)
	if res["status"] != "succeeded" || result["ok"] != true || result["operation"] != "service.status" || result["data"].(map[string]any)["activeState"] != "active" {
		t.Fatalf("%v", res)
	}

	restartID, tok := r.req(protocoltest.MachineSpec{Operation: "machine.service.restart", Args: map[string]any{"unit": "nginx.service"}})
	r.fake.Enqueue(tok)
	res = r.wait(restartID)
	if res["status"] != "succeeded" || res["result"].(map[string]any)["data"].(map[string]any)["restarted"] != true {
		t.Fatalf("%v", res)
	}
	restarted := false
	for _, c := range r.runner.calls {
		if len(c) > 1 && c[1] == "restart" {
			restarted = true
		}
	}
	if !restarted {
		t.Fatal("systemctl restart was not run")
	}

	readID, tok := r.req(protocoltest.MachineSpec{Operation: "file.read", Args: map[string]any{"path": secretFile}})
	r.fake.Enqueue(tok)
	res = r.wait(readID)
	if res["status"] != "succeeded" || !strings.Contains(res["result"].(map[string]any)["data"].(map[string]any)["content"].(string), "UNIQUE-FILE-CONTENT-MARKER-42") {
		t.Fatalf("%v", res)
	}

	// rejections
	reject := func(name, code string, spec protocoltest.MachineSpec) string {
		t.Helper()
		jti, tok := r.req(spec)
		r.fake.Enqueue(tok)
		res := r.wait(jti)
		if res["status"] != "rejected" || !strings.Contains(res["error"].(string), code) {
			t.Fatalf("%s: want rejected/%s, got %v", name, code, res)
		}
		return jti
	}
	callsBefore := r.runner.count()
	reject("restart of a unit not in the allowlist", protocol.CodeNotAllowed, protocoltest.MachineSpec{Operation: "machine.service.restart", Args: map[string]any{"unit": "sshd.service"}})
	reject("symlink escape", protocol.CodeNotAllowed, protocoltest.MachineSpec{Operation: "file.read", Args: map[string]any{"path": filepath.Join(r.allowed, "escape")}})
	reject("outside the allowlist", protocol.CodeNotAllowed, protocoltest.MachineSpec{Operation: "file.read", Args: map[string]any{"path": "/etc/passwd"}})
	reject("zenithd's own state", protocol.CodeNotAllowed, protocoltest.MachineSpec{Operation: "file.read", Args: map[string]any{"path": filepath.Join(r.state, "identity.json.copy")}})
	reject("exec is off", protocol.CodeDisabledByConfig, protocoltest.MachineSpec{Operation: "machine.exec", Args: map[string]any{"argv": []string{"/bin/id"}}})
	reject("containers are off", protocol.CodeDisabledByConfig, protocoltest.MachineSpec{Operation: "container.list", Args: map[string]any{}})
	reject("file.write defaults off", protocol.CodeDisabledByConfig, protocoltest.MachineSpec{Operation: "file.write", Args: map[string]any{"path": "/opt/customer/settings.txt", "contentRef": "settings", "contentVersion": strings.Repeat("c", 64), "expectedSha256": nil}})
	reject("file.upload is not implemented", protocol.CodeUnsupportedOp, protocoltest.MachineSpec{Operation: "file.upload", Args: map[string]any{}})
	reject("package.install is not implemented", protocol.CodeUnsupportedOp, protocoltest.MachineSpec{Operation: "package.install", Args: map[string]any{}})
	reject("unknown operation", protocol.CodeUnsupportedOp, protocoltest.MachineSpec{Operation: "machine.format_disk", Args: map[string]any{}})
	reject("hostile unit", protocol.CodeInvalidPayload, protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "nginx.service; reboot"}})
	reject("option-like unit", protocol.CodeInvalidPayload, protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "--all.service"}})
	reject("grant for another operation", protocol.CodeGrantCapability, protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}, GrantCap: "machine.exec"})
	reject("grant for a runner", protocol.CodeGrantAudience, protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}, GrantAud: "runner:run_e2e"})
	reject("another machine", protocol.CodeWrongTarget, protocoltest.MachineSpec{MachineID: "mac_other", Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}})
	reject("metadata probe", protocol.CodeGuardDenied, protocoltest.MachineSpec{Operation: "network.portCheck", Args: map[string]any{"host": "169.254.169.254", "port": 80}})
	if d := r.runner.count() - callsBefore; d != 0 {
		t.Fatalf("no command may run for a rejected request; systemctl was called %d times", d)
	}

	// replay: one result, one execution
	replayID, rtok := r.req(protocoltest.MachineSpec{Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}})
	before := r.runner.count()
	r.fake.Enqueue(rtok, rtok)
	r.wait(replayID)
	time.Sleep(400 * time.Millisecond)
	if n := len(r.fake.ResultsFor(replayID)); n != 1 {
		t.Fatalf("a replayed request must be reported once, got %d results", n)
	}
	if d := r.runner.count() - before; d != 1 { // service.status makes exactly one systemctl call
		t.Fatalf("a replayed request must run once, systemctl was called %d times", d)
	}

	// the audit log
	auditPath := filepath.Join(r.state, "audit.jsonl")
	if runtime.GOOS != "windows" {
		st, err := os.Stat(auditPath)
		if err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("audit log must be 0600: %v %v", st, err)
		}
	}
	entries := readAudit(t, auditPath)
	byReq := map[string][]map[string]any{}
	for _, e := range entries {
		byReq[e["requestId"].(string)] = append(byReq[e["requestId"].(string)], e)
	}
	readEntries := byReq[readID]
	if len(readEntries) != 2 || readEntries[0]["phase"] != "start" || readEntries[1]["phase"] != "end" || readEntries[1]["outcome"] != "succeeded" {
		t.Fatalf("an accepted request is audited at start and end: %v", readEntries)
	}
	if readEntries[0]["grantJti"] == nil || readEntries[0]["operation"] != "file.read" || readEntries[0]["verified"] != true || readEntries[0]["target"].(map[string]any)["path"] != secretFile {
		t.Fatalf("%v", readEntries[0])
	}
	// the output digest matches the result that was posted, and no contents are in the audit log
	posted := r.wait(readID)["result"]
	raw, _ := json.Marshal(posted)
	sum := sha256.Sum256(raw)
	if readEntries[1]["outputSha256"] != hex.EncodeToString(sum[:]) || int(readEntries[1]["outputBytes"].(float64)) != len(raw) {
		t.Fatalf("output digest mismatch: %v vs %x", readEntries[1], sum)
	}
	auditRaw, _ := os.ReadFile(auditPath)
	if strings.Contains(string(auditRaw), "UNIQUE-FILE-CONTENT-MARKER-42") {
		t.Fatal("file contents must never be written to the audit log")
	}
	rejectedEntries := 0
	for _, e := range entries {
		if e["outcome"] == "rejected" {
			rejectedEntries++
			if e["reason"] == nil || e["requestId"] == "" {
				t.Fatalf("%v", e)
			}
		}
	}
	if rejectedEntries < 14 {
		t.Fatalf("every rejected request is audited, got %d", rejectedEntries)
	}
	if len(byReq[replayID]) < 3 { // start + end + the replay rejection
		t.Fatalf("the replayed delivery is audited too: %v", byReq[replayID])
	}

	// revocation
	r.fake.Revoke()
	select {
	case code := <-exit:
		if code != agent.ExitRevoked {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("zenithd did not stop after revocation")
	}
	if bad := r.fake.BadRequests(); len(bad) != 0 {
		t.Fatalf("the control plane rejected requests: %v", bad)
	}
}

func TestExecutorRefusesToRunWhenTheAuditLogIsNotWritable(t *testing.T) {
	r := newMRig(t)
	cfg, err := machine.LoadConfig(r.cfgPath, r.getenv)
	if err != nil {
		t.Fatal(err)
	}
	audit, err := machine.OpenAudit(filepath.Join(r.dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	cp := protocoltest.New("cp-x")
	keys := cp.KeySet()
	id := &agent.Identity{ID: "mac_e2e", WorkspaceID: "ws_e2e"}
	ex, err := machine.NewExecutor(cfg, id, keys, protocol.NewMemoryReplayCache(nil), audit, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), machine.Deps{Runner: r.runner})
	if err != nil {
		t.Fatal(err)
	}
	_ = audit.Close() // from now on Append fails
	_, tok := cp.Machine(protocoltest.MachineSpec{MachineID: "mac_e2e", WorkspaceID: "ws_e2e", Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}})
	job, rej := ex.Verify(context.Background(), tok)
	if job != nil || rej == nil || !strings.Contains(rej.Message, "audit_unavailable") {
		t.Fatalf("an operation whose start cannot be recorded must not run: %v %v", job, rej)
	}
	if r.runner.count() != 0 {
		t.Fatal("nothing may run")
	}
	if _, err := machine.NewExecutor(cfg, id, keys, protocol.NewMemoryReplayCache(nil), nil, agent.NewLogger(agent.LogConfig{}, io.Discard), machine.Deps{}); err == nil {
		t.Fatal("an executor without an audit log must not be constructible")
	}
}

func TestMachineGrantConstraints(t *testing.T) {
	r := newMRig(t)
	cfg, _ := machine.LoadConfig(r.cfgPath, r.getenv)
	audit, _ := machine.OpenAudit(filepath.Join(r.dir, "audit.jsonl"))
	defer audit.Close()
	cp := protocoltest.New("cp-x")
	id := &agent.Identity{ID: "mac_e2e", WorkspaceID: "ws_e2e"}
	mk := func(strict bool) *machine.Executor {
		c := *cfg
		c.RejectUnknownConstraints = strict
		ex, err := machine.NewExecutor(&c, id, cp.KeySet(), protocol.NewMemoryReplayCache(nil), audit, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), machine.Deps{Runner: r.runner})
		if err != nil {
			t.Fatal(err)
		}
		return ex
	}
	spec := protocoltest.MachineSpec{MachineID: "mac_e2e", WorkspaceID: "ws_e2e", Operation: "service.status", Args: map[string]any{"unit": "nginx.service"}}

	spec.Constraints = map[string]any{"maxReplicas": 3} // a planning-time constraint the control plane enforces
	_, tok := cp.Machine(spec)
	if job, rej := mk(false).Verify(context.Background(), tok); job == nil {
		t.Fatalf("unknown constraints are ignored by default: %v", rej)
	}
	_, tok = cp.Machine(spec)
	if _, rej := mk(true).Verify(context.Background(), tok); rej == nil || rej.Code != protocol.CodeConstraint {
		t.Fatalf("strict mode refuses constraints it cannot enforce: %v", rej)
	}
	spec.Constraints = map[string]any{"maxTimeoutSec": "soon"}
	_, tok = cp.Machine(spec)
	if _, rej := mk(false).Verify(context.Background(), tok); rej == nil || rej.Code != protocol.CodeConstraint {
		t.Fatalf("a malformed known constraint is refused: %v", rej)
	}
	spec.Constraints = map[string]any{"maxTimeoutSec": 5, "maxOutputBytes": 2048}
	_, tok = cp.Machine(spec)
	if job, rej := mk(false).Verify(context.Background(), tok); job == nil {
		t.Fatalf("%v", rej)
	}
}

func TestMachineCommandLine(t *testing.T) {
	r := newMRig(t)
	var out, errb bytes.Buffer
	if code := machine.Main([]string{"version"}, &out, &errb, r.getenv); code != 0 || !strings.Contains(out.String(), "zenithd") || !strings.Contains(out.String(), "zenith.machine/v1") {
		t.Fatalf("%d %s", code, out.String())
	}
	out.Reset()
	if code := machine.Main([]string{"--config", r.cfgPath, "check"}, &out, &errb, r.getenv); code != 0 || !strings.Contains(out.String(), "exec enabled: false") || !strings.Contains(out.String(), "containers enabled: false") {
		t.Fatalf("%d %s %s", code, out.String(), errb.String())
	}
	bad := filepath.Join(r.dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"controlPlane":{"url":"https://x.example.com"},"services":{"restartAllow":["nginx"]}}`), 0o600)
	if code := machine.Main([]string{"--config", bad, "check"}, io.Discard, &errb, r.getenv); code != agent.ExitUsage {
		t.Fatalf("%d", code)
	}
	bad2 := filepath.Join(r.dir, "bad2.json")
	_ = os.WriteFile(bad2, []byte(`{"controlPlane":{"url":"https://x.example.com"},"files":{"readAllow":["/"]}}`), 0o600)
	if code := machine.Main([]string{"--config", bad2, "check"}, io.Discard, &errb, r.getenv); code != agent.ExitUsage {
		t.Fatalf("a read allowlist of / must be refused: %d", code)
	}
}
