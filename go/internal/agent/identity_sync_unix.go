//go:build !windows

package agent

import "os"

// A failed directory sync refuses publication even if rename already succeeded.
func syncIdentityDirectory(stateDir string) error {
	dir, err := os.Open(stateDir)
	if err != nil {
		return err
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return err
	}
	return dir.Close()
}
