//go:build !linux

package machine

import (
	"context"
	"errors"
)

func runPackageHelper(context.Context) error { return errors.New("package helper requires Linux") }
func packageHelperRoundTrip(context.Context, packageWireRequest) (packageWireResponse, error) {
	return packageWireResponse{}, errors.New("package helper requires Linux")
}
