package kinds

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// planMeta describes a plan file this runner produced.
type planMeta struct {
	ConfigDigest   string    `json:"configDigest"`
	LockDigest     string    `json:"lockDigest"`
	PlanFileSHA256 string    `json:"planFileSha256"`
	TofuVersion    string    `json:"tofuVersion"`
	Destroy        bool      `json:"destroy"`
	CreatedAt      time.Time `json:"createdAt"`
	JobID          string    `json:"planJobId"`
}

// planStore retains the binary plan files THIS runner produced, keyed by
// (configDigest, sha256 of the plan file bytes). `apply` and `show` name a
// plan by that pair; a plan the runner did not produce, that was modified on
// disk, or that expired cannot be applied. Plans are single-use (consumed by
// an apply attempt) and expire after maxAge (<= 24 h).
//
// Plan files can contain sensitive values, so the directory is 0700 and the
// files are 0600.
type planStore struct {
	dir string
	now func() time.Time
	mu  sync.Mutex
}

func newPlanStore(dir string, now func() time.Time) (*planStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("plan store: %w", err)
	}
	return &planStore{dir: dir, now: now}, nil
}

func (s *planStore) paths(configDigest, planSHA string) (plan, meta string) {
	base := filepath.Join(s.dir, configDigest+"."+planSHA)
	return base + ".tfplan", base + ".json"
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Put copies planFile into the store under its own content hash and returns
// that hash.
func (s *planStore) Put(meta planMeta, planFile string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !digestRe.MatchString(meta.ConfigDigest) {
		return "", errors.New("bad config digest")
	}
	sum, err := fileSHA256(planFile)
	if err != nil {
		return "", err
	}
	meta.PlanFileSHA256 = sum
	planPath, metaPath := s.paths(meta.ConfigDigest, sum)
	tmp := planPath + ".tmp"
	_ = os.Remove(tmp)
	if err := copyFile(planFile, tmp); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, planPath); err != nil {
		return "", err
	}
	if err := writeJSONFile(metaPath, meta); err != nil {
		return "", err
	}
	return sum, nil
}

// Get returns the retained plan for (configDigest, planSHA), verifying that it
// is unexpired and that the file's bytes still hash to planSHA.
func (s *planStore) Get(configDigest, planSHA string, maxAge time.Duration) (*planMeta, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !digestRe.MatchString(configDigest) || !digestRe.MatchString(planSHA) {
		return nil, "", errors.New("bad digest")
	}
	planPath, metaPath := s.paths(configDigest, planSHA)
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, "", errors.New("this runner holds no plan for that configDigest and planFileSha256 (plans are produced by `plan` on this runner, are single-use and expire)")
	}
	var m planMeta
	if err := json.Unmarshal(raw, &m); err != nil || m.ConfigDigest != configDigest || m.PlanFileSHA256 != planSHA {
		return nil, "", errors.New("the retained plan's metadata is corrupt")
	}
	if s.now().Sub(m.CreatedAt) > maxAge {
		return nil, "", errors.New("the retained plan has expired; run `plan` again")
	}
	sum, err := fileSHA256(planPath)
	if err != nil || sum != planSHA {
		return nil, "", errors.New("the retained plan file failed its integrity check")
	}
	return &m, planPath, nil
}

// Consume deletes a plan (single use).
func (s *planStore) Consume(configDigest, planSHA string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, m := s.paths(configDigest, planSHA)
	_ = os.Remove(m)
	_ = os.Remove(p)
}

// Prune deletes plan files older than maxAge (by modification time, plus a
// small margin so a plan being read is never removed from under an apply).
func (s *planStore) Prune(maxAge time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".tfplan") && !strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".tmp") {
			continue
		}
		info, err := e.Info()
		if err == nil && s.now().Sub(info.ModTime()) > maxAge+10*time.Minute {
			_ = os.Remove(filepath.Join(s.dir, name))
		}
	}
	return nil
}

func writeJSONFile(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
