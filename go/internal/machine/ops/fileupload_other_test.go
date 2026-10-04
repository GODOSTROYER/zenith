//go:build !linux

package ops

import (
	"context"
	"testing"
)

func TestUploadNonLinuxRefusesWithoutAdvertisingOrEffects(t *testing.T) {
	c, p := uploadMetadata(t)
	e := &Env{Cfg: Config{FileUpload: c}}
	for _, op := range Supported(e.Cfg) {
		if op == OpFileUpload {
			t.Fatal("non-Linux advertised upload")
		}
	}
	if _, err := runFileMutation(context.Background(), e, fileWriteArgs{}, uploadProfile(p), fileUploadPurpose); err == nil {
		t.Fatal("non-Linux upload was accepted")
	}
}
