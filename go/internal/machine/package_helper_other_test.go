//go:build !linux

package machine

import (
	"context"
	"testing"
)

func TestPackageHelperRefusesNonLinux(t *testing.T) {
	if runPackageHelper(context.Background()) == nil {
		t.Fatal("non-Linux helper enabled")
	}
	if _, e := packageHelperRoundTrip(context.Background(), packageWireRequest{Kind: "availability"}); e == nil {
		t.Fatal("non-Linux native availability fabricated")
	}
}
