package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/proc"
)

// CmdSpec describes one command. Path is the executable and Args its
// arguments: there is never a shell.
type CmdSpec struct {
	Path string
	Args []string
	Dir  string
	// Env is the complete environment; nothing is inherited.
	Env []string
	// MaxStdout / MaxStderr bound the captured bytes; the rest is discarded
	// and reported as truncated.
	MaxStdout, MaxStderr int64
}

// CmdResult is the captured outcome.
type CmdResult struct {
	Stdout, Stderr           []byte
	StdoutTrunc, StderrTrunc bool
	ExitCode                 int
}

// CmdRunner runs commands. Production uses ExecRunner; tests substitute a fake
// so systemctl/journalctl behavior can be exercised on any host.
type CmdRunner interface {
	Run(ctx context.Context, spec CmdSpec) (CmdResult, error)
}

// SafeEnv is the fixed environment for child commands.
func SafeEnv() []string {
	return []string{
		"PATH=/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"SYSTEMD_PAGER=",
		"SYSTEMD_COLORS=0",
		"HOME=/nonexistent",
	}
}

// ExecRunner runs commands with os/exec: own process group, SIGTERM on
// cancellation (SIGKILL after a grace period), bounded output capture.
type ExecRunner struct{}

type limitedBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int64
	trunc bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	room := l.limit - int64(l.buf.Len())
	if room > 0 {
		n := int64(len(p))
		if n > room {
			n = room
			l.trunc = true
		}
		l.buf.Write(p[:n])
		if n < int64(len(p)) {
			l.trunc = true
		}
	} else if len(p) > 0 {
		l.trunc = true
	}
	return len(p), nil // never block or fail the child on a full buffer
}

// Run implements CmdRunner.
func (ExecRunner) Run(ctx context.Context, spec CmdSpec) (CmdResult, error) {
	if spec.Path == "" {
		return CmdResult{}, errors.New("no executable")
	}
	cmd := exec.CommandContext(ctx, spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.Stdin = nil
	proc.Prepare(cmd, proc.Terminate, 5*time.Second)
	out := &limitedBuffer{limit: max(spec.MaxStdout, 0)}
	errb := &limitedBuffer{limit: max(spec.MaxStderr, 0)}
	cmd.Stdout, cmd.Stderr = out, errb
	if err := cmd.Start(); err != nil {
		return CmdResult{}, fmt.Errorf("could not start %s: %w", spec.Path, err)
	}
	err := cmd.Wait()
	proc.KillGroup(cmd)
	res := CmdResult{Stdout: out.buf.Bytes(), Stderr: errb.buf.Bytes(), StdoutTrunc: out.trunc, StderrTrunc: errb.trunc}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			res.ExitCode = ee.ExitCode()
			if res.ExitCode < 0 { // killed by a signal
				res.ExitCode = 137
			}
			if ctx.Err() != nil {
				return res, ctx.Err()
			}
			return res, nil
		}
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		return res, err
	}
	return res, nil
}

var _ io.Writer = (*limitedBuffer)(nil)
