//go:build linux

package ops_test

import (
	"context"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A FIFO inside an allowed directory must not hang the agent (open without
// O_NONBLOCK would block forever waiting for a writer) and must not be read.
func TestFileReadRefusesFIFOWithoutBlocking(t *testing.T) {
	f := newFileEnv(t)
	fifo := filepath.Join(f.root, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skip("mkfifo unavailable: ", err)
	}
	done := make(chan error, 1)
	go func() {
		run, err := prep(t, f.env, "file.read", map[string]any{"path": fifo})
		if err != nil {
			done <- err
			return
		}
		_, err = run(context.Background())
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a FIFO must not be readable")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reading a FIFO hung the operation")
	}
}
