package ops_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

type fakeRunner struct {
	mu    sync.Mutex
	calls []ops.CmdSpec
	fn    func(spec ops.CmdSpec) (ops.CmdResult, error)
}

func (f *fakeRunner) Run(_ context.Context, spec ops.CmdSpec) (ops.CmdResult, error) {
	f.mu.Lock()
	f.calls = append(f.calls, spec)
	f.mu.Unlock()
	if f.fn != nil {
		return f.fn(spec)
	}
	return ops.CmdResult{}, nil
}

func (f *fakeRunner) last() ops.CmdSpec {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func (f *fakeRunner) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// prep validates and (if it passes) runs one operation.
func prep(t *testing.T, e *ops.Env, name string, args any) (ops.Runnable, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return e.Prepare(name, &ops.Request{JTI: "mreq_t", Args: raw, Timeout: 10 * time.Second, MaxOutputBytes: 64 << 10})
}

func runOp(t *testing.T, e *ops.Env, name string, args any) ops.Result {
	t.Helper()
	run, err := prep(t, e, name, args)
	if err != nil {
		t.Fatalf("prepare %s: %v", name, err)
	}
	res, err := run(context.Background())
	if err != nil {
		t.Fatalf("run %s: %v", name, err)
	}
	return res
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a %s rejection, got success", code)
	}
	if got := protocol.CodeOf(err); got != code {
		t.Fatalf("expected %s, got %s (%v)", code, got, err)
	}
}

func TestUnitNameValidation(t *testing.T) {
	good := []string{"nginx.service", "docker.socket", "logrotate.timer", "app@1.service", "user@1000.service", "my-app_v2.service", "a.b.c.service", "dbus-org.freedesktop.login1.service", "x:y.service", "A.service"}
	bad := []string{
		"", ".service", "nginx", "nginx.mount", "nginx.service.bak", "nginx .service", "nginx.service;id", "nginx.service\n", "$(id).service", "`id`.service", "a/b.service",
		"../etc.service", "-h.service", "--version.service", "--now.service", "-.service", "nginx.SERVICE", "néginx.service", strings.Repeat("a", 129) + ".service",
		"a|b.service", "a&b.service", "a b.service", "a*.service", "a\x00b.service",
	}
	for _, u := range good {
		if !ops.ValidUnit(u) {
			t.Errorf("%q should be valid", u)
		}
	}
	for _, u := range bad {
		if ops.ValidUnit(u) {
			t.Errorf("%q must be rejected", u)
		}
	}
	if !ops.ValidUnit(strings.Repeat("a", 128) + ".service") {
		t.Error("a 128-character base name is allowed")
	}
}

const showOutput = `Id=nginx.service
Description=A high performance web server
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
MainPID=1234
ExecMainStatus=0
Result=success
NRestarts=2
ActiveEnterTimestamp=Wed 2026-09-30 10:00:00 UTC
InactiveEnterTimestamp=
FragmentPath=/lib/systemd/system/nginx.service
MemoryCurrent=52428800
TasksCurrent=5
`

func TestServiceStatusUsesFixedArgvAndParsesOutput(t *testing.T) {
	fr := &fakeRunner{fn: func(ops.CmdSpec) (ops.CmdResult, error) { return ops.CmdResult{Stdout: []byte(showOutput)}, nil }}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{SystemctlPath: "/usr/bin/systemctl"}}
	res := runOp(t, e, ops.OpServiceStatus, map[string]any{"unit": "nginx.service"})
	spec := fr.last()
	if spec.Path != "/usr/bin/systemctl" {
		t.Fatalf("path %s", spec.Path)
	}
	wantArgs := []string{"show", "--no-pager", "--property=", "--", "nginx.service"}
	if len(spec.Args) != 5 || spec.Args[0] != wantArgs[0] || spec.Args[1] != wantArgs[1] || !strings.HasPrefix(spec.Args[2], "--property=Id,Description,LoadState,ActiveState") || spec.Args[3] != "--" || spec.Args[4] != "nginx.service" {
		t.Fatalf("argv: %q", spec.Args)
	}
	for _, e := range spec.Env {
		if strings.HasPrefix(e, "ZENITH") || strings.HasPrefix(e, "AWS_") {
			t.Fatalf("the child environment must be fixed: %v", spec.Env)
		}
	}
	d := res.Data
	if !res.OK || d["activeState"] != "active" || d["subState"] != "running" || d["mainPid"] != int64(1234) || d["restarts"] != int64(2) {
		t.Fatalf("%v", d)
	}
	if _, ok := d["inactiveEnterTimestamp"]; ok {
		t.Fatal("empty properties are omitted")
	}

	// systemd's "unset" sentinel and a not-found unit
	fr.fn = func(ops.CmdSpec) (ops.CmdResult, error) {
		return ops.CmdResult{Stdout: []byte("Id=ghost.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nMemoryCurrent=18446744073709551615\nMainPID=0\n")}, nil
	}
	res = runOp(t, e, ops.OpServiceStatus, map[string]any{"unit": "ghost.service"})
	if res.Data["loadState"] != "not-found" || res.Data["activeState"] != "inactive" {
		t.Fatalf("%v", res.Data)
	}
	if _, ok := res.Data["memoryCurrentBytes"]; ok {
		t.Fatal("the unset sentinel must not be reported as 16 EiB")
	}
}

func TestServiceStatusRejectsHostileUnitNamesBeforeRunningAnything(t *testing.T) {
	fr := &fakeRunner{}
	e := &ops.Env{Runner: fr}
	for _, u := range []string{"nginx.service; id", "$(reboot).service", "-h.service", "--now.service", "../x.service", "a b.service", "nginx", ""} {
		_, err := prep(t, e, ops.OpServiceStatus, map[string]any{"unit": u})
		wantCode(t, err, protocol.CodeInvalidPayload)
	}
	_, err := prep(t, e, ops.OpServiceStatus, map[string]any{"unit": "nginx.service", "extra": 1})
	wantCode(t, err, protocol.CodeInvalidPayload)
	_, err = e.Prepare(ops.OpServiceStatus, &ops.Request{Args: json.RawMessage(`[1]`)})
	wantCode(t, err, protocol.CodeInvalidPayload)
	if fr.count() != 0 {
		t.Fatal("nothing may run for a rejected request")
	}
}

func TestServiceRestartGuard(t *testing.T) {
	var restarts []string
	fr := &fakeRunner{fn: func(spec ops.CmdSpec) (ops.CmdResult, error) {
		if spec.Args[0] == "restart" {
			restarts = append(restarts, spec.Args[len(spec.Args)-1])
			return ops.CmdResult{}, nil
		}
		return ops.CmdResult{Stdout: []byte(showOutput)}, nil
	}}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{Services: ops.ServicesConfig{RestartAllow: []string{"nginx.service", "app@*.service"}}}}

	res := runOp(t, e, ops.OpServiceRestart, map[string]any{"unit": "nginx.service"})
	if !res.OK || res.Data["restarted"] != true || res.Data["activeState"] != "active" || len(restarts) != 1 {
		t.Fatalf("%+v", res)
	}
	var restartSpec ops.CmdSpec
	for _, c := range fr.calls {
		if c.Args[0] == "restart" {
			restartSpec = c
		}
	}
	if strings.Join(restartSpec.Args, " ") != "restart --no-pager -- nginx.service" {
		t.Fatalf("restart argv: %v", restartSpec.Args)
	}
	runOp(t, e, ops.OpServiceRestart, map[string]any{"unit": "app@7.service"}) // wildcard entry

	for _, u := range []string{"sshd.service", "nginx.socket", "app.service", "nginx.service.d.service", "xnginx.service", "app@.timer"} {
		_, err := prep(t, e, ops.OpServiceRestart, map[string]any{"unit": u})
		wantCode(t, err, protocol.CodeNotAllowed)
	}
	if len(restarts) != 2 {
		t.Fatalf("only allowed units may be restarted, got %v", restarts)
	}

	// empty allowlist: the operation is off entirely
	off := &ops.Env{Runner: fr}
	_, err := prep(t, off, ops.OpServiceRestart, map[string]any{"unit": "nginx.service"})
	wantCode(t, err, protocol.CodeDisabledByConfig)
	// validation still comes first for hostile names
	_, err = prep(t, e, ops.OpServiceRestart, map[string]any{"unit": "-h.service"})
	wantCode(t, err, protocol.CodeInvalidPayload)
}

func TestServiceRestartFailureIsReported(t *testing.T) {
	fr := &fakeRunner{fn: func(spec ops.CmdSpec) (ops.CmdResult, error) {
		if spec.Args[0] == "restart" {
			return ops.CmdResult{ExitCode: 1, Stderr: []byte("Job for nginx.service failed because the control process exited with error code. password=hunter2")}, nil
		}
		return ops.CmdResult{Stdout: []byte(showOutput)}, nil
	}}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{Services: ops.ServicesConfig{RestartAllow: []string{"nginx.service"}}}}
	run, _ := prep(t, e, ops.OpServiceRestart, map[string]any{"unit": "nginx.service"})
	res, err := run(context.Background())
	if err != nil || res.OK || !strings.HasPrefix(res.Err, "restart_failed") {
		t.Fatalf("%+v %v", res, err)
	}
	if strings.Contains(res.Data["reason"].(string), "hunter2") {
		t.Fatal("stderr must be redacted")
	}
	// a unit that does not exist is not restarted
	fr.fn = func(spec ops.CmdSpec) (ops.CmdResult, error) {
		return ops.CmdResult{Stdout: []byte("LoadState=not-found\nActiveState=inactive\n")}, nil
	}
	n := fr.count()
	run, _ = prep(t, e, ops.OpServiceRestart, map[string]any{"unit": "nginx.service"})
	res, _ = run(context.Background())
	if res.OK || !strings.Contains(res.Err, "unit_not_found") {
		t.Fatalf("%+v", res)
	}
	if fr.count() != n+1 {
		t.Fatal("no restart may be attempted for a missing unit")
	}
}

func TestSystemLogsArgvIsBuiltFromValidatedFieldsOnly(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	fr := &fakeRunner{fn: func(ops.CmdSpec) (ops.CmdResult, error) {
		return ops.CmdResult{Stdout: []byte("2026-09-30T11:59:00+0000 host nginx[1]: started\n2026-09-30T11:59:01+0000 host nginx[1]: token=abcdef1234567890SECRET accepted\n")}, nil
	}}
	e := &ops.Env{Runner: fr, Now: func() time.Time { return now }, Cfg: ops.Config{JournalctlPath: "/usr/bin/journalctl"}}
	res := runOp(t, e, ops.OpLogs, map[string]any{"unit": "nginx.service", "since": "15m", "lines": 50})
	got := strings.Join(fr.last().Args, "|")
	want := "--no-pager|--quiet|--utc|--output=short-iso|--lines=50|--unit=nginx.service|--since=2026-09-30 11:45:00 UTC"
	if got != want {
		t.Fatalf("argv\n got: %s\nwant: %s", got, want)
	}
	text := res.Data["content"].(string)
	if strings.Contains(text, "abcdef1234567890SECRET") || !strings.Contains(text, "REDACTED") || res.Data["lines"] != 2 {
		t.Fatalf("logs must be redacted: %v", res.Data)
	}

	for name, args := range map[string]map[string]any{
		"option injection via unit": {"unit": "a.service --all"},
		"flag as unit":              {"unit": "--help.service"},
		"free-text since":           {"since": "yesterday; id"},
		"command substitution":      {"since": "$(id)"},
		"since flag injection":      {"since": "--all"},
		"lines too many":            {"lines": 5001},
		"negative lines":            {"lines": -1},
		"bad priority":              {"priority": "9; id"},
		"unknown field":             {"grep": "x"},
		"relative overflow":         {"since": "8d"},
		"zero duration":             {"since": "0s"},
		"old duration format":       {"since": "-15m"},
		"absolute timestamp":        {"since": "2026-09-30T12:00:00Z"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := prep(t, e, ops.OpLogs, args)
			wantCode(t, err, protocol.CodeInvalidPayload)
		})
	}
}

func TestSystemLogsKeepsTheNewestLinesWithinTheByteBudget(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("line-" + strings.Repeat("x", 90) + "\n")
	}
	b.WriteString("the newest line\n")
	fr := &fakeRunner{fn: func(ops.CmdSpec) (ops.CmdResult, error) { return ops.CmdResult{Stdout: []byte(b.String())}, nil }}
	e := &ops.Env{Runner: fr}
	run, _ := e.Prepare(ops.OpLogs, &ops.Request{Args: json.RawMessage(`{}`), MaxOutputBytes: 1000})
	res, err := run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	text := res.Data["content"].(string)
	if len(text) > 1000 || !strings.HasSuffix(text, "the newest line") || res.Data["truncated"] != true {
		t.Fatalf("len=%d truncated=%v tail=%q", len(text), res.Data["truncated"], text[max(0, len(text)-30):])
	}
}

func TestUnsupportedAndUnknownOperationsAreRefused(t *testing.T) {
	e := &ops.Env{}
	for _, name := range []string{ops.OpFileWrite, ops.OpFileUpload, ops.OpPackageInstall, "machine.reboot", "", "service.status; id"} {
		_, err := e.Prepare(name, &ops.Request{Args: json.RawMessage(`{}`)})
		wantCode(t, err, protocol.CodeUnsupportedOp)
	}
}

func TestSupportedReflectsLocalGuards(t *testing.T) {
	has := func(list []string, s string) bool {
		for _, x := range list {
			if x == s {
				return true
			}
		}
		return false
	}
	def := ops.Supported(ops.Config{})
	for _, op := range []string{ops.OpInspect, ops.OpProcessList, ops.OpServiceStatus, ops.OpPortCheck, ops.OpDNSCheck, ops.OpMetrics, ops.OpLogs} {
		if !has(def, op) {
			t.Errorf("%s should be on by default", op)
		}
	}
	for _, op := range []string{ops.OpExec, ops.OpContainerExec, ops.OpContainerList, ops.OpContainerInspect, ops.OpContainerLogs, ops.OpServiceRestart, ops.OpFileRead, ops.OpFileWrite, ops.OpPackageInstall} {
		if has(def, op) {
			t.Errorf("%s must be off by default", op)
		}
	}
	full := ops.Supported(ops.Config{Exec: ops.ExecConfig{Enabled: true}, Containers: ops.ContainersConfig{Enabled: true}, Services: ops.ServicesConfig{RestartAllow: []string{"a.service"}}, Files: ops.FilesConfig{ReadAllow: []string{"/var/log"}}})
	for _, op := range []string{ops.OpExec, ops.OpContainerExec, ops.OpContainerList, ops.OpServiceRestart, ops.OpFileRead} {
		if !has(full, op) {
			t.Errorf("%s should be on when its guard is opened", op)
		}
	}
	if has(ops.Supported(ops.Config{Exec: ops.ExecConfig{Enabled: true}}), ops.OpContainerExec) {
		t.Error("container.exec needs containers.enabled as well")
	}
}

func TestConfigValidators(t *testing.T) {
	if err := ops.ValidateRestartPatterns([]string{"nginx.service", "app@*.service", "*.timer"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"nginx"}, {"-x.service"}, {"a b.service"}, {"a/b.service"}, {"*"}, {"a.service;id"}, {""}} {
		if err := ops.ValidateRestartPatterns(bad); err == nil {
			t.Errorf("%v must be rejected", bad)
		}
	}
	if err := ops.ValidateReadAllow([]string{"/var/log", "/etc/app/config.yaml"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"/"}, {"var/log"}, {"/var/log/"}, {"/var/../etc"}, {""}, {"/var//log"}} {
		if err := ops.ValidateReadAllow(bad); err == nil {
			t.Errorf("%v must be rejected", bad)
		}
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
