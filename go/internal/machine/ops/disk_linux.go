//go:build linux

package ops

import "syscall"

// statfsBytes returns total, used and available-to-unprivileged bytes.
// Reserved blocks are neither used nor available, matching df's units.
func statfsBytes(path string) (total, used, avail uint64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, false
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, (st.Blocks - st.Bfree) * bs, st.Bavail * bs, true
}
