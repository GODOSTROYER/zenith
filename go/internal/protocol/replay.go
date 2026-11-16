package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ReplayCache remembers ids that were already accepted so a re-delivered job
// or machine request is refused. Implementations must be safe for concurrent
// use, and MarkSeen must be durable before it returns true: an agent that
// crashes after MarkSeen must not run the same job again after restart.
type ReplayCache interface {
	// MarkSeen records key until `until`. It returns fresh=false when the key
	// is already present and unexpired.
	MarkSeen(key string, until time.Time) (fresh bool, err error)
}

// MemoryReplayCache is a non-persistent ReplayCache for tests and tools.
type MemoryReplayCache struct {
	mu   sync.Mutex
	now  func() time.Time
	seen map[string]time.Time
}

// NewMemoryReplayCache creates a cache; now may be nil.
func NewMemoryReplayCache(now func() time.Time) *MemoryReplayCache {
	if now == nil {
		now = time.Now
	}
	return &MemoryReplayCache{now: now, seen: map[string]time.Time{}}
}

// MarkSeen implements ReplayCache.
func (m *MemoryReplayCache) MarkSeen(key string, until time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := m.now()
	if exp, ok := m.seen[key]; ok && exp.After(n) {
		return false, nil
	}
	m.seen[key] = until
	for k, e := range m.seen { // opportunistic pruning
		if !e.After(n) {
			delete(m.seen, k)
		}
	}
	return true, nil
}

// FileReplayCache persists the cache as append-only JSON lines
// (`{"k":"job:job_1","e":1790086400}`), fsynced on every accepted key, and
// compacts the file when expired entries dominate. A torn last line (crash
// mid-write) is ignored on load.
type FileReplayCache struct {
	mu        sync.Mutex
	path      string
	now       func() time.Time
	seen      map[string]int64 // key -> expiry unix seconds
	f         *os.File
	dead      int // expired/duplicate lines currently in the file
	lastPrune time.Time
}

type replayLine struct {
	K string `json:"k"`
	E int64  `json:"e"`
}

// OpenFileReplayCache loads (creating if needed, mode 0600) the cache file.
func OpenFileReplayCache(path string, now func() time.Time) (*FileReplayCache, error) {
	if now == nil {
		now = time.Now
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("replay cache dir: %w", err)
	}
	c := &FileReplayCache{path: path, now: now, seen: map[string]int64{}}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read replay cache: %w", err)
	}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		var l replayLine
		if json.Unmarshal(sc.Bytes(), &l) != nil || l.K == "" {
			c.dead++
			continue
		}
		if l.E > now().Unix() {
			if prev, ok := c.seen[l.K]; ok && prev >= l.E {
				c.dead++
				continue
			}
			c.seen[l.K] = l.E
		} else {
			c.dead++
		}
	}
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		c.dead++ // torn final line: rewrite so the next append starts on a fresh line
	}
	if c.dead > 0 {
		if err := c.compactLocked(); err != nil {
			return nil, err
		}
	} else if err := c.openLocked(); err != nil {
		return nil, err
	}
	c.lastPrune = now()
	return c, nil
}

func (c *FileReplayCache) openLocked() error {
	f, err := os.OpenFile(c.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("open replay cache: %w", err)
	}
	c.f = f
	return nil
}

// compactLocked rewrites the file with only live keys (atomic rename).
func (c *FileReplayCache) compactLocked() error {
	if c.f != nil {
		_ = c.f.Close()
		c.f = nil
	}
	tmp := c.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("compact replay cache: %w", err)
	}
	w := bufio.NewWriter(f)
	n := c.now().Unix()
	for k, e := range c.seen {
		if e <= n {
			delete(c.seen, k)
			continue
		}
		b, _ := json.Marshal(replayLine{K: k, E: e})
		w.Write(b)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return fmt.Errorf("compact replay cache: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("compact replay cache: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("compact replay cache: %w", err)
	}
	if err := os.Rename(tmp, c.path); err != nil {
		return fmt.Errorf("compact replay cache: %w", err)
	}
	c.dead = 0
	return c.openLocked()
}

// MarkSeen implements ReplayCache.
func (c *FileReplayCache) MarkSeen(key string, until time.Time) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.now()
	if e, ok := c.seen[key]; ok && e > n.Unix() {
		return false, nil
	}
	line, err := json.Marshal(replayLine{K: key, E: until.Unix()})
	if err != nil {
		return false, err
	}
	if _, err := c.f.Write(append(line, '\n')); err != nil {
		return false, fmt.Errorf("persist: %w", err)
	}
	if err := c.f.Sync(); err != nil {
		return false, fmt.Errorf("persist: %w", err)
	}
	c.seen[key] = until.Unix()
	if n.Sub(c.lastPrune) > time.Hour {
		c.lastPrune = n
		expired := 0
		for _, e := range c.seen {
			if e <= n.Unix() {
				expired++
			}
		}
		if expired > 0 || c.dead > len(c.seen) {
			c.dead += expired
			if err := c.compactLocked(); err != nil {
				return true, nil // the key is durable; compaction retries later
			}
		}
	}
	return true, nil
}

// Len reports the number of live keys (tests, diagnostics).
func (c *FileReplayCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}

// Close releases the file handle.
func (c *FileReplayCache) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.f == nil {
		return nil
	}
	err := c.f.Close()
	c.f = nil
	return err
}
