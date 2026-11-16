//go:build windows

package agent

// os.File.Sync on Windows cannot sync an opened directory. File sync and rename
// still precede trust publication; this provides no directory/power-loss claim.
func syncIdentityDirectory(_ string) error {
	return nil
}
