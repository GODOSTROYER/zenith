package machine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// AuditEntry is one line of the local audit log. It records what was asked
// and what happened, never what was read: no file contents, no exec output,
// no log text. Only digests and sizes of outputs are kept.
type AuditEntry struct {
	TS        string `json:"ts"`
	Phase     string `json:"phase"` // rejected | start | end
	RequestID string `json:"requestId"`
	Operation string `json:"operation"`
	// Verified is false when the signature did not verify: requestId and
	// operation then come from an unauthenticated token and are only hints.
	Verified    bool              `json:"verified"`
	GrantJTI    string            `json:"grantJti,omitempty"`
	OperationID string            `json:"operationId,omitempty"`
	Outcome     string            `json:"outcome"` // rejected | started | succeeded | failed | timed_out
	Reason      string            `json:"reason,omitempty"`
	ArgsSHA256  string            `json:"argsSha256,omitempty"`
	Target      map[string]any    `json:"target,omitempty"`
	OutputSHA   string            `json:"outputSha256,omitempty"`
	OutputBytes int               `json:"outputBytes,omitempty"`
	DurationMs  int64             `json:"durationMs,omitempty"`
	Extra       map[string]string `json:"extra,omitempty"`
}

// AuditLog appends JSON lines to a 0600 file, fsyncing each entry.
type AuditLog struct {
	mu sync.Mutex
	f  *os.File
}

// OpenAudit opens (creating) the audit log with mode 0600.
func OpenAudit(path string) (*AuditLog, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("audit log dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	return &AuditLog{f: f}, nil
}

// Append writes one entry durably. A failure is returned: callers refuse to
// run an operation whose start could not be recorded.
func (a *AuditLog) Append(e AuditEntry) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, err := a.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return a.f.Sync()
}

// Close releases the file.
func (a *AuditLog) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.f.Close()
}
