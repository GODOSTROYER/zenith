//go:build !unix

// Package proc holds the small platform-specific pieces both agents need to
// run child processes safely. On non-Unix platforms (the agents target Linux;
// this exists so the module builds and unit tests compile elsewhere) process
// groups are not used.
package proc

import (
	"os"
	"os/exec"
	"time"
)

// Prepare configures cancellation; there are no process groups here.
func Prepare(cmd *exec.Cmd, _ os.Signal, grace time.Duration) { cmd.WaitDelay = grace }

// KillGroup is a no-op.
func KillGroup(*exec.Cmd) {}

// Interrupt and Terminate stand in for the Unix signals.
var (
	Interrupt os.Signal = os.Interrupt
	Terminate os.Signal = os.Interrupt
)
