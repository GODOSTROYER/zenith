// Package update implements the agent's verified, staged self-update with
// health check and automatic rollback.
//
// Layout under <stateDir>/update:
//
//	state.json                         the only source of truth (atomic, 0600)
//	releases/<version>-<sha12>/<bin>   verified release binaries (0700)
//
// The packaged binary (for example /usr/local/bin/zenithd, read-only under the
// systemd sandbox) is the BASELINE and also the launcher: on `run` it consults
// state.json and execs the active release when there is one. Rolling back is a
// state change plus an exec of the previous slot, so it works even when the new
// release cannot start at all: the baseline launcher sees the unhealthy pending
// state on the next start and reverts without running the broken binary.
//
// The control plane has no say in which binary runs. A release is applied only
// when (1) its manifest verifies against release keys pinned in the agent's
// local config, (2) the artifact digest and size match the signed manifest,
// (3) the staged binary reports the expected version when asked, and (4) the
// manifest is newer (seq) and not a downgrade unless signed as a rollback.
package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// StateFileName is the state file inside <stateDir>/update.
const StateFileName = "state.json"

const (
	stateVersion  = 1
	maxHistory    = 20
	maxFailedKeep = 8
)

// Slot is an installed release. A nil slot means the packaged baseline binary.
type Slot struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Path    string `json:"path"`
}

// Pending is a freshly activated release that has not yet proven healthy.
type Pending struct {
	Version  string    `json:"version"`
	StagedAt time.Time `json:"stagedAt"`
	Deadline time.Time `json:"deadline"`
	// Boots counts launches since activation; a release that keeps restarting
	// without committing is rolled back by the launcher.
	Boots int `json:"boots"`
}

// Event is one history entry.
type Event struct {
	At      time.Time `json:"at"`
	Kind    string    `json:"kind"` // staged | committed | rolled_back | check_failed | rejected
	Version string    `json:"version,omitempty"`
	Detail  string    `json:"detail,omitempty"`
}

// State is persisted between runs and across restarts.
type State struct {
	Version   int      `json:"version"`
	Component string   `json:"component"`
	Active    *Slot    `json:"active,omitempty"`
	Previous  *Slot    `json:"previous,omitempty"`
	Pending   *Pending `json:"pending,omitempty"`
	// LastSeq is the highest manifest sequence ever accepted; older manifests
	// are replays.
	LastSeq int64 `json:"lastSeq"`
	// Failed lists versions that were rolled back; they are not re-applied.
	Failed         []string   `json:"failed,omitempty"`
	LastCheckAt    *time.Time `json:"lastCheckAt,omitempty"`
	LastError      string     `json:"lastError,omitempty"`
	LastErrorAt    *time.Time `json:"lastErrorAt,omitempty"`
	RolledBackFrom string     `json:"rolledBackFrom,omitempty"`
	RolledBackAt   *time.Time `json:"rolledBackAt,omitempty"`
	RollbackReason string     `json:"rollbackReason,omitempty"`
	History        []Event    `json:"history,omitempty"`
}

// Store reads and writes the state file. Safe for concurrent use inside one
// process; the launcher and the agent never run concurrently in one process.
type Store struct {
	dir string
	mu  sync.Mutex
}

// NewStore returns the store for a state directory.
func NewStore(stateDir string) *Store { return &Store{dir: filepath.Join(stateDir, "update")} }

// Dir is the update directory.
func (s *Store) Dir() string { return s.dir }

// ReleasesDir is where verified binaries live.
func (s *Store) ReleasesDir() string { return filepath.Join(s.dir, "releases") }

func (s *Store) path() string { return filepath.Join(s.dir, StateFileName) }

// Exists reports whether a state file is present.
func (s *Store) Exists() bool {
	_, err := os.Stat(s.path())
	return err == nil
}

// Load reads the state; a missing file is the empty state.
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) loadLocked() (State, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, fs.ErrNotExist) {
		return State{Version: stateVersion}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read update state: %w", err)
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return State{}, fmt.Errorf("update state is corrupt: %w", err)
	}
	if st.Version != stateVersion {
		return State{}, fmt.Errorf("update state has unsupported version %d", st.Version)
	}
	return st, nil
}

// Save writes the state atomically (temp file, fsync, rename).
func (s *Store) Save(st State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(st)
}

// Update loads, mutates and saves the state under one lock.
func (s *Store) Update(fn func(*State) error) (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.loadLocked()
	if err != nil {
		return State{}, err
	}
	if err := fn(&st); err != nil {
		return st, err
	}
	return st, s.saveLocked(st)
}

func (s *Store) saveLocked(st State) error {
	st.Version = stateVersion
	if len(st.History) > maxHistory {
		st.History = st.History[len(st.History)-maxHistory:]
	}
	if len(st.Failed) > maxFailedKeep {
		st.Failed = st.Failed[len(st.Failed)-maxFailedKeep:]
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("create update dir: %w", err)
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".state-*.tmp")
	if err != nil {
		return fmt.Errorf("write update state: %w", err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(append(raw, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("write update state: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("sync update state: %w", err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path()); err != nil {
		return fmt.Errorf("commit update state: %w", err)
	}
	return syncDir(s.dir)
}

func addEvent(st *State, now time.Time, kind, version, detail string) {
	if len(detail) > 300 {
		detail = detail[:300]
	}
	st.History = append(st.History, Event{At: now.UTC(), Kind: kind, Version: version, Detail: detail})
}

// Status is the compact, non-secret view reported in heartbeats and by the
// `update status` command.
type Status struct {
	// State is current | pending_health | rolled_back | check_failed.
	State          string     `json:"state"`
	Channel        string     `json:"channel,omitempty"`
	Running        string     `json:"running"`
	Target         string     `json:"target,omitempty"`
	PreviousSlot   string     `json:"previous,omitempty"`
	LastSeq        int64      `json:"lastSeq"`
	LastCheckAt    *time.Time `json:"lastCheckAt,omitempty"`
	LastError      string     `json:"lastError,omitempty"`
	RolledBackFrom string     `json:"rolledBackFrom,omitempty"`
	RolledBackAt   *time.Time `json:"rolledBackAt,omitempty"`
	RollbackReason string     `json:"rollbackReason,omitempty"`
	Deadline       *time.Time `json:"deadline,omitempty"`
}

// StatusOf derives the status from the persisted state.
func StatusOf(st State, channel, running string) Status {
	s := Status{State: "current", Channel: channel, Running: running, LastSeq: st.LastSeq, LastCheckAt: st.LastCheckAt, LastError: st.LastError,
		RolledBackFrom: st.RolledBackFrom, RolledBackAt: st.RolledBackAt, RollbackReason: st.RollbackReason}
	if st.Previous != nil {
		s.PreviousSlot = st.Previous.Version
	}
	switch {
	case st.Pending != nil:
		s.State = "pending_health"
		s.Target = st.Pending.Version
		d := st.Pending.Deadline
		s.Deadline = &d
	case st.RolledBackFrom != "":
		s.State = "rolled_back"
	case st.LastError != "":
		s.State = "check_failed"
	}
	return s
}
