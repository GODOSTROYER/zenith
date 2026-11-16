package ops_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

func TestMachineExecIsDisabledByDefault(t *testing.T) {
	fr := &fakeRunner{}
	e := &ops.Env{Runner: fr}
	_, err := prep(t, e, ops.OpExec, map[string]any{"argv": []string{"/bin/echo", "hi"}})
	wantCode(t, err, protocol.CodeDisabledByConfig)
	_, err = prep(t, &ops.Env{Runner: fr, Cfg: ops.Config{Exec: ops.ExecConfig{Enabled: false}, Containers: ops.ContainersConfig{Enabled: true}}}, ops.OpContainerExec, map[string]any{"container": "web", "argv": []string{"ls"}})
	wantCode(t, err, protocol.CodeDisabledByConfig)
	if fr.count() != 0 {
		t.Fatal("nothing may run")
	}
}

func TestMachineExecPassesArgvWithoutAShell(t *testing.T) {
	fr := &fakeRunner{fn: func(spec ops.CmdSpec) (ops.CmdResult, error) {
		return ops.CmdResult{Stdout: []byte("hi token=abcdef1234567890SECRETVALUE\n"), ExitCode: 0}, nil
	}}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{Exec: ops.ExecConfig{Enabled: true}}}
	hostile := []string{"/bin/echo", "$(id)", ";", "&&", "`reboot`", "a b", "*", "$HOME", "> /etc/passwd", "--help", "-rf"}
	res := runOp(t, e, ops.OpExec, map[string]any{"argv": hostile})
	spec := fr.last()
	if spec.Path != "/bin/echo" || strings.Join(spec.Args, "\x00") != strings.Join(hostile[1:], "\x00") {
		t.Fatalf("argv must reach the program untouched: path=%s args=%q", spec.Path, spec.Args)
	}
	if strings.Contains(spec.Path, "sh") && !strings.Contains(spec.Path, "echo") {
		t.Fatal("no shell may be involved")
	}
	for _, env := range spec.Env {
		if strings.HasPrefix(env, "ZENITH") || strings.HasPrefix(env, "AWS_") || strings.HasPrefix(env, "SECRET") {
			t.Fatalf("exec must get a fixed environment: %v", spec.Env)
		}
	}
	if !res.OK || res.Output == nil || *res.Output.ExitCode != 0 || strings.Contains(res.Output.Stdout, "abcdef1234567890SECRETVALUE") {
		t.Fatalf("%+v", res)
	}
}

func TestMachineExecNonZeroExitIsAnObservation(t *testing.T) {
	fr := &fakeRunner{fn: func(ops.CmdSpec) (ops.CmdResult, error) {
		return ops.CmdResult{ExitCode: 3, Stderr: []byte("nope"), StderrTrunc: true}, nil
	}}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{Exec: ops.ExecConfig{Enabled: true}}}
	res := runOp(t, e, ops.OpExec, map[string]any{"argv": []string{"/bin/false"}})
	if res.OK || *res.Output.ExitCode != 3 || res.Output.Stderr != "nope" || !res.Output.Truncated || res.Data["error"] != "command_failed" || res.Data["exitCode"] != 3 {
		t.Fatalf("%+v", res)
	}
}

func TestMachineExecValidation(t *testing.T) {
	fr := &fakeRunner{}
	e := &ops.Env{Runner: fr, Cfg: ops.Config{Exec: ops.ExecConfig{Enabled: true, AllowArgv0: []string{"/usr/bin/uptime", "/bin/echo"}}}}
	bad := map[string]map[string]any{
		"no argv":            {},
		"empty argv":         {"argv": []string{}},
		"relative argv0":     {"argv": []string{"echo", "x"}},
		"empty argv0":        {"argv": []string{""}},
		"not allowed argv0":  {"argv": []string{"/bin/sh", "-c", "id"}},
		"traversal argv0":    {"argv": []string{"/usr/bin/../bin/sh"}},
		"nul in element":     {"argv": []string{"/bin/echo", "a\x00b"}},
		"huge element":       {"argv": []string{"/bin/echo", strings.Repeat("a", 5000)}},
		"too many elements":  {"argv": append([]string{"/bin/echo"}, make([]string, 70)...)},
		"relative cwd":       {"argv": []string{"/bin/echo"}, "cwd": "tmp"},
		"argv as string":     {"argv": "/bin/echo hi"},
		"shell string field": {"argv": []string{"/bin/echo"}, "command": "id"},
	}
	for name, args := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := prep(t, e, ops.OpExec, args); err == nil {
				t.Fatal("must be rejected")
			}
		})
	}
	if _, err := prep(t, e, ops.OpExec, map[string]any{"argv": []string{"/usr/bin/uptime"}}); err != nil {
		t.Fatal(err)
	}
	_, err := prep(t, e, ops.OpExec, map[string]any{"argv": []string{"/bin/sh", "-c", "id"}})
	wantCode(t, err, protocol.CodeNotAllowed)
	if fr.count() != 0 {
		t.Fatal("nothing may run during validation")
	}
	// cwd must exist at run time
	run, _ := prep(t, e, ops.OpExec, map[string]any{"argv": []string{"/bin/echo"}, "cwd": "/nonexistent-dir-for-test"})
	if _, err := run(context.Background()); err == nil || !strings.Contains(err.Error(), "cwd_not_found") {
		t.Fatalf("%v", err)
	}
}

// Real processes through the real runner: proof that shell metacharacters are
// inert, output is capped, and timeouts kill the whole process group.
func TestExecRunnerWithRealProcesses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX tools")
	}
	echo := "/bin/echo"
	if _, err := os.Stat(echo); err != nil {
		t.Skip("no /bin/echo")
	}
	e := &ops.Env{Cfg: ops.Config{Exec: ops.ExecConfig{Enabled: true}}}
	marker := filepath.Join(t.TempDir(), "pwned")
	res := runOp(t, e, ops.OpExec, map[string]any{"argv": []string{echo, "$(touch " + marker + ")", ";", "touch", marker, "&&", "`touch " + marker + "`"}})
	if !res.OK || !strings.Contains(res.Output.Stdout, "$(touch") {
		t.Fatalf("%+v", res)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a shell interpreted the arguments")
	}

	// output cap: the process writes far more than the budget
	yes := "/usr/bin/yes"
	if _, err := os.Stat(yes); err != nil {
		t.Skip("no /usr/bin/yes")
	}
	run, err := e.Prepare(ops.OpExec, &ops.Request{Args: []byte(`{"argv":["` + yes + `"]}`), Timeout: 500 * time.Millisecond, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	res2, err := run(ctx)
	if err == nil {
		t.Fatalf("yes never exits: the timeout must fire, got %+v", res2)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the process was not stopped promptly (%s)", time.Since(start))
	}

	// a command that finishes, with a large output: truncation flag
	printf := "/usr/bin/head"
	if _, err := os.Stat(printf); err == nil {
		run, _ = e.Prepare(ops.OpExec, &ops.Request{Args: []byte(`{"argv":["/usr/bin/head","-c","200000","/dev/zero"]}`), Timeout: 10 * time.Second, MaxOutputBytes: 4096})
		res3, err := run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !res3.Output.Truncated || len(res3.Output.Stdout) > 2048+10 {
			t.Fatalf("stdout must be capped at half the budget: %d truncated=%v", len(res3.Output.Stdout), res3.Output.Truncated)
		}
	}
}
