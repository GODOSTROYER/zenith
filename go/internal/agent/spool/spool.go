// Package spool is the agent's durable local result spool.
//
// A finished job's result is written here (file, fsync, rename, directory
// fsync) BEFORE the agent tries to post it, and removed only once the control
// plane has accepted it, said the job is already settled, or refused it
// terminally. A crash, a restart, a control-plane outage or a network
// partition therefore cannot lose a result: the next start, or the next
// reconnect, replays what is still on disk. Replay is safe because the control
// plane settles a job at most once and accepts an exact logical retry of the
// first outcome (see settleResult), so "post again" is idempotent.
//
// The spool is bounded (entry count and bytes). When it is full, Put fails and
// the caller falls back to in-memory retry and says so; it never drops an
// already spooled result to make room.
//
// Entries belong to one agent identity. Entries written by another identity
// (the agent was re-registered) are moved to quarantine, never replayed under
// the new identity, where they could only be refused.
package spool

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Limits.
const (
	DefaultMaxEntries = 10_000
	DefaultMaxBytes   = 512 << 20
	entryVersion      = 1
	maxEntryBytes     = 70 << 20
	fileSuffix        = ".json"
	quarantineDir     = "quarantine"
)

// ErrFull means the spool is at its entry or byte limit.
var ErrFull = errors.New("result spool is full")

// Entry is one spooled result.
type Entry struct {
	Version   int             `json:"version"`
	AgentID   string          `json:"agentId"`
	JTI       string          `json:"jti"`
	Body      json.RawMessage `json:"body"`
	Digest    string          `json:"digest"` // sha256 of Body
	CreatedAt time.Time       `json:"createdAt"`
	Attempts  int             `json:"attempts"`
	LastError string          `json:"lastError,omitempty"`
	LastTryAt *time.Time      `json:"lastTryAt,omitempty"`
}

// Stats summarises the spool for heartbeats and the status command.
type Stats struct {
	Depth    int        `json:"depth"`
	Bytes    int64      `json:"bytes"`
	OldestAt *time.Time `json:"oldestAt,omitempty"`
}

// Spool is a directory of pending results. Safe for concurrent use.
type Spool struct {
	dir        string
	maxEntries int
	maxBytes   int64
	now        func() time.Time

	mu sync.Mutex
}

// Open creates (0700) and opens the spool directory. maxEntries/maxBytes <= 0
// use the defaults. now may be nil.
func Open(dir string, maxEntries int, maxBytes int64, now func() time.Time) (*Spool, error) {
	if dir == "" {
		return nil, errors.New("spool: directory is required")
	}
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("spool: create directory: %w", err)
	}
	s := &Spool{dir: dir, maxEntries: maxEntries, maxBytes: maxBytes, now: now}
	// Leftover temp files from a crash mid-write hold no committed result.
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".tmp-") {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	return s, nil
}

func (s *Spool) path(jti string) string {
	sum := sha256.Sum256([]byte(jti))
	return filepath.Join(s.dir, hex.EncodeToString(sum[:16])+fileSuffix)
}

// Put durably records a result for a job. The first result recorded for a job
// wins: a second Put for the same job keeps the original (the control plane
// keeps only the first outcome too) and reports it as existing.
func (s *Spool) Put(agentID, jti string, body any) (existed bool, err error) {
	if agentID == "" || jti == "" {
		return false, errors.New("spool: agent id and job id are required")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return false, fmt.Errorf("spool: encode result: %w", err)
	}
	if len(raw) > maxEntryBytes {
		return false, fmt.Errorf("spool: result of %d bytes is too large", len(raw))
	}
	sum := sha256.Sum256(raw)
	entry := Entry{Version: entryVersion, AgentID: agentID, JTI: jti, Body: raw, Digest: hex.EncodeToString(sum[:]), CreatedAt: s.now().UTC()}
	data, err := json.Marshal(entry)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	final := s.path(jti)
	if _, err := os.Stat(final); err == nil {
		return true, nil
	}
	depth, bytes := s.usageLocked()
	if depth >= s.maxEntries || bytes+int64(len(data)) > s.maxBytes {
		return false, ErrFull
	}
	if err := writeAtomic(s.dir, final, data); err != nil {
		return false, err
	}
	_ = os.Chtimes(final, entry.CreatedAt, entry.CreatedAt)
	return false, nil
}

func writeAtomic(dir, final string, data []byte) error {
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("spool: write: %w", err)
	}
	tmp := f.Name()
	committed := false
	defer func() {
		if !committed {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("spool: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("spool: sync: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("spool: close: %w", err)
	}
	if err := os.Chmod(tmp, 0o600); err != nil && !isWindows() {
		return fmt.Errorf("spool: chmod: %w", err)
	}
	if err := os.Rename(tmp, final); err != nil {
		return fmt.Errorf("spool: commit: %w", err)
	}
	committed = true
	if err := syncDir(dir); err != nil {
		return fmt.Errorf("spool: sync directory: %w", err)
	}
	return nil
}

func (s *Spool) usageLocked() (int, int64) {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return 0, 0
	}
	n, total := 0, int64(0)
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), fileSuffix) {
			continue
		}
		if info, err := e.Info(); err == nil {
			n++
			total += info.Size()
		}
	}
	return n, total
}

// Pending returns the entries that belong to agentID, oldest first. Entries
// for another identity and corrupt entries are moved to quarantine.
func (s *Spool) Pending(agentID string) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	var out []Entry
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), fileSuffix) {
			continue
		}
		full := filepath.Join(s.dir, e.Name())
		raw, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		var en Entry
		if err := json.Unmarshal(raw, &en); err != nil || en.Version != entryVersion || en.JTI == "" || !digestOK(en) || s.path(en.JTI) != full {
			s.quarantineLocked(full, "corrupt")
			continue
		}
		if en.AgentID != agentID {
			s.quarantineLocked(full, "foreign-identity")
			continue
		}
		out = append(out, en)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].JTI < out[j].JTI
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

func digestOK(e Entry) bool {
	sum := sha256.Sum256(e.Body)
	return hex.EncodeToString(sum[:]) == e.Digest
}

// Remove deletes a result after the control plane has settled the job.
func (s *Spool) Remove(jti string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := os.Remove(s.path(jti))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("spool: remove: %w", err)
	}
	return syncDir(s.dir)
}

// Quarantine moves a result the control plane refused terminally out of the
// replay set but keeps it for diagnosis.
func (s *Spool) Quarantine(jti, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.quarantineLocked(s.path(jti), reason)
}

func (s *Spool) quarantineLocked(full, reason string) {
	qdir := filepath.Join(s.dir, quarantineDir)
	if err := os.MkdirAll(qdir, 0o700); err != nil {
		return
	}
	base := strings.TrimSuffix(filepath.Base(full), fileSuffix)
	dst := filepath.Join(qdir, fmt.Sprintf("%s.%s.%d%s", base, sanitize(reason), s.now().UnixNano(), fileSuffix))
	if err := os.Rename(full, dst); err != nil {
		_ = os.Remove(full)
	}
	_ = syncDir(s.dir)
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

// RecordAttempt notes a failed replay attempt on the entry (diagnostics only).
func (s *Spool) RecordAttempt(jti string, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	full := s.path(jti)
	raw, err := os.ReadFile(full)
	if err != nil {
		return
	}
	var en Entry
	if json.Unmarshal(raw, &en) != nil {
		return
	}
	now := s.now().UTC()
	en.Attempts++
	en.LastTryAt = &now
	if cause != nil {
		msg := cause.Error()
		if len(msg) > 200 {
			msg = msg[:200]
		}
		en.LastError = msg
	}
	if data, err := json.Marshal(en); err == nil {
		if writeAtomic(s.dir, full, data) == nil {
			// keep the file time equal to CreatedAt so Stats reports the true age
			_ = os.Chtimes(full, en.CreatedAt, en.CreatedAt)
		}
	}
}

// Stats reports the current depth, size and age of the spool.
func (s *Spool) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return Stats{}
	}
	var st Stats
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), fileSuffix) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		st.Depth++
		st.Bytes += info.Size()
		t := info.ModTime().UTC()
		if st.OldestAt == nil || t.Before(*st.OldestAt) {
			tt := t
			st.OldestAt = &tt
		}
	}
	return st
}
