// Package update binds control-plane update intent to local release trust.
// It never accepts a URL, signing key or executable path from the control plane.
package update

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	lifecycle "github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
)

const Type = "zenith-update-control+jwt"
const Schema = "zenith.update-control/v1"

type Binding struct{ WorkspaceID, AgentID, Kind string }
type Directive struct {
	Schema         string  `json:"schema"`
	WorkspaceID    string  `json:"workspaceId"`
	AgentID        string  `json:"agentId"`
	Kind           string  `json:"kind"`
	Nonce          string  `json:"nonce"`
	Revision       int64   `json:"revision"`
	Hold           bool    `json:"hold"`
	ManifestSHA256 *string `json:"manifestSha256"`
	IssuedAt       int64   `json:"iat"`
	ExpiresAt      int64   `json:"exp"`
}

var digestRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

func Nonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return protocol.B64Encode(b), nil
}

func Verify(compact string, keys *protocol.KeySet, binding Binding, nonce string, now time.Time) (Directive, error) {
	var d Directive
	_, raw, err := protocol.VerifyCompact(compact, keys, Type)
	if err != nil {
		return d, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return d, errors.New("malformed update directive")
	}
	if dec.Decode(new(any)) != io.EOF {
		return d, errors.New("trailing directive data")
	}
	if d.Schema != Schema || d.WorkspaceID != binding.WorkspaceID || d.AgentID != binding.AgentID || d.Kind != binding.Kind || len(nonce) != 22 || d.Nonce != nonce {
		return d, errors.New("update directive binding mismatch")
	}
	if d.Revision < 0 || d.Revision > 2147483647 || d.IssuedAt > now.Unix()+5 || d.ExpiresAt <= now.Unix() || d.ExpiresAt <= d.IssuedAt || d.ExpiresAt-d.IssuedAt > 60 {
		return d, errors.New("update directive revision or lifetime invalid")
	}
	if d.ManifestSHA256 != nil && (!digestRE.MatchString(*d.ManifestSHA256) || d.Hold) {
		return d, errors.New("invalid update digest or hold")
	}
	return d, nil
}

type diskState struct {
	Version        int     `json:"version"`
	WorkspaceID    string  `json:"workspaceId"`
	AgentID        string  `json:"agentId"`
	Kind           string  `json:"kind"`
	Revision       int64   `json:"revision"`
	Hold           bool    `json:"hold"`
	ManifestSHA256 *string `json:"manifestSha256"`
}

// Controller serializes acknowledged holds with staging. An already started
// stage completes before a hold is acknowledged; holds never suppress rollback.
type Controller struct {
	mu         sync.Mutex
	binding    Binding
	state      diskState
	path       string
	freshUntil time.Time
	wake       chan struct{}
	now        func() time.Time
}

func Open(stateDir string, binding Binding, now func() time.Time) (*Controller, error) {
	if stateDir == "" || binding.AgentID == "" || binding.WorkspaceID == "" || (binding.Kind != "runner" && binding.Kind != "machine") {
		return nil, errors.New("update control identity required")
	}
	if now == nil {
		now = time.Now
	}
	c := &Controller{binding: binding, path: filepath.Join(stateDir, "update", "control.json"), now: now, wake: make(chan struct{}, 1)}
	c.state = diskState{Version: 1, WorkspaceID: binding.WorkspaceID, AgentID: binding.AgentID, Kind: binding.Kind}
	raw, err := os.ReadFile(c.path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var state diskState
	if dec.Decode(&state) != nil || dec.Decode(new(any)) != io.EOF || state.Version != 1 || state.Revision < 0 || state.Revision > 2147483647 || (state.ManifestSHA256 != nil && (!digestRE.MatchString(*state.ManifestSHA256) || state.Hold)) {
		return nil, errors.New("update control state is corrupt")
	}
	if state.WorkspaceID != binding.WorkspaceID || state.AgentID != binding.AgentID || state.Kind != binding.Kind {
		return nil, errors.New("update control state belongs to another identity; operator must archive it before re-registration")
	}
	c.state = state
	// A restart requires fresh authenticated authority, even for an unheld row.
	return c, nil
}

func (c *Controller) Wake() <-chan struct{} { return c.wake }

func (c *Controller) Observe(compact string, keys *protocol.KeySet, nonce string) error {
	d, err := Verify(compact, keys, c.binding, nonce, c.now())
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.now().Before(time.Unix(d.ExpiresAt, 0)) {
		return errors.New("update directive expired while waiting for staging")
	}
	if d.Revision < c.state.Revision {
		return errors.New("update directive revision replay")
	}
	if d.Revision == c.state.Revision && (d.Hold != c.state.Hold || !sameDigest(d.ManifestSHA256, c.state.ManifestSHA256)) {
		return errors.New("update directive changed without a new revision")
	}
	next := diskState{Version: 1, WorkspaceID: d.WorkspaceID, AgentID: d.AgentID, Kind: d.Kind, Revision: d.Revision, Hold: d.Hold, ManifestSHA256: d.ManifestSHA256}
	if d.Revision != c.state.Revision {
		if err := save(c.path, next); err != nil {
			return err
		}
	}
	changed := d.Revision != c.state.Revision
	c.state = next
	c.freshUntil = time.Unix(d.ExpiresAt, 0)
	if changed {
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	return nil
}

func sameDigest(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// CheckAndStage reuses the established signature/digest/smoke/rollback manager.
// The transport binds the bytes to the human-reviewed envelope before release
// verification. The channel URL and release keys come only from local settings.
func (c *Controller) CheckAndStage(ctx context.Context, stateDir, component, running string, settings lifecycle.Settings, options lifecycle.ManagerOptions) (lifecycle.Outcome, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !settings.Enabled {
		return lifecycle.Outcome{Reason: "local updates are disabled"}, nil
	}
	if c.state.Hold {
		return lifecycle.Outcome{Reason: "control-plane update hold"}, nil
	}
	if !c.now().Before(c.freshUntil) {
		return lifecycle.Outcome{Reason: "fresh update authority is unavailable"}, nil
	}
	if c.state.ManifestSHA256 == nil {
		return lifecycle.Outcome{Reason: "no release requested by the control plane"}, nil
	}
	client := options.HTTPClient
	if client == nil {
		client = lifecycle.NewHTTPClient(nil)
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("update redirects refused; configure the final release URL locally")
	}
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	copyClient.Transport = &boundTransport{base: transport, url: settings.ManifestURL, sha: *c.state.ManifestSHA256}
	options.HTTPClient = &copyClient
	// Never stage past the short-lived directive's deadline.
	stageCtx, cancel := context.WithDeadline(ctx, c.freshUntil)
	defer cancel()
	return lifecycle.NewManager(stateDir, component, running, settings, options).CheckAndStage(stageCtx)
}

type boundTransport struct {
	base     http.RoundTripper
	url, sha string
}

func (t *boundTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if req.URL.String() != t.url || resp.StatusCode != http.StatusOK {
		return resp, nil
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, release.MaxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	if len(raw) > release.MaxManifestBytes || hex.EncodeToString(sum[:]) != t.sha {
		return nil, errors.New("release envelope differs from the requested digest")
	}
	resp.Body = io.NopCloser(bytes.NewReader(raw))
	return resp, nil
}

func save(path string, state diskState) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".control-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	raw, err := json.Marshal(state)
	if err == nil {
		err = f.Chmod(0600)
	}
	if err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	return syncDirectory(dir)
}
