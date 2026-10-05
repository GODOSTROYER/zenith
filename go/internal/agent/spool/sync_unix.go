//go:build !windows

package spool

import "os"

func isWindows() bool { return false }

// syncDir makes a rename or unlink durable.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		d.Close()
		return err
	}
	return d.Close()
}
