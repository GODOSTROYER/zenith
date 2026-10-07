//go:build windows

package update

// Linux is the supported target; Windows has no directory fsync guarantee.
func syncDirectory(string) error { return nil }
