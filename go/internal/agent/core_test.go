package agent_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/agent/fakecp"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

func TestBackoffGrowsJittersAndCaps(t *testing.T) {
	b := agent.NewBackoff()
	b.Rand = func() float64 { return 0 } // lower bound of the jitter
	var lows []time.Duration
	for i := 0; i < 9; i++ {
		lows = append(lows, b.Next())
	}
	want := []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second}
	for i := range want {
		if lows[i] != want[i] {
			t.Fatalf("step %d: %s, want %s (all: %v)", i, lows[i], want[i], lows)
		}
	}
	b.Reset()
	b.Rand = func() float64 { return 0.999999 } // upper bound
	if d := b.Next(); d < 990*time.Millisecond || d > time.Second {
		t.Fatalf("first upper-bound delay %s", d)
	}
	for i := 0; i < 20; i++ {
		if d := b.Next(); d > 60*time.Second {
			t.Fatalf("delay %s exceeds the 60s cap", d)
		}
	}
	// default randomness stays within [step/2, step]
	b2 := agent.NewBackoff()
	for i := 0; i < 50; i++ {
		d := b2.Next()
		if d < 500*time.Millisecond || d > 60*time.Second {
			t.Fatalf("delay %s out of range", d)
		}
	}
}

func testCommon(t *testing.T) *agent.Common {
	t.Helper()
	c := &agent.Common{ControlPlane: agent.ControlPlaneConfig{URL: "https://zenith.example.com"}}
	c.ApplyDefaults(t.TempDir())
	return c
}

func TestConfigValidation(t *testing.T) {
	good := testCommon(t)
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(c *agent.Common){
		"missing url":            func(c *agent.Common) { c.ControlPlane.URL = "" },
		"plain http remote":      func(c *agent.Common) { c.ControlPlane.URL = "http://zenith.example.com" },
		"userinfo":               func(c *agent.Common) { c.ControlPlane.URL = "https://u:p@zenith.example.com" },
		"query":                  func(c *agent.Common) { c.ControlPlane.URL = "https://zenith.example.com/?x=1" },
		"ftp":                    func(c *agent.Common) { c.ControlPlane.URL = "ftp://zenith.example.com" },
		"cert without key":       func(c *agent.Common) { c.TLS.ClientCert = "/c.pem" },
		"bad name":               func(c *agent.Common) { c.Name = "bad name!" },
		"bad log level":          func(c *agent.Common) { c.Log.Level = "verbose" },
		"poll wait too long":     func(c *agent.Common) { c.PollWaitSec = 26 },
		"heartbeat too frequent": func(c *agent.Common) { c.HeartbeatSec = 1 },
		"zero concurrency":       func(c *agent.Common) { c.MaxConcurrent = -1 },
		"huge result":            func(c *agent.Common) { c.MaxResultBytes = 1 << 30 },
		"too many labels": func(c *agent.Common) {
			c.Labels = map[string]string{}
			for i := 0; i < 21; i++ {
				c.Labels[string(rune('a'+i))] = "x"
			}
		},
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			c := testCommon(t)
			mut(c)
			if err := c.Validate(); err != nil {
				return
			}
			t.Fatal("expected a validation error")
		})
	}
	for _, u := range []string{"http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000", "https://zenith.example.com/prefix"} {
		c := testCommon(t)
		c.ControlPlane.URL = u
		if err := c.Validate(); err != nil {
			t.Errorf("%s should be accepted: %v", u, err)
		}
	}
}

func TestConfigEnvOverridesAndDefaults(t *testing.T) {
	c := &agent.Common{}
	c.ApplyDefaults("/var/lib/x")
	env := map[string]string{
		"ZENITH_CONTROL_PLANE_URL": "https://cp.example.com", "ZENITH_STATE_DIR": "/data", "ZENITH_AGENT_NAME": "edge-1", "ZENITH_LOG_LEVEL": "debug",
		"ZENITH_TLS_CA_FILE": "/ca.pem", "ZENITH_POLL_WAIT_SEC": "10", "ZENITH_REGISTRATION_TOKEN_FILE": "/run/token",
	}
	c.ApplyEnv(func(k string) string { return env[k] })
	if c.ControlPlane.URL != "https://cp.example.com" || c.StateDir != "/data" || c.Name != "edge-1" || c.Log.Level != "debug" || c.TLS.CAFile != "/ca.pem" || c.PollWaitSec != 10 || c.Registration.TokenFile != "/run/token" {
		t.Fatalf("%+v", c)
	}
	if c.HeartbeatSec != 30 || c.MaxConcurrent != 4 || c.MaxResultBytes != 4<<20 || c.ShutdownGraceSec != 30 {
		t.Fatalf("defaults: %+v", c)
	}
}

type sampleConfig struct {
	agent.Common
	Extra struct {
		Allow []string `json:"allow"`
	} `json:"extra"`
}

func TestLoadFileAcceptsJSONAndYAMLAndRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	yamlDoc := `# runner config
controlPlane:
  url: https://zenith.example.com
stateDir: /var/lib/zenith-runner
labels:
  region: ap-south-1
  team: "platform"
extra:
  allow:
    - "ec2:Describe*"
    - s3:GET /bucket/**
pollWaitSec: 20
`
	jsonDoc := `{"controlPlane":{"url":"https://zenith.example.com"},"stateDir":"/var/lib/zenith-runner","labels":{"region":"ap-south-1","team":"platform"},"extra":{"allow":["ec2:Describe*","s3:GET /bucket/**"]},"pollWaitSec":20}`
	for name, doc := range map[string]string{"c.yaml": yamlDoc, "c.json": jsonDoc, "noext": yamlDoc} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(doc), 0o600); err != nil {
			t.Fatal(err)
		}
		var c sampleConfig
		if err := agent.LoadFile(p, &c); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ControlPlane.URL != "https://zenith.example.com" || c.Labels["team"] != "platform" || len(c.Extra.Allow) != 2 || c.Extra.Allow[1] != "s3:GET /bucket/**" || c.PollWaitSec != 20 {
			t.Fatalf("%s: %+v", name, c)
		}
	}
	bad := map[string]string{
		"unknown top-level field": `{"controlPlane":{"url":"https://x"},"polWaitSec":1}`,
		"unknown nested field":    "controlPlane:\n  url: https://x\n  usr: y\n",
		"trailing content":        `{"controlPlane":{"url":"https://x"}} {"a":1}`,
		"wrong type":              `{"pollWaitSec":"twenty"}`,
		"yaml anchor":             "stateDir: &a /x\n",
		"yaml tab indentation":    "controlPlane:\n\turl: https://x\n",
		"yaml duplicate key":      "name: a\nname: b\n",
		"yaml block scalar":       "name: |\n  text\n",
		"yaml second document":    "name: a\n---\nname: b\n",
		"empty":                   "",
	}
	for name, doc := range bad {
		var c sampleConfig
		if err := agent.DecodeConfig([]byte(doc), "x.yaml", &c); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if err := agent.DecodeConfig(make([]byte, 2<<20), "x.json", &sampleConfig{}); err == nil {
		t.Error("a config larger than 1 MiB must be refused")
	}
}

func TestRegistrationHappyPathStoresIdentityPrivately(t *testing.T) {
	r := newRig(t, nil)
	path := filepath.Join(r.cfg.StateDir, agent.IdentityFileName)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("identity file mode %o, want 600", st.Mode().Perm())
	}
	if st2, _ := os.Stat(r.cfg.StateDir); runtime.GOOS != "windows" && st2.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode %o, want 700", st2.Mode().Perm())
	}
	id, err := agent.LoadIdentity(r.cfg.StateDir, agent.RunnerKind)
	if err != nil {
		t.Fatal(err)
	}
	if id.ID != "run_e2e" || id.WorkspaceID != "ws_e2e" || len(id.ControlPlaneKeys) != 1 || id.ControlPlaneKeys[0].Kid != "cp-e2e" {
		t.Fatalf("%v", id)
	}
	if strings.Contains(id.String(), id.PrivateKey) {
		t.Fatal("the identity must not print its private key")
	}
	priv, _ := id.PrivateKeyBytes()
	pub, _ := protocol.B64Decode(id.PublicKey)
	if !priv.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(pub)) {
		t.Fatal("key pair mismatch")
	}
}

func TestRegistrationTokenIsSingleUseAndNeverLeaks(t *testing.T) {
	r := newRig(t, nil)
	other := *r.cfg
	other.StateDir = t.TempDir()
	_, err := agent.Register(context.Background(), &other, agent.RegisterOptions{Kind: agent.RunnerKind, Token: r.fake.Token, Version: "t", UserAgent: "t"})
	if err == nil {
		t.Fatal("a consumed registration token must be refused")
	}
	if strings.Contains(err.Error(), r.fake.Token) {
		t.Fatalf("the token must never appear in errors: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(other.StateDir, agent.IdentityFileName)); statErr == nil {
		t.Fatal("a failed registration must not leave an identity behind")
	}
	// re-registering over an existing identity needs --force
	_, err = agent.Register(context.Background(), r.cfg, agent.RegisterOptions{Kind: agent.RunnerKind, Token: "zrt_new", Version: "t", UserAgent: "t"})
	if err == nil || !strings.Contains(err.Error(), "already registered") {
		t.Fatalf("%v", err)
	}
	if _, err := agent.Register(context.Background(), r.cfg, agent.RegisterOptions{Kind: agent.RunnerKind, Token: "", Version: "t", UserAgent: "t"}); err == nil {
		t.Fatal("an empty token must be refused")
	}
}

func TestIdentityFileMustBePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	r := newRig(t, nil)
	path := filepath.Join(r.cfg.StateDir, agent.IdentityFileName)
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := agent.LoadIdentity(r.cfg.StateDir, agent.RunnerKind); err == nil || !strings.Contains(err.Error(), "insecure permissions") {
		t.Fatalf("a world-readable identity must be refused: %v", err)
	}
	_ = os.Chmod(path, 0o600)
	if _, err := agent.LoadIdentity(r.cfg.StateDir, agent.MachineKind); err == nil {
		t.Fatal("a runner identity must not load as a machine identity")
	}
	if _, err := agent.LoadIdentity(t.TempDir(), agent.RunnerKind); !errors.Is(err, agent.ErrNoIdentity) {
		t.Fatalf("%v", err)
	}
	// tampering with the key pair is detected
	raw, _ := os.ReadFile(path)
	var id agent.Identity
	_ = json.Unmarshal(raw, &id)
	id.PublicKey = protocol.B64Encode(make([]byte, 32))
	raw, _ = json.Marshal(id)
	_ = os.WriteFile(path, raw, 0o600)
	if _, err := agent.LoadIdentity(r.cfg.StateDir, agent.RunnerKind); err == nil {
		t.Fatal("a mismatched public key must be detected")
	}
}

func TestRotationIdentityPersistenceUsesPrivateExclusiveReplacement(t *testing.T) {
	r := newRig(t, nil)
	oldTemp := filepath.Join(r.cfg.StateDir, agent.IdentityFileName+".tmp")
	sentinel := "existing predictable temporary path must remain unchanged"
	if err := os.WriteFile(oldTemp, []byte(sentinel), 0o644); err != nil {
		t.Fatal("could not prepare predictable-path persistence fixture")
	}
	if err := agent.SaveIdentity(r.cfg.StateDir, r.id); err != nil {
		t.Fatal("private identity replacement failed")
	}
	untouched, err := os.ReadFile(oldTemp)
	if err != nil || string(untouched) != sentinel {
		t.Fatal("identity persistence must not reuse or truncate a predictable temporary path")
	}
	st, err := os.Stat(filepath.Join(r.cfg.StateDir, agent.IdentityFileName))
	if err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o600) {
		t.Fatal("replacement identity must remain a private file")
	}
	if _, err := agent.LoadIdentity(r.cfg.StateDir, agent.RunnerKind); err != nil {
		t.Fatal("replacement identity must remain valid on restart")
	}
	if leftovers, err := filepath.Glob(filepath.Join(r.cfg.StateDir, ".identity-*.tmp")); err != nil || len(leftovers) != 0 {
		t.Fatal("successful persistence must remove its exclusive temporary file")
	}
}

func TestRotationIdentityPersistenceDoesNotFollowPredictableTempSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink fixture")
	}
	r := newRig(t, nil)
	target := filepath.Join(t.TempDir(), "unrelated.txt")
	sentinel := "unrelated file must not receive identity contents"
	if err := os.WriteFile(target, []byte(sentinel), 0o600); err != nil {
		t.Fatal("could not prepare unrelated persistence fixture")
	}
	oldTemp := filepath.Join(r.cfg.StateDir, agent.IdentityFileName+".tmp")
	if err := os.Symlink(target, oldTemp); err != nil {
		t.Fatal("could not prepare predictable temporary symlink")
	}
	if err := agent.SaveIdentity(r.cfg.StateDir, r.id); err != nil {
		t.Fatal("exclusive identity replacement failed")
	}
	untouched, err := os.ReadFile(target)
	if err != nil || string(untouched) != sentinel {
		t.Fatal("identity persistence followed a predictable temporary symlink")
	}
	st, err := os.Lstat(oldTemp)
	if err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("identity replacement must leave unrelated existing paths untouched")
	}
}

func TestClientTLSVerificationAndRedirects(t *testing.T) {
	// A server with a certificate the agent does not trust must be refused.
	untrusted := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer untrusted.Close()
	tlsCfg, _ := agent.BuildTLS(agent.TLSConfig{})
	c, _ := agent.NewClient(untrusted.URL, agent.NewHTTPClient(tlsCfg), nil, "", protocol.RunnerProtocol, "t", nil)
	if _, err := c.Do(context.Background(), http.MethodPost, "/x", map[string]any{}, nil, 5*time.Second, 1<<10); err == nil {
		t.Fatal("an untrusted server certificate must fail verification")
	}

	// A pinned CA that does not match is refused as well.
	fake := fakecp.New(t, "runners", protocol.RunnerProtocol)
	other := fakecp.New(t, "runners", protocol.RunnerProtocol)
	wrongCA := other.CAFile(t.TempDir())
	tlsCfg, err := agent.BuildTLS(agent.TLSConfig{CAFile: wrongCA})
	if err != nil {
		t.Fatal(err)
	}
	c, _ = agent.NewClient(fake.URL, agent.NewHTTPClient(tlsCfg), nil, "", protocol.RunnerProtocol, "t", nil)
	if _, err := c.Do(context.Background(), http.MethodPost, "/x", map[string]any{}, nil, 5*time.Second, 1<<10); err == nil {
		t.Fatal("a server not signed by the pinned CA must be refused")
	}
	if _, err := agent.BuildTLS(agent.TLSConfig{CAFile: "/nonexistent.pem"}); err == nil {
		t.Fatal("a missing CA file must be an error")
	}
	bad := filepath.Join(t.TempDir(), "junk.pem")
	_ = os.WriteFile(bad, []byte("not a certificate"), 0o600)
	if _, err := agent.BuildTLS(agent.TLSConfig{CAFile: bad}); err == nil {
		t.Fatal("a CA file without certificates must be an error")
	}
	if cfg, _ := agent.BuildTLS(agent.TLSConfig{}); cfg.MinVersion < 0x0303 || cfg.InsecureSkipVerify {
		t.Fatal("TLS 1.2 minimum and verification always on")
	}

	// Redirects are never followed: a signed request must not be replayed elsewhere.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("the redirect target was contacted") }))
	defer target.Close()
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redir.Close()
	c, _ = agent.NewClient(redir.URL, agent.NewHTTPClient(nil), nil, "", protocol.RunnerProtocol, "t", nil)
	status, err := c.Do(context.Background(), http.MethodPost, "/x", map[string]any{}, nil, 5*time.Second, 1<<10)
	if err == nil || status != http.StatusTemporaryRedirect {
		t.Fatalf("a redirect must surface as an error, got status %d err %v", status, err)
	}
}

func TestClientResponseSizeCapAndErrorParsing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/big":
			_, _ = w.Write([]byte(strings.Repeat("a", 4096)))
		case "/shapes1":
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":"already_settled"}`))
		case "/shapes2":
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"code":"bad_thing","message":"details"}}`))
		case "/shapes3":
			w.WriteHeader(422)
			_, _ = w.Write([]byte(`{"code":"c3"}`))
		case "/revoked":
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"agent_revoked"}`))
		case "/unauth":
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"clock_skew"}`))
		}
	}))
	defer srv.Close()
	c, _ := agent.NewClient(srv.URL, agent.NewHTTPClient(nil), nil, "", protocol.RunnerProtocol, "t", nil)
	ctx := context.Background()
	if _, err := c.Do(ctx, "GET", "/big", nil, nil, time.Second, 100); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("%v", err)
	}
	for path, code := range map[string]string{"/shapes1": "already_settled", "/shapes2": "bad_thing", "/shapes3": "c3"} {
		_, err := c.Do(ctx, "GET", path, nil, nil, time.Second, 1<<10)
		var he *agent.HTTPError
		if !errors.As(err, &he) || he.Code != code {
			t.Errorf("%s: %v", path, err)
		}
	}
	if _, err := c.Do(ctx, "GET", "/revoked", nil, nil, time.Second, 1<<10); !errors.Is(err, agent.ErrRevoked) {
		t.Fatalf("%v", err)
	}
	if _, err := c.Do(ctx, "GET", "/unauth", nil, nil, time.Second, 1<<10); errors.Is(err, agent.ErrRevoked) {
		t.Fatal("only agent_revoked is terminal; other 401s (clock skew, ...) are retryable")
	}
}
