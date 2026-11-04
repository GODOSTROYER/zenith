//go:build windows

package update

import (
	"errors"
	"os"
	"os/exec"
)

// Windows cannot fsync a directory handle; no power-loss claim is made there.
func syncDir(string) error { return nil }

// execReplace runs the child to completion and returns its exit code (Windows
// has no exec(2)). The linux agent is the supported target; this keeps the
// package building and testable on developer machines.
func execReplace(path string, args, env []string) (int, error) {
	cmd := exec.Command(path, args[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		return 0, err
	}
	return 0, nil
}
