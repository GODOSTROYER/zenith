//go:build !linux

package ops

// statfsBytes is unavailable off Linux; machine.inspect and system.metrics
// report an empty disk list there (and those operations need /proc anyway).
func statfsBytes(string) (total, free uint64, ok bool) { return 0, 0, false }
