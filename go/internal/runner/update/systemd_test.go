package update_test

import (
	"os"
	"runtime"
	"testing"
)

func TestSystemdSignedUpdateAndRollback(t *testing.T) {
	if os.Getenv("ZENITH_TEST_AGENT_UPDATE_SYSTEMD") != "1" || runtime.GOOS != "linux" {
		t.Skip("not run: needs Linux PID 1 systemd, delegated cgroup v2 and ZENITH_TEST_AGENT_UPDATE_SYSTEMD=1")
	}
	if os.Getenv("ZENITH_AGENT_UPDATE_DISPOSABLE_SYSTEMD") != "1" {
		t.Fatal("refusing systemd installation outside an explicitly disposable VM/container")
	}
	runSystemdAcceptance(t)
}
