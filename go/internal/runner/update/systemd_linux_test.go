//go:build linux

package update_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	lifecycle "github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/release"
	control "github.com/GODOSTROYER/zenith/go/internal/runner/update"
)

// Protocol fixture only: real installed zenithd, artifacts, exec and PID 1.
// The separate PostgreSQL/API lane proves the control-plane implementation.
type fixturePlane struct {
	mu                 sync.Mutex
	priv               ed25519.PrivateKey
	signingKid         string
	next               protocol.KeyEntry
	registrationToken  string
	pub                ed25519.PublicKey
	nonces             map[string]bool
	consumed           bool
	revoked            bool
	revision           int64
	hold               bool
	sha                *string
	manifest, artifact []byte
	failVersion        string
	version            string
	controlRequests    int
}

func (p *fixturePlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	reply := func(v any) { w.Header().Set("Content-Type", "application/json"); json.NewEncoder(w).Encode(v) }
	refuse := func(status int, code string) {
		w.WriteHeader(status)
		reply(map[string]any{"error": map[string]string{"code": code}})
	}
	if r.URL.Path == "/manifest" {
		w.Write(p.manifest)
		return
	}
	if r.URL.Path == "/artifact" {
		w.Write(p.artifact)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		refuse(400, "invalid_body")
		return
	}
	if r.URL.Path == "/api/platform/v1/machines/register" {
		var body struct{ Token, PublicKey string }
		if json.Unmarshal(raw, &body) != nil || body.Token != p.registrationToken || p.consumed {
			refuse(401, "invalid_registration_token")
			return
		}
		pub, err := protocol.B64Decode(body.PublicKey)
		if err != nil || len(pub) != ed25519.PublicKeySize {
			refuse(400, "invalid_public_key")
			return
		}
		p.pub = pub
		p.consumed = true
		reply(map[string]any{"id": binding.AgentID, "workspaceId": binding.WorkspaceID, "protocol": protocol.MachineProtocol, "pollIntervalSec": 1, "controlPlaneKeys": []protocol.KeyEntry{p.next}})
		return
	}
	if p.revoked {
		refuse(401, "agent_revoked")
		return
	}
	if r.Header.Get(protocol.HeaderAgent) != binding.AgentID || protocol.VerifyRequest(p.pub, protocol.MachineProtocol, r.Method, r.URL.RequestURI(), raw, r.Header, time.Now()) != nil {
		refuse(401, "invalid_signature")
		return
	}
	n := r.Header.Get(protocol.HeaderNonce)
	if p.nonces[n] {
		refuse(401, "nonce_replayed")
		return
	}
	p.nonces[n] = true
	version := strings.TrimPrefix(r.Header.Get("User-Agent"), "zenith-machine/")
	if version == p.failVersion {
		refuse(503, "fixture_health_failure")
		return
	}
	switch r.URL.Path {
	case "/api/platform/v1/machines/agent/poll":
		reply(map[string]any{"jobs": []string{}, "pollIntervalSec": 1})
	case "/api/platform/v1/machines/agent/heartbeat":
		var body struct {
			Version string `json:"version"`
			Nonce   string `json:"updateControlNonce"`
		}
		if json.Unmarshal(raw, &body) != nil {
			refuse(400, "invalid_body")
			return
		}
		p.version = body.Version
		now := time.Now()
		d := control.Directive{Schema: control.Schema, WorkspaceID: binding.WorkspaceID, AgentID: binding.AgentID, Kind: binding.Kind, Nonce: body.Nonce, Revision: p.revision, Hold: p.hold, ManifestSHA256: p.sha, IssuedAt: now.Unix(), ExpiresAt: now.Unix() + 60}
		h, _ := json.Marshal(map[string]string{"alg": "EdDSA", "kid": p.signingKid, "typ": control.Type})
		b, _ := json.Marshal(d)
		input := protocol.B64Encode(h) + "." + protocol.B64Encode(b)
		compact := input + "." + protocol.B64Encode(ed25519.Sign(p.priv, []byte(input)))
		if body.Nonce != "" {
			p.controlRequests++
		}
		reply(map[string]any{"revoked": false, "pollIntervalSec": 1, "nextKeys": []protocol.KeyEntry{p.next}, "updateControl": compact})
	default:
		refuse(404, "not_found")
	}
}

func runSystemdAcceptance(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("fixture setup requires root inside the disposable guest; zenithd itself must be unprivileged")
	}
	if data, err := os.ReadFile("/proc/1/comm"); err != nil || strings.TrimSpace(string(data)) != "systemd" {
		t.Fatal("PID 1 is not real systemd")
	}
	root := os.Getenv("ZENITH_AGENT_UPDATE_REPO")
	out := os.Getenv("ZENITH_UPDATE_FIXTURE_OUT")
	if root == "" || out == "" {
		t.Fatal("set ZENITH_AGENT_UPDATE_REPO and ZENITH_UPDATE_FIXTURE_OUT")
	}
	baseline, err := os.ReadFile(filepath.Join(out, "zenithd-1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	newer, err := os.ReadFile(filepath.Join(out, "zenithd-1.1.0"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(baseline), "agent.update.control.v1") {
		t.Fatal("MACH-04 loop integration is missing from the actual installed binary")
	}
	bytes := make([]byte, 8)
	if _, err = rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	name := "zenith-mach04-" + hex.EncodeToString(bytes)
	stateDir := "/var/lib/" + name
	configDir := "/etc/" + name
	binDir := "/usr/local/lib/" + name
	unitPath := "/etc/systemd/system/" + name + ".service"
	for _, path := range []string{stateDir, configDir, binDir, unitPath} {
		if _, err := os.Lstat(path); !os.IsNotExist(err) {
			t.Fatal("fixture target already exists or is unreadable; refusing to touch it")
		}
	}
	run := func(cmd string, args ...string) string {
		t.Helper()
		b, err := exec.Command(cmd, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s failed: %v %s", cmd, err, b)
		}
		return string(b)
	}
	defer func() {
		stopErr := exec.Command("systemctl", "stop", name+".service").Run()
		statusErr := exec.Command("systemctl", "is-active", "--quiet", name+".service").Run()
		if statusErr == nil {
			t.Errorf("owned service still active; preserving fixture instead of deleting it")
			return
		}
		// stop may report failure when the unit never started; settled inactive is checked above.
		_ = stopErr
		for _, path := range []string{unitPath, stateDir, configDir, binDir} {
			if err := os.RemoveAll(path); err != nil {
				t.Errorf("owned cleanup: %v", err)
			}
		}
		if err := exec.Command("systemctl", "daemon-reload").Run(); err != nil {
			t.Errorf("cleanup reload: %v", err)
		}
	}()
	for _, dir := range []string{stateDir, configDir, binDir} {
		if err = os.Mkdir(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	run("chown", "zenithd:zenithd", stateDir)
	if err = os.Chmod(stateDir, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(binDir, "zenithd")
	if err = os.WriteFile(binary, baseline, 0755); err != nil {
		t.Fatal(err)
	}
	canary, err := os.ReadFile(filepath.Join(root, "deploy/zenithd/acceptance/cgroup-check.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(binDir, "cgroup-check.sh"), canary, 0755); err != nil {
		t.Fatal(err)
	}
	cpPriv, _, cpKey := keys(t)
	relPriv, _, relKey := keys(t)
	registrationToken, err := control.Nonce()
	if err != nil {
		t.Fatal(err)
	}
	p := &fixturePlane{priv: cpPriv, signingKid: cpKey.Kid, next: cpKey, registrationToken: registrationToken, nonces: map[string]bool{}, revision: 1, hold: true}
	server := httptest.NewServer(p)
	defer server.Close()
	publish := func(version string, seq int64, downgrade bool, artifact []byte) {
		t.Helper()
		now := time.Now()
		env, err := release.Sign(relPriv, relKey.Kid, release.Manifest{Channel: "stable", Component: release.ComponentZenithd, Version: version, Seq: seq, AllowDowngrade: downgrade, IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339), Artifacts: []release.Artifact{{OS: "linux", Arch: os.Getenv("ZENITH_AGENT_UPDATE_ARCH"), URL: server.URL + "/artifact", SHA256: digest(artifact), Size: int64(len(artifact))}}})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(env)
		if err != nil {
			t.Fatal(err)
		}
		sha := digest(raw)
		p.mu.Lock()
		p.manifest, p.artifact, p.sha = raw, artifact, &sha
		p.mu.Unlock()
	}
	publish("1.1.0", 1, false, newer)
	// Held directives carry no digest; publishing the channel alone grants nothing.
	p.mu.Lock()
	p.sha = nil
	p.mu.Unlock()
	cfg := agent.Common{ControlPlane: agent.ControlPlaneConfig{URL: server.URL}, StateDir: stateDir, Name: name, HeartbeatSec: 5, PollWaitSec: 1, MaxConcurrent: 1, ShutdownGraceSec: 5, Update: agent.UpdateConfig{Enabled: true, ManifestURL: server.URL + "/manifest", PublicKeys: []protocol.KeyEntry{relKey}, CheckIntervalSec: 60, HealthWindowSec: 30, MinStableSec: 5, MaxBoots: 3}}
	cfg.ApplyDefaults(stateDir)
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(configDir, "config.json")
	if err = os.WriteFile(config, raw, 0644); err != nil {
		t.Fatal(err)
	}
	tokenFile := filepath.Join(stateDir, "register-token")
	if err = os.WriteFile(tokenFile, []byte(registrationToken), 0600); err != nil {
		t.Fatal(err)
	}
	run("chown", "zenithd:zenithd", tokenFile)
	run("runuser", "-u", "zenithd", "--", binary, "--config", config, "register", "--token-file", tokenFile)
	if err = os.Remove(tokenFile); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(filepath.Join(root, "deploy/zenithd/zenithd.service"))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(unit), "/var/lib/zenithd", stateDir)
	text = strings.ReplaceAll(text, "/etc/zenithd/config.yaml", config)
	text = strings.ReplaceAll(text, "/usr/local/bin/zenithd", binary)
	text = strings.ReplaceAll(text, "StateDirectory=zenithd", "StateDirectory="+name)
	text = strings.ReplaceAll(text, "ExecStart=", "ExecStartPre="+binDir+"/cgroup-check.sh\nExecStart=")
	if err = os.WriteFile(unitPath, []byte(text), 0644); err != nil {
		t.Fatal(err)
	}
	run("systemctl", "daemon-reload")
	run("systemctl", "start", name+".service")
	wait := func(label string, timeout time.Duration, condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			if condition() {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		logs, _ := exec.Command("journalctl", "-u", name+".service", "--no-pager", "-n", "40").CombinedOutput()
		t.Fatalf("%s timed out: %s", label, logs)
	}
	wait("acknowledged hold and effective cgroup delegation", 30*time.Second, func() bool {
		raw, err := os.ReadFile(filepath.Join(stateDir, "update", "control.json"))
		proof, err2 := os.ReadFile(filepath.Join(stateDir, "delegation-proof"))
		var d struct {
			Hold     bool
			Revision int64
		}
		return err == nil && err2 == nil && json.Unmarshal(raw, &d) == nil && d.Hold && d.Revision == 1 && strings.Contains(string(proof), "verified")
	})
	time.Sleep(65 * time.Second) // exceeds the old autonomous loop's initial check window
	st, err := lifecycle.NewStore(stateDir).Load()
	if err != nil || st.Active != nil {
		t.Fatalf("hold did not prevent swap: %+v %v", st, err)
	}
	p.mu.Lock()
	sha := digest(p.manifest)
	p.sha = &sha
	p.hold = false
	p.revision = 2
	p.mu.Unlock()
	wait("verified update health commit", 90*time.Second, func() bool {
		st, err := lifecycle.NewStore(stateDir).Load()
		return err == nil && st.Active != nil && st.Active.Version == "1.1.0" && st.Pending == nil
	})
	p.mu.Lock()
	p.version = ""
	p.mu.Unlock()
	run("systemctl", "restart", name+".service")
	wait("restart retains committed version", 30*time.Second, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.version == "1.1.0" })
	// Announce a new control-plane trust key before using it for directives.
	nextPriv, _, nextKey := keys(t)
	nextKey.Kid = "cp-rotated"
	p.mu.Lock()
	p.next = nextKey
	p.mu.Unlock()
	wait("durable customer trust rotation", 30*time.Second, func() bool {
		id, err := agent.LoadIdentity(stateDir, agent.MachineKind)
		if err != nil {
			return false
		}
		for _, key := range id.ControlPlaneKeys {
			if key.Kid == nextKey.Kid && key.PublicKey == nextKey.PublicKey {
				return true
			}
		}
		return false
	})
	p.mu.Lock()
	p.priv = nextPriv
	p.signingKid = nextKey.Kid
	p.mu.Unlock()
	publish("1.0.0", 2, true, baseline)
	p.mu.Lock()
	p.failVersion = "1.0.0"
	p.revision = 3
	p.mu.Unlock()
	wait("failed health automatically rolls signed downgrade back", 120*time.Second, func() bool {
		st, err := lifecycle.NewStore(stateDir).Load()
		return err == nil && st.Active != nil && st.Active.Version == "1.1.0" && st.Pending == nil && st.RolledBackFrom == "1.0.0"
	})
	p.mu.Lock()
	p.failVersion = ""
	p.revoked = true
	p.mu.Unlock()
	wait("revocation stops restart loop", 30*time.Second, func() bool {
		return exec.Command("systemctl", "is-active", "--quiet", name+".service").Run() != nil && agent.IsRevokedLocally(stateDir, binding.AgentID)
	})
	t.Log("PASS: actual installed signed registration, held channel, update commit/restart, trust rotation, failed-health automatic rollback, revocation and delegated unprivileged cgroup writes; control-plane server is a protocol fixture")
}
