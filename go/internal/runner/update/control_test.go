package update_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	lifecycle "github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
	control "github.com/GODOSTROYER/zenith/go/internal/runner/update"
)

func keys(t *testing.T) (ed25519.PrivateKey, *protocol.KeySet, protocol.KeyEntry) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	entry := protocol.KeyEntry{Kid: "cp", PublicKey: protocol.B64Encode(pub)}
	set, err := protocol.NewKeySet([]protocol.KeyEntry{entry})
	if err != nil {
		t.Fatal(err)
	}
	return priv, set, entry
}
func token(t *testing.T, priv ed25519.PrivateKey, d control.Directive, typ string) string {
	t.Helper()
	h, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": "cp", "typ": typ})
	p, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	input := protocol.B64Encode(h) + "." + protocol.B64Encode(p)
	return input + "." + protocol.B64Encode(ed25519.Sign(priv, []byte(input)))
}

var binding = control.Binding{WorkspaceID: "ws", AgentID: "agent", Kind: "machine"}

func directive(t *testing.T, at time.Time, revision int64, hold bool, sha *string) control.Directive {
	n, err := control.Nonce()
	if err != nil {
		t.Fatal(err)
	}
	return control.Directive{Schema: control.Schema, WorkspaceID: binding.WorkspaceID, AgentID: binding.AgentID, Kind: binding.Kind, Nonce: n, Revision: revision, Hold: hold, ManifestSHA256: sha, IssuedAt: at.Unix(), ExpiresAt: at.Unix() + 60}
}
func digest(raw []byte) string { s := sha256.Sum256(raw); return hex.EncodeToString(s[:]) }

func TestDirectiveRefusesWrongAuthorityAndBindings(t *testing.T) {
	priv, set, _ := keys(t)
	now := time.Now()
	base := directive(t, now, 1, true, nil)
	for _, tc := range []struct {
		name   string
		change func(*control.Directive)
		typ    string
	}{
		{"workspace", func(d *control.Directive) { d.WorkspaceID = "other" }, control.Type},
		{"agent", func(d *control.Directive) { d.AgentID = "other" }, control.Type},
		{"kind", func(d *control.Directive) { d.Kind = "runner" }, control.Type},
		{"nonce", func(d *control.Directive) { d.Nonce = "other" }, control.Type},
		{"expired", func(d *control.Directive) { d.ExpiresAt = now.Unix() }, control.Type},
		{"future", func(d *control.Directive) { d.IssuedAt = now.Unix() + 10 }, control.Type},
		{"long_life", func(d *control.Directive) { d.ExpiresAt = d.IssuedAt + 61 }, control.Type},
		{"negative_revision", func(d *control.Directive) { d.Revision = -1 }, control.Type},
		{"hold_digest", func(d *control.Directive) { s := strings.Repeat("a", 64); d.ManifestSHA256 = &s }, control.Type},
		{"bad_digest", func(d *control.Directive) { s := "invalid"; d.Hold = false; d.ManifestSHA256 = &s }, control.Type},
		{"domain", func(*control.Directive) {}, "zenith-job+jwt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := base
			tc.change(&d)
			if _, err := control.Verify(token(t, priv, d, tc.typ), set, binding, base.Nonce, now); err == nil {
				t.Fatal("accepted invalid directive")
			}
		})
	}
	other, _, _ := keys(t)
	if _, err := control.Verify(token(t, other, base, control.Type), set, binding, base.Nonce, now); err == nil {
		t.Fatal("accepted unpinned key")
	}
	if _, err := control.Verify(token(t, priv, base, control.Type), set, binding, base.Nonce, now); err != nil {
		t.Fatal(err)
	}
}

func TestHoldPersistsAndRevisionsCannotBeReplayed(t *testing.T) {
	priv, set, _ := keys(t)
	now := time.Now()
	dir := t.TempDir()
	c, err := control.Open(dir, binding, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	d := directive(t, now, 2, true, nil)
	if err = c.Observe(token(t, priv, d, control.Type), set, d.Nonce); err != nil {
		t.Fatal(err)
	}
	restarted, err := control.Open(dir, binding, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	out, err := restarted.CheckAndStage(context.Background(), dir, release.ComponentZenithd, "1.0.0", lifecycle.Settings{Enabled: true}, lifecycle.ManagerOptions{})
	if err != nil || out.Staged || out.Reason != "control-plane update hold" {
		t.Fatalf("hold: %+v %v", out, err)
	}
	replay := directive(t, now, 1, false, nil)
	if restarted.Observe(token(t, priv, replay, control.Type), set, replay.Nonce) == nil {
		t.Fatal("accepted old revision")
	}
	changed := directive(t, now, 2, false, nil)
	if restarted.Observe(token(t, priv, changed, control.Type), set, changed.Nonce) == nil {
		t.Fatal("accepted changed same revision")
	}
	changed.Revision = 3
	if err = restarted.Observe(token(t, priv, changed, control.Type), set, changed.Nonce); err != nil {
		t.Fatal(err)
	}
	foreign := binding
	foreign.AgentID = "new"
	if _, err = control.Open(dir, foreign, nil); err == nil {
		t.Fatal("accepted foreign local intent")
	}
}

func TestCorruptionAndPersistenceFailureDoNotGrantAuthority(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "update"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "update", "control.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := control.Open(dir, binding, nil); err == nil {
		t.Fatal("accepted corrupt local state")
	}
	dir = t.TempDir()
	c, err := control.Open(dir, binding, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "update"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	priv, set, _ := keys(t)
	d := directive(t, time.Now(), 1, false, nil)
	if c.Observe(token(t, priv, d, control.Type), set, d.Nonce) == nil {
		t.Fatal("published non-durable command")
	}
	out, err := c.CheckAndStage(context.Background(), dir, release.ComponentZenithd, "1.0.0", lifecycle.Settings{Enabled: true}, lifecycle.ManagerOptions{})
	if err != nil || out.Reason != "fresh update authority is unavailable" {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestFreshnessIsRequiredAfterRestartAndExpiry(t *testing.T) {
	priv, set, _ := keys(t)
	now := time.Now()
	dir := t.TempDir()
	c, err := control.Open(dir, binding, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	sha := digest([]byte("manifest"))
	d := directive(t, now, 1, false, &sha)
	if err = c.Observe(token(t, priv, d, control.Type), set, d.Nonce); err != nil {
		t.Fatal(err)
	}
	restarted, err := control.Open(dir, binding, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	for _, controller := range []*control.Controller{c, restarted} {
		out, err := controller.CheckAndStage(context.Background(), dir, release.ComponentZenithd, "1.0.0", lifecycle.Settings{Enabled: true}, lifecycle.ManagerOptions{})
		if err != nil || out.Staged || out.Reason != "fresh update authority is unavailable" {
			t.Fatalf("%+v %v", out, err)
		}
	}
}

func TestStageRequiresExactRequestedEnvelopeAndIndependentReleaseSignature(t *testing.T) {
	for _, bad := range []string{"none", "envelope_digest", "release_signature", "artifact_digest", "smoke", "redirect"} {
		t.Run(bad, func(t *testing.T) {
			priv, set, _ := keys(t)
			relPriv, _, relKey := keys(t)
			artifact := []byte("contract artifact, smoke is an injected test port")
			var raw []byte
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/manifest" {
					if bad == "redirect" {
						http.Redirect(w, r, "/redirected", http.StatusFound)
						return
					}
					w.Write(raw)
				} else {
					if bad == "artifact_digest" {
						w.Write([]byte("bad"))
					} else {
						w.Write(artifact)
					}
				}
			}))
			defer srv.Close()
			now := time.Now()
			mf := release.Manifest{Channel: "stable", Component: release.ComponentZenithd, Version: "1.1.0", Seq: 1, IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339), Artifacts: []release.Artifact{{OS: "linux", Arch: "amd64", URL: srv.URL + "/artifact", SHA256: digest(artifact), Size: int64(len(artifact))}}}
			if bad == "release_signature" {
				relPriv, _, _ = keys(t)
			}
			env, err := release.Sign(relPriv, "cp", mf)
			if err != nil {
				t.Fatal(err)
			}
			raw, err = json.Marshal(env)
			if err != nil {
				t.Fatal(err)
			}
			sha := digest(raw)
			if bad == "envelope_digest" {
				sha = digest([]byte("different"))
			}
			dir := t.TempDir()
			c, err := control.Open(dir, binding, nil)
			if err != nil {
				t.Fatal(err)
			}
			d := directive(t, now, 1, false, &sha)
			if err = c.Observe(token(t, priv, d, control.Type), set, d.Nonce); err != nil {
				t.Fatal(err)
			}
			smoke := func(context.Context, string, string, string) error {
				if bad == "smoke" {
					return errors.New("contract smoke failure")
				}
				return nil
			}
			out, err := c.CheckAndStage(context.Background(), dir, release.ComponentZenithd, "1.0.0", lifecycle.Settings{Enabled: true, ManifestURL: srv.URL + "/manifest", PublicKeys: []protocol.KeyEntry{relKey}}, lifecycle.ManagerOptions{GOOS: "linux", GOARCH: "amd64", Smoke: smoke})
			st, loadErr := lifecycle.NewStore(dir).Load()
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if bad == "none" {
				if err != nil || !out.Staged || st.Pending == nil {
					t.Fatalf("%+v %+v %v", out, st, err)
				}
			} else if err == nil || out.Staged || st.Active != nil {
				t.Fatalf("bad release staged: %+v %+v %v", out, st, err)
			}
		})
	}
}

func TestDisabledLocalUpdatesCannotBeEnabledRemotely(t *testing.T) {
	priv, set, _ := keys(t)
	dir := t.TempDir()
	c, err := control.Open(dir, binding, nil)
	if err != nil {
		t.Fatal(err)
	}
	sha := digest([]byte("release"))
	d := directive(t, time.Now(), 1, false, &sha)
	if err = c.Observe(token(t, priv, d, control.Type), set, d.Nonce); err != nil {
		t.Fatal(err)
	}
	out, err := c.CheckAndStage(context.Background(), dir, release.ComponentZenithd, "1.0.0", lifecycle.Settings{}, lifecycle.ManagerOptions{})
	if err != nil || out.Staged || out.Reason != "local updates are disabled" {
		t.Fatalf("%+v %v", out, err)
	}
}
