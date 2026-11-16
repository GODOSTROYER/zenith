//go:build !linux

package update_test

import "testing"

func runSystemdAcceptance(t *testing.T) { t.Fatal("Linux systemd is required") }
