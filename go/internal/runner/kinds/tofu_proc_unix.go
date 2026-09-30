//go:build unix

package kinds

import (
	"os/exec"
	"syscall"
	"time"
)

// prepareCmd puts tofu (and the provider plugins it spawns) in their own
// process group, and makes cancellation graceful: SIGINT lets OpenTofu finish
// writing state and release its lock, and only after WaitDelay is the process
// killed.
func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGINT)
	}
	cmd.WaitDelay = 30 * time.Second
}

// killGroup removes any straggler in the process group after the main
// process has exited.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
