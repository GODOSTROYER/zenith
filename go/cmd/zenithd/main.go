// Command zenithd is Zenith's outbound-only machine agent: it executes signed
// semantic operations (service status, bounded file reads, logs, checks) on a
// Linux VM. See docs/platform/ZENITHD.md and docs/platform/RUNNER-PROTOCOL.md.
package main

import (
	"os"

	"github.com/GODOSTROYER/zenith/go/internal/machine"
)

func main() {
	os.Exit(machine.Main(os.Args[1:], os.Stdout, os.Stderr, os.Getenv))
}
