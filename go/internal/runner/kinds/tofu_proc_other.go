//go:build !unix

package kinds

import (
	"os/exec"
	"time"
)

// prepareCmd on non-Unix platforms: the runner targets Linux; this exists so
// the package builds and unit tests run elsewhere.
func prepareCmd(cmd *exec.Cmd) {
	cmd.WaitDelay = 10 * time.Second
}

func killGroup(*exec.Cmd) {}
