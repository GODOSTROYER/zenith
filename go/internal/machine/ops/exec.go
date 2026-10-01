package ops

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

func init() { register(Operation{Name: OpExec, Prepare: prepareExec}) }

type execArgs struct {
	Argv       []string `json:"argv"`
	Cwd        string   `json:"cwd"`
	TimeoutSec int      `json:"timeoutSec"`
}

// prepareExec implements machine.exec, the escape hatch. It runs an argv
// list directly (execve): there is no shell, so shell syntax in an element is
// just text. It is refused unless exec.enabled is true in the LOCAL config,
// and the control plane's own policy gate is a separate, additional layer.
//
// Honest limit: enabling exec lets the control plane run any program the
// zenithd user can run, including a shell given as argv[0] with "-c". The
// allowArgv0 list is the way to narrow that to specific executables.
func prepareExec(e *Env, req *Request) (Runnable, error) {
	if !e.Cfg.Exec.Enabled {
		return nil, disabled("machine.exec is disabled: exec.enabled is false on this machine")
	}
	var a execArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := validateArgv(a.Argv); err != nil {
		return nil, err
	}
	argv0, err := absClean(a.Argv[0])
	if err != nil {
		return nil, invalid("argv[0] must be an absolute path to an executable (no PATH search)")
	}
	if len(e.Cfg.Exec.AllowArgv0) > 0 {
		ok := false
		for _, allowed := range e.Cfg.Exec.AllowArgv0 {
			clean, _ := absClean(allowed)
			if argv0 == clean {
				ok = true
				break
			}
		}
		if !ok {
			return nil, notAllowed("executable %q is not in exec.allowArgv0 on this machine", clip(argv0, 120))
		}
	}
	cwd := ""
	if a.Cwd != "" {
		if cwd, err = absClean(a.Cwd); err != nil {
			return nil, err
		}
	}
	if err := checkExecTimeout(a.TimeoutSec, req.Timeout); err != nil {
		return nil, err
	}
	limit := req.MaxOutputBytes
	return func(ctx context.Context) (Result, error) {
		ctx, cancel := execContext(ctx, a.TimeoutSec)
		defer cancel()
		if cwd != "" {
			if st, err := os.Stat(cwd); err != nil || !st.IsDir() {
				return Result{}, fmt.Errorf("cwd_not_found: %s", clip(cwd, 120))
			}
		}
		res, err := e.runner().Run(ctx, CmdSpec{
			Path: argv0, Args: a.Argv[1:], Dir: cwd, Env: SafeEnv(),
			MaxStdout: limit / 2, MaxStderr: limit / 2,
		})
		if err != nil {
			if ctx.Err() != nil {
				return Result{}, ctx.Err()
			}
			return Result{}, fmt.Errorf("exec_failed: %s", redact.String(clip(err.Error(), 200)))
		}
		code := res.ExitCode
		result := Result{
			OK:   code == 0,
			Data: map[string]any{"exitCode": code},
			Output: &Output{
				Stdout:    redact.String(strings.ToValidUTF8(string(res.Stdout), "?")),
				Stderr:    redact.String(strings.ToValidUTF8(string(res.Stderr), "?")),
				ExitCode:  &code,
				Truncated: res.StdoutTrunc || res.StderrTrunc,
			},
		}
		if !result.OK {
			f := Failure("command_failed", fmt.Sprintf("command exited %d", code))
			f.Data["exitCode"] = code
			result.Data, result.Err = f.Data, f.Err
		}
		return result, nil
	}, nil
}

func checkExecTimeout(sec int, budget time.Duration) error {
	if sec < 0 || sec > 300 || (sec > 0 && budget > 0 && time.Duration(sec)*time.Second > budget) {
		return invalid("timeoutSec must be within the request budget and at most 300")
	}
	return nil
}
func execContext(ctx context.Context, sec int) (context.Context, context.CancelFunc) {
	if sec == 0 {
		sec = 30
	}
	return context.WithTimeout(ctx, time.Duration(sec)*time.Second)
}
