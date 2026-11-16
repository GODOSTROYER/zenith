//go:build !linux

package ops

import (
	"os"
	"testing"
)

func compareServiceConfigureGolden(t *testing.T) {
	t.Helper()
	if os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1" {
		t.Fatal("authentic service.configure golden generation requires unprivileged Linux")
	}
	t.Skip("authentic service.configure filesystem golden comparison requires Linux")
}
