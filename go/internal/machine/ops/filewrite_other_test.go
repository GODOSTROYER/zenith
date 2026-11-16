//go:build !linux

package ops

import (
	"context"
	"testing"
)

func TestFileWriteNonLinuxRefusesAndDoesNotAdvertise(t *testing.T) {
	c := Config{FileWrite: FileWriteConfig{Enabled: true, Profiles: []FileWriteProfile{{Path: "/opt/customer/settings.txt"}}}}
	for _, op := range Supported(c) {
		if op == OpFileWrite {
			t.Fatal("non-Linux advertised mutation")
		}
	}
	if fileWritePlatform() {
		t.Fatal("non-Linux advertised support")
	}
	if _, err := runFileWrite(context.Background(), &Env{Cfg: c}, fileWriteArgs{}, FileWriteProfile{}); err == nil {
		t.Fatal("non-Linux mutation accepted")
	}
}

// There is no successful non-Linux mutation mapper to fabricate into a golden.
func fileWriteGoldenFixtures(*testing.T) []fileWriteGoldenFixture { return nil }
