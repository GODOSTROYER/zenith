//go:build windows

package agent

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

func TestWindowsDefaultReadHandleBlocksIdentityReplacement(t *testing.T) {
	a, id, keys, _ := rotationFixture(t)
	f, err := os.Open(filepath.Join(a.cfg.StateDir, IdentityFileName))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	copy := *id
	copy.ControlPlaneKeys = append(copy.ControlPlaneKeys, protocoltest.New("blocked-reader").Keys()...)
	err = SaveIdentity(a.cfg.StateDir, &copy)
	var errno syscall.Errno
	if !errors.As(err, &errno) || (errno != syscall.Errno(32) && errno != syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected Windows sharing refusal, got %v", err)
	}
	t.Logf("default Go read handle refused atomic replacement: Windows errno %d", errno)
	if keys.Len() != 1 || persistedRotationKeys(t, a).Len() != 1 {
		t.Fatal("failed persistence changed trust")
	}
}

func TestWindowsIdentityReadLeaseSerializesReplacement(t *testing.T) {
	a, _, keys, _ := rotationFixture(t)
	identityFileMu.RLock()
	f, err := os.Open(filepath.Join(a.cfg.StateDir, IdentityFileName))
	if err != nil {
		identityFileMu.RUnlock()
		t.Fatal(err)
	}
	defer f.Close()
	leaseHeld := true
	defer func() {
		if leaseHeld {
			f.Close()
			identityFileMu.RUnlock()
		}
	}()
	next := protocoltest.New("leased-reader").Keys()
	done := make(chan struct{})
	go func() { a.acceptNextKeys(next); close(done) }()
	select {
	case <-done:
		t.Fatal("replacement must wait for the identity read lease")
	case <-time.After(20 * time.Millisecond):
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	var old Identity
	if json.Unmarshal(raw, &old) != nil || len(old.ControlPlaneKeys) != 1 {
		t.Fatal("leased reader must retain the complete old identity")
	}
	if keys.Len() != 1 {
		t.Fatal("trust must not publish while persistence waits")
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	identityFileMu.RUnlock()
	leaseHeld = false
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("rotation did not finish after identity reader closed")
	}
	if keys.Len() != 2 || persistedRotationKeys(t, a).Len() != 2 {
		t.Fatal("rotation must persist before publishing after the reader closes")
	}
}
