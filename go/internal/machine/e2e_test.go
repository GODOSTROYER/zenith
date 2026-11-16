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
	for _, off := range []string{"machine.exec", "container.exec", "container.list", "file.write", "file.upload"} {
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
	reject("file.upload defaults off", protocol.CodeDisabledByConfig, protocoltest.MachineSpec{Operation: "file.upload", Args: map[string]any{}})
	reject("package.install is not implemented", protocol.CodeDisabledByConfig, protocoltest.MachineSpec{Operation: "package.install", Args: map[string]any{}})
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

// Linux requires the same unprivileged persistent fixture admission as the
// existing file.write native suite. Other hosts prove only default refusal.
// The control plane is modeled, but its signatures, daemon, replay, audit and
// registered upload filesystem path are real.
func TestE2ESignedUploadNativeCustodyAndGrantRefusal(t *testing.T) {
	runSignedUploadFixture(t, false)
}

func TestE2ESignedUploadResultGolden(t *testing.T) {
	runSignedUploadFixture(t, true)
}

func runSignedUploadFixture(t *testing.T, golden bool) {
	t.Helper()
	if runtime.GOOS != "linux" {
		if golden && os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1" {
			t.Fatal("upload golden generation requires actual unprivileged Linux")
		}
		for _, op := range ops.Supported(ops.Config{FileUpload: ops.FileUploadConfig{Enabled: true}}) {
			if op == ops.OpFileUpload {
				t.Fatal("non-Linux host advertised a native upload writer")
			}
		}
		return
	}
	if os.Geteuid() == 0 {
		t.Fatal("required signed Linux upload must run as an unprivileged user")
	}
	var base string
	var err error
	if golden {
		base = "/opt/zenith-file-upload-golden"
		info, statErr := os.Lstat(base)
		entries, readErr := os.ReadDir(base)
		if statErr != nil || readErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 || len(entries) != 0 {
			t.Fatal("provision an empty private unprivileged-owned fixed upload golden root")
		}
		t.Cleanup(func() {
			for _, dir := range []string{"app", "sources", "backups"} {
				_ = os.RemoveAll(filepath.Join(base, dir))
			}
		})
	} else {
		root := os.Getenv("ZENITH_FILE_WRITE_TEST_ROOT")
		if root == "" {
			root, err = os.UserHomeDir()
			if err != nil {
				t.Fatal(err)
			}
		}
		base, err = os.MkdirTemp(root, "upload-signed-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(base) })
	}
	for _, dir := range []string{"app", "sources", "backups"} {
		if err := os.Mkdir(filepath.Join(base, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	desired := []byte{0x00, 0xff, 0x80, 0x01, 0x0a, 0x00, 0xfe, 0x7f}
	source := filepath.Join(base, "sources", "model.bin")
	target := filepath.Join(base, "app", "model.bin")
	if err := os.WriteFile(source, desired, 0400); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(desired)
	profile := ops.FileUploadProfile{Path: target, SourceRef: "model", SourcePath: source, SHA256: hex.EncodeToString(sum[:]), Mode: "0600", MaxBytes: 1024}
	upload := ops.FileUploadConfig{Enabled: true, BackupDir: filepath.Join(base, "backups"), MaxBackupBytes: 32768, MaxBackups: 32}
	profile.SourceVersion, err = ops.FileUploadProfileVersion(upload, profile)
	if err != nil {
		t.Fatal(err)
	}
	upload.Profiles = []ops.FileUploadProfile{profile}
	r := newMRig(t)
	cfgRaw, err := os.ReadFile(r.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if json.Unmarshal(cfgRaw, &cfg) != nil {
		t.Fatal("invalid existing daemon fixture")
	}
	cfg["fileUpload"] = upload
	cfgRaw, err = json.Marshal(cfg)
	if err != nil || os.WriteFile(r.cfgPath, cfgRaw, 0600) != nil {
		t.Fatal("could not configure owned upload fixture")
	}
	if r.register() != 0 || !strings.Contains(fmt.Sprint(r.fake.Register["capabilities"]), ops.OpFileUpload) {
		t.Fatal("native upload was not advertised after genuine registration")
	}
	exit, cancel := r.start()
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			cancel()
			select {
			case code := <-exit:
				if code != agent.ExitOK {
					t.Error("owned upload daemon did not drain cleanly")
				}
			case <-time.After(10 * time.Second):
				t.Error("owned upload daemon did not stop")
			}
		})
	}
	t.Cleanup(stop)
	sequence := 0
	signed := func(args map[string]any, mutate func(*protocol.GrantClaims)) (string, string) {
		t.Helper()
		sequence++
		now := r.fake.CP.Now()
		jti, operationID := fmt.Sprintf("upload_request_%d", sequence), fmt.Sprintf("upload_operation_%d", sequence)
		grant := protocol.GrantClaims{JTI: fmt.Sprintf("upload_grant_%d", sequence), ISS: "zenith-control-plane", AUD: "machine:mac_e2e", SUB: "user_test", IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), CAP: ops.OpFileUpload, OP: operationID, Digest: "sha256:test", WS: "ws_e2e", Res: "resource:model", Constraints: map[string]any{"pathPrefixes": []any{filepath.Dir(target)}, "maxOutputBytes": 4096}}
		if mutate != nil {
			mutate(&grant)
		}
		raw, err := json.Marshal(args)
		if err != nil {
			t.Fatal(err)
		}
		envelope := protocol.MachineEnvelope{Protocol: protocol.MachineProtocol, JTI: jti, MachineID: "mac_e2e", WorkspaceID: "ws_e2e", OperationID: operationID, Operation: ops.OpFileUpload, Args: raw, Grant: r.fake.CP.Sign(protocol.TypGrant, grant), IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), TimeoutSec: 30, MaxOutputBytes: 4096}
		return jti, r.fake.CP.Sign(protocol.TypMachine, envelope)
	}
	args := func(prior any) map[string]any {
		return map[string]any{"path": target, "sourceRef": profile.SourceRef, "sourceVersion": profile.SourceVersion, "expectedSha256": prior}
	}
	checkBytes := func(want []byte) {
		t.Helper()
		got, err := os.ReadFile(target)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatal("native signed upload bytes differ")
		}
	}
	checkSuccess := func(jti string, created bool) map[string]any {
		t.Helper()
		body := r.wait(jti)
		result, ok := body["result"].(map[string]any)
		if !ok || body["status"] != "succeeded" || result["ok"] != true || result["operation"] != ops.OpFileUpload || result["output"] != nil {
			t.Fatal("native signed upload did not succeed")
		}
		data, ok := result["data"].(map[string]any)
		if !ok || data["created"] != created || data["sourceVersion"] != profile.SourceVersion || data["postcondition"] != "verified" || data["effect"] != "committed" || data["transactionRef"] == nil || data["sourcePath"] != nil || data["bytes"] != nil {
			t.Fatal("native signed upload receipt is inconsistent")
		}
		return data
	}
	createdID, token := signed(args(nil), nil)
	r.fake.Enqueue(token)
	created := checkSuccess(createdID, true)
	if created["backupRef"] != nil {
		t.Fatal("absent target claimed a prior backup")
	}
	checkBytes(desired)
	for _, fault := range []struct {
		name, code string
		mutate     func(*protocol.GrantClaims)
		inline     bool
	}{
		{"foreign audience", protocol.CodeGrantAudience, func(g *protocol.GrantClaims) { g.AUD = "machine:other" }, false},
		{"foreign capability", protocol.CodeGrantCapability, func(g *protocol.GrantClaims) { g.CAP = ops.OpFileWrite }, false},
		{"foreign operation", protocol.CodeGrantOperation, func(g *protocol.GrantClaims) { g.OP = "operation_other" }, false},
		{"foreign workspace", protocol.CodeGrantWorkspace, func(g *protocol.GrantClaims) { g.WS = "workspace_other" }, false},
		{"missing resource", protocol.CodeConstraint, func(g *protocol.GrantClaims) { g.Res = "" }, false},
		{"foreign path constraint", protocol.CodeConstraint, func(g *protocol.GrantClaims) { g.Constraints["pathPrefixes"] = []any{filepath.Join(base, "outside")} }, false},
		{"inline bytes", protocol.CodeInvalidPayload, nil, true},
	} {
		t.Run(fault.name, func(t *testing.T) {
			before, err := os.ReadDir(upload.BackupDir)
			if err != nil {
				t.Fatal(err)
			}
			input := args(profile.SHA256)
			if fault.inline {
				input["bytes"] = "forbidden-inline-upload"
			}
			jti, token := signed(input, fault.mutate)
			r.fake.Enqueue(token)
			body := r.wait(jti)
			if body["status"] != "rejected" || !strings.Contains(fmt.Sprint(body["error"]), fault.code) {
				t.Fatal("signed hostile upload grant or input was accepted")
			}
			after, err := os.ReadDir(upload.BackupDir)
			if err != nil || len(after) != len(before) {
				t.Fatal("rejected signed upload changed custody")
			}
			checkBytes(desired)
			for _, entry := range readAudit(t, filepath.Join(r.state, "audit.jsonl")) {
				if entry["requestId"] == jti && entry["phase"] == "start" {
					t.Fatal("rejected upload entered the native operation")
				}
			}
		})
	}
	prior := []byte{0x00, 0x7e, 0x80, 0xff}
	if err := os.WriteFile(target, prior, 0600); err != nil {
		t.Fatal(err)
	}
	priorSum := sha256.Sum256(prior)
	replacedID, token := signed(args(hex.EncodeToString(priorSum[:])), nil)
	r.fake.Enqueue(token)
	replaced := checkSuccess(replacedID, false)
	ref, ok := replaced["backupRef"].(string)
	if !ok || !strings.HasPrefix(ref, "fw_") {
		t.Fatal("replace lost opaque backup custody")
	}
	backup, err := os.ReadFile(filepath.Join(upload.BackupDir, ref+".data"))
	if err != nil || !bytes.Equal(backup, prior) {
		t.Fatal("signed replacement did not retain exact prior bytes")
	}
	checkBytes(desired)
	before, err := os.ReadDir(upload.BackupDir)
	if err != nil {
		t.Fatal(err)
	}
	r.fake.Enqueue(token)
	time.Sleep(400 * time.Millisecond)
	if len(r.fake.ResultsFor(replacedID)) != 1 {
		t.Fatal("signed replay produced another result")
	}
	after, err := os.ReadDir(upload.BackupDir)
	if err != nil || len(after) != len(before) {
		t.Fatal("signed replay created additional custody")
	}
	checkBytes(desired)
	entries := readAudit(t, filepath.Join(r.state, "audit.jsonl"))
	starts, ends := 0, 0
	for _, entry := range entries {
		if entry["requestId"] == replacedID {
			if entry["phase"] == "start" {
				starts++
			}
			if entry["phase"] == "end" {
				ends++
			}
		}
	}
	if starts != 1 || ends != 1 || r.runner.count() != 0 {
		t.Fatal("native signed upload replayed or used raw execution")
	}
	stop()
	if bad := r.fake.BadRequests(); len(bad) != 0 {
		t.Fatal("owned upload protocol result was refused")
	}
	if t.Failed() {
		return
	}
	if golden {
		ref, ok := created["transactionRef"].(string)
		if !ok || len(ref) != 35 || !strings.HasPrefix(ref, "fw_") || strings.Trim(ref[3:], "0123456789abcdef") != "" {
			t.Fatal("upload golden has no authentic opaque transaction")
		}
		intentPath := filepath.Join(upload.BackupDir, ref+".json")
		info, err := os.Lstat(intentPath)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			t.Fatal("upload golden lost private intent custody")
		}
		raw, err := os.ReadFile(intentPath)
		var intent map[string]any
		if err != nil || json.Unmarshal(raw, &intent) != nil || intent["operation"] != ops.OpFileUpload || intent["path"] != target || intent["sourceRef"] != profile.SourceRef || intent["sourceVersion"] != profile.SourceVersion || intent["desiredSha256"] != profile.SHA256 || intent["priorSha256"] != nil || intent["created"] != true || intent["state"] != "commit-may-have-run" {
			t.Fatal("upload golden intent does not bind actual signed create")
		}
		normalized := make(map[string]any, len(created))
		for key, value := range created {
			normalized[key] = value
		}
		// Only the verified opaque random transaction reference is normalized.
		// Target/profile/version/byte counts and all actual result fields stay exact.
		normalized["transactionRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		value := map[string]any{"operation": ops.OpFileUpload, "args": args(nil), "result": map[string]any{"ok": true, "data": normalized}}
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			t.Fatal("could not encode actual upload result")
		}
		encoded = append(encoded, '\n')
		goldenPath := filepath.Join("testdata", "results", "file.upload.json")
		if os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1" {
			if err := os.WriteFile(goldenPath, encoded, 0644); err != nil {
				t.Fatal("could not retain actual upload golden")
			}
		}
		expected, err := os.ReadFile(goldenPath)
		if err != nil || !bytes.Equal(expected, encoded) {
			t.Fatal("actual signed upload golden is missing or differs")
		}
	}
}

// Existing TLS/fake CP issuer, actual unprivileged daemon and signed verifier;
// helper absence must refuse even when a decoded local enabled flag is supplied.
func TestE2ESignedPackageHelperAbsentNeverDispatchesRunner(t *testing.T) {
	r := newMRig(t)
	p := ops.PackageInstallProfile{ProfileRef: "missing-helper-model", Package: "zenith-no-helper-profile", Version: "1.0", Architecture: runtime.GOARCH, SourcePath: "/var/lib/zenithd-package-install/archives/missing-helper-model.deb", SHA256: strings.Repeat("a", 64), ArchiveBytes: 1, Payload: []ops.PackagePayloadFile{{Path: "/opt/zenith-packages/missing-helper-model", Kind: "directory", Mode: "0755"}}}
	if p.Architecture != "amd64" && p.Architecture != "arm64" {
		t.Skip("supported native architectures")
	}
	version, e := ops.PackageInstallProfileVersion(p)
	if e != nil {
		t.Fatal(e)
	}
	p.ProfileVersion = version
	cfgRaw, e := os.ReadFile(r.cfgPath)
	if e != nil {
		t.Fatal(e)
	}
	var cfg map[string]any
	if json.Unmarshal(cfgRaw, &cfg) != nil {
		t.Fatal("existing fixture config invalid")
	}
	cfg["packageInstall"] = ops.PackageInstallConfig{Enabled: true, Profiles: []ops.PackageInstallProfile{p}}
	cfgRaw, e = json.Marshal(cfg)
	if e != nil || os.WriteFile(r.cfgPath, cfgRaw, 0600) != nil {
		t.Fatal("local enabled-profile fixture unavailable")
	}
	if r.register() != agent.ExitOK {
		t.Fatal("registration failed")
	}
	if strings.Contains(fmt.Sprint(r.fake.Register["capabilities"]), ops.OpPackageInstall) {
		t.Fatal("enabled metadata advertised a missing/mismatched helper")
	}
	exit, cancel := r.start()
	defer cancel()
	now := time.Now()
	jti := "mreq_package_helper_absent"
	operation := "op_package_helper_absent"
	grant := r.fake.CP.Sign(protocol.TypGrant, protocol.GrantClaims{JTI: "grt_package_helper_absent", ISS: "zenith-control-plane", AUD: "machine:mac_e2e", SUB: "user_fixture", IAT: now.Unix(), EXP: now.Add(time.Minute).Unix(), CAP: ops.OpPackageInstall, OP: operation, Digest: "modeled-cp-approval", WS: "ws_e2e", Res: "resource_e2e"})
	argsRaw, _ := json.Marshal(ops.PackageInstallArgs{ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion})
	token := r.fake.CP.Sign(protocol.TypMachine, protocol.MachineEnvelope{Protocol: protocol.MachineProtocol, JTI: jti, MachineID: "mac_e2e", WorkspaceID: "ws_e2e", OperationID: operation, Operation: ops.OpPackageInstall, Args: argsRaw, Grant: grant, IAT: now.Unix(), EXP: now.Add(time.Minute).Unix(), TimeoutSec: 30, MaxOutputBytes: 4096})
	r.fake.Enqueue(token)
	body := r.wait(jti)
	if body["status"] != agent.StatusRejected || r.runner.count() != 0 {
		t.Fatal("missing root helper reached a runner")
	}
	cancel()
	select {
	case <-exit:
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not drain")
	}
	if bad := r.fake.BadRequests(); len(bad) != 0 {
		t.Fatal("modeled CP rejected the owned signed refusal")
	}
}
