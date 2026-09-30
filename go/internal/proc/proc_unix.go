//go:build unix

// Package proc holds the small platform-specific pieces both agents need to
// run child processes safely: their own process group, graceful cancellation
// and guaranteed cleanup of stragglers.
package proc

import (
	"os/exec"
	"syscall"
	"time"
)

// Prepare puts cmd in its own process group and makes context cancellation
// graceful: sig (SIGINT for OpenTofu, SIGTERM for commands) is sent to the
// whole group, and the process is killed only after grace has elapsed.
func Prepare(cmd *exec.Cmd, graceful syscall.Signal, grace time.Duration) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, graceful)
	}
	cmd.WaitDelay = grace
}

// KillGroup sends SIGKILL to the command's process group, removing any
// straggler after the main process exited (or hung past its grace period).
func KillGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}

// Interrupt and Terminate are the graceful signals.
const (
	Interrupt = syscall.SIGINT
	Terminate = syscall.SIGTERM
)
