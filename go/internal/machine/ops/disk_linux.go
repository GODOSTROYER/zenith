//go:build linux

package ops

import "syscall"

// statfsBytes returns total and free (available to unprivileged users) bytes.
func statfsBytes(path string) (total, free uint64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, false
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, true
}
