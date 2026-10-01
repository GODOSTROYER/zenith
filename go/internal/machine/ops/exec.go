package ops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

func init() { register(Operation{Name: OpExec, Prepare: prepareExec}) }

type execArgs struct {
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
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
			if argv0 == filepath.Clean(allowed) {
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
	limit := req.MaxOutputBytes
	return func(ctx context.Context) (Result, error) {
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
		return Result{
			OK:   code == 0,
			Data: map[string]any{"argv0": argv0, "argc": len(a.Argv)},
			Output: &Output{
				Stdout:    redact.String(strings.ToValidUTF8(string(res.Stdout), "?")),
				Stderr:    redact.String(strings.ToValidUTF8(string(res.Stderr), "?")),
				ExitCode:  &code,
				Truncated: res.StdoutTrunc || res.StderrTrunc,
			},
		}, nil
	}, nil
}
