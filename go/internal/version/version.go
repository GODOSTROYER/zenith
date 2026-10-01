// Package version carries build metadata injected with -ldflags.
package version

// Version is the release version, set at link time:
//
//	-X github.com/GODOSTROYER/zenith/go/internal/version.Version=1.0.0
var Version = "0.0.0-dev"

// Commit is the source revision, set at link time.
var Commit = "unknown"

// String returns "<version> (<commit>)".
func String() string { return Version + " (" + Commit + ")" }
