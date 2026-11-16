package spool_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/agent/spool"
)

func open(t *testing.T, entries int, bytes int64) (*spool.Spool, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "spool")
	s, err := spool.Open(dir, entries, bytes, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s, dir
}

func TestPutSurvivesReopenAndFirstResultWins(t *testing.T) {
	s, dir := open(t, 0, 0)
	if existed, err := s.Put("run_a", "job_1", map[string]any{"status": "succeeded"}); err != nil || existed {
		t.Fatalf("first put: existed=%v err=%v", existed, err)
	}
	if existed, err := s.Put("run_a", "job_1", map[string]any{"status": "failed"}); err != nil || !existed {
		t.Fatalf("second put must keep the first result: existed=%v err=%v", existed, err)
	}
	// a fresh process: reopen the directory
	s2, err := spool.Open(dir, 0, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Pending("run_a")
	if len(got) != 1 || got[0].JTI != "job_1" || string(got[0].Body) != `{"status":"succeeded"}` {
		t.Fatalf("unexpected pending entries: %+v", got)
	}
	if st := s2.Stats(); st.Depth != 1 || st.Bytes == 0 || st.OldestAt == nil {
		t.Fatalf("unexpected stats %+v", st)
	}
	if err := s2.Remove("job_1"); err != nil {
		t.Fatal(err)
	}
	if len(s2.Pending("run_a")) != 0 {
		t.Fatal("removed entries must not be replayed")
	}
}

func TestForeignIdentityAndCorruptEntriesAreQuarantined(t *testing.T) {
	s, dir := open(t, 0, 0)
	if _, err := s.Put("run_old", "job_1", map[string]any{"status": "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if got := s.Pending("run_new"); len(got) != 0 {
		t.Fatal("another identity's results must never be replayed")
	}
	if ents, _ := os.ReadDir(filepath.Join(dir, "quarantine")); len(ents) != 1 {
		t.Fatalf("expected one quarantined entry, got %d", len(ents))
	}
	if _, err := s.Put("run_new", "job_2", map[string]any{"status": "succeeded"}); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) != 1 {
		t.Fatalf("expected one entry file, got %d", len(files))
	}
	if err := os.WriteFile(files[0], []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := s.Pending("run_new"); len(got) != 0 {
		t.Fatal("a corrupt entry must not be replayed")
	}
}

func TestBoundsRefuseNewEntriesInsteadOfDroppingOld(t *testing.T) {
	s, _ := open(t, 2, 0)
	for _, id := range []string{"job_1", "job_2"} {
		if _, err := s.Put("run_a", id, map[string]any{"n": id}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Put("run_a", "job_3", map[string]any{"n": "3"}); !errors.Is(err, spool.ErrFull) {
		t.Fatalf("expected ErrFull, got %v", err)
	}
	if got := s.Pending("run_a"); len(got) != 2 {
		t.Fatalf("existing entries must be kept, got %d", len(got))
	}
}

func TestRecordAttemptKeepsAgeAndCount(t *testing.T) {
	s, _ := open(t, 0, 0)
	if _, err := s.Put("run_a", "job_1", map[string]any{"status": "succeeded"}); err != nil {
		t.Fatal(err)
	}
	before := s.Stats().OldestAt
	s.RecordAttempt("job_1", errors.New("503"))
	got := s.Pending("run_a")
	if len(got) != 1 || got[0].Attempts != 1 || got[0].LastError != "503" {
		t.Fatalf("unexpected entry %+v", got)
	}
	if after := s.Stats().OldestAt; before == nil || after == nil || !before.Equal(*after) {
		t.Fatalf("age must be preserved: %v vs %v", before, after)
	}
}
