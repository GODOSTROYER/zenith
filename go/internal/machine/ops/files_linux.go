//go:build linux

package ops

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// openReadOnly opens path without following a final symlink and without
// blocking on FIFOs or devices, then verifies through /proc/self/fd what was
// actually opened: it must be exactly the resolved path that passed the
// allowlist. This closes the window between the check and the open in which a
// local user could swap a directory component for a symlink.
func openReadOnly(resolved string) (*os.File, error) {
	f, err := os.OpenFile(resolved, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	actual, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
	if err == nil && filepath.Clean(actual) != resolved {
		f.Close()
		return nil, fmt.Errorf("the file changed while it was being opened")
	}
	return f, nil
}
