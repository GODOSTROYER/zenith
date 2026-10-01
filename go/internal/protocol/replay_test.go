package protocol_test

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

func TestMemoryReplayCache(t *testing.T) {
	now := time.Unix(1000, 0)
	c := protocol.NewMemoryReplayCache(func() time.Time { return now })
	if fresh, _ := c.MarkSeen("a", now.Add(time.Hour)); !fresh {
		t.Fatal("first sight must be fresh")
	}
	if fresh, _ := c.MarkSeen("a", now.Add(time.Hour)); fresh {
		t.Fatal("second sight must not be fresh")
	}
	now = now.Add(2 * time.Hour)
	if fresh, _ := c.MarkSeen("a", now.Add(time.Hour)); !fresh {
		t.Fatal("an expired entry may be reused")
	}
}

func TestFileReplayCachePersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state", "replay.jsonl")
	now := time.Unix(1_790_000_000, 0)
	clock := func() time.Time { return now }

	c, err := protocol.OpenFileReplayCache(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	if fresh, err := c.MarkSeen("job:job_1", now.Add(24*time.Hour)); err != nil || !fresh {
		t.Fatalf("fresh=%v err=%v", fresh, err)
	}
	_ = c.Close()

	c2, err := protocol.OpenFileReplayCache(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if fresh, _ := c2.MarkSeen("job:job_1", now.Add(24*time.Hour)); fresh {
		t.Fatal("a job seen before the restart must still be refused")
	}
	if c2.Len() != 1 {
		t.Fatalf("len %d", c2.Len())
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(path)
		if err != nil || st.Mode().Perm()&0o077 != 0 {
			t.Fatalf("replay file must be private: %v %v", st, err)
		}
	}
}

func TestFileReplayCachePrunesExpiredAndSurvivesTornLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "replay.jsonl")
	now := time.Unix(1_790_000_000, 0)
	clock := func() time.Time { return now }
	content := `{"k":"old","e":1000}` + "\n" + `{"k":"live","e":1790086400}` + "\n" + `{"k":"torn","e":17900`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := protocol.OpenFileReplayCache(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Len() != 1 {
		t.Fatalf("only the live key should remain, got %d", c.Len())
	}
	if fresh, _ := c.MarkSeen("live", now.Add(time.Hour)); fresh {
		t.Fatal("live key must be refused")
	}
	if fresh, _ := c.MarkSeen("old", now.Add(time.Hour)); !fresh {
		t.Fatal("expired key must be reusable")
	}
	raw, _ := os.ReadFile(path)
	if len(raw) == 0 || raw[len(raw)-1] != '\n' {
		t.Fatalf("file must end with a newline: %q", raw)
	}
}
