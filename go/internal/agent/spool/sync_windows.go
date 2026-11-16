//go:build windows

package spool

func isWindows() bool { return true }

// Windows cannot fsync a directory handle; file sync and rename still precede
// removal of the in-memory copy. No power-loss claim is made on Windows.
func syncDir(string) error { return nil }
