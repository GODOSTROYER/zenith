//go:build !windows

package update

import "os"

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

// execReplace replaces the current process image. It returns only on failure.
func execReplace(path string, args, env []string) (int, error) {
	err := syscallExec(path, args, env)
	return 0, err
}
