//go:build !linux

package ops

import "os"

// openReadOnly on non-Linux hosts (tests only): no /proc/self/fd re-check.
func openReadOnly(resolved string) (*os.File, error) { return os.Open(resolved) }
