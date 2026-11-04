// Command zenith-runner executes signed jobs from the Zenith control plane
// inside the customer's network, with the customer's local workload identity.
// See docs/platform/RUNNER.md and docs/platform/RUNNER-PROTOCOL.md.
package main

import (
	"os"

	"github.com/GODOSTROYER/zenith/go/internal/runner"
)

func main() {
	os.Exit(runner.Main(os.Args[1:], os.Stdout, os.Stderr, os.Getenv))
}
