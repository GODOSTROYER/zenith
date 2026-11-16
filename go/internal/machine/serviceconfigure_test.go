package machine_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

func serviceProfile(t *testing.T, base string, unit string) (ops.ServiceConfigureConfig, ops.ServiceConfigureProfile) {
	t.Helper()
	p := ops.ServiceConfigureProfile{Unit: unit, ProfileRef: "app-config", Path: filepath.Join(base, "app", "app.env"), SourcePath: filepath.Join(base, "templates", "app.env"), SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024, Action: "restart", SettleSec: 5}
	c := ops.ServiceConfigureConfig{Enabled: true, BackupDir: filepath.Join(base, "backups"), MaxBackupBytes: 4096, MaxBackups: 4}
	v, err := ops.ServiceConfigureProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	p.ProfileVersion = v
	c.Profiles = []ops.ServiceConfigureProfile{p}
	return c, p
}

func serviceConfigPath(t *testing.T, r *mrig, c ops.ServiceConfigureConfig, restart []string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"controlPlane": map[string]string{"url": r.fake.URL}, "tls": map[string]string{"caFile": r.fake.CAFile(r.dir)}, "name": "vm-1", "stateDir": r.state, "pollWaitSec": 0, "shutdownGraceSec": 5,
		"services": map[string]any{"restartAllow": restart}, "serviceConfigure": c,
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(r.dir, "zenithd-service.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestServiceConfigureConfigLoadingAndVersionsCLI(t *testing.T) {
	r := newMRig(t)
	c, p := serviceProfile(t, r.dir, "app.service")
	path := serviceConfigPath(t, r, c, []string{"app.service"})
	cfg, err := machine.LoadConfig(path, r.getenv)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ServiceConfigure.Enabled || len(cfg.ServiceConfigure.Profiles) != 1 {
		t.Fatal("valid service profile was not loaded")
	}
	var out, errOut bytes.Buffer
	if code := machine.Main([]string{"service-configure-versions", "--config", path}, &out, &errOut, r.getenv); code != agent.ExitOK {
		t.Fatalf("metadata-only CLI failed: %s", errOut.String())
	}
	if !strings.Contains(out.String(), p.ProfileVersion) || strings.Contains(out.String(), p.SourcePath) || strings.Contains(out.String(), p.SHA256) || strings.Contains(out.String(), p.Path) {
		t.Fatal("CLI must expose unit/ref/version only, without local paths or source hash")
	}
	// the unit must already be inside the machine's restart authority
	if _, err := machine.LoadConfig(serviceConfigPath(t, r, c, []string{"other.service"}), r.getenv); err == nil {
		t.Fatal("profile outside services.restartAllow was loaded")
	}
	// a reused or stale version is refused at load
	bad := c
	bad.Profiles = []ops.ServiceConfigureProfile{p}
	bad.Profiles[0].ProfileVersion = strings.Repeat("e", 64)
	if _, err := machine.LoadConfig(serviceConfigPath(t, r, bad, []string{"app.service"}), r.getenv); err == nil {
		t.Fatal("arbitrary profile version was accepted")
	}
	if code := machine.Main([]string{"service-configure-versions", "--config", "relative.yaml"}, &out, &errOut, r.getenv); code != agent.ExitUsage {
		t.Fatal("relative config path accepted")
	}
}

func TestServiceConfigureVerifyRequiresResourceGrantAndRefusesForeignConstraints(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("service.configure is only enabled on Linux; the refusal is covered by the ops unit tests elsewhere")
	}
	r := newMRig(t)
	c, p := serviceProfile(t, r.dir, "app.service")
	cfg, err := machine.LoadConfig(serviceConfigPath(t, r, c, []string{"app.service"}), r.getenv)
	if err != nil {
		t.Fatal(err)
	}
	audit, err := machine.OpenAudit(filepath.Join(r.dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	cp := protocoltest.New("cp-x")
	id := &agent.Identity{ID: "mac_e2e", WorkspaceID: "ws_e2e"}
	ex, err := machine.NewExecutor(cfg, id, cp.KeySet(), protocol.NewMemoryReplayCache(nil), audit, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), machine.Deps{Runner: r.runner})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(ex.Capabilities(), ","), ops.OpServiceConfigure) {
		t.Fatal("an enabled exact profile with restart authority must advertise service.configure")
	}
	sequence := 0
	signed := func(args map[string]any, maxOut int64, mutate func(*protocol.GrantClaims)) string {
		t.Helper()
		sequence++
		now := cp.Now()
		operationID := fmt.Sprintf("service_operation_%d", sequence)
		grant := protocol.GrantClaims{JTI: fmt.Sprintf("service_grant_%d", sequence), ISS: "zenith-control-plane", AUD: "machine:mac_e2e", SUB: "user_test", IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), CAP: ops.OpServiceConfigure, OP: operationID, Digest: "sha256:test", WS: "ws_e2e", Res: "resource:app", Constraints: map[string]any{"maxOutputBytes": 4096}}
		if mutate != nil {
			mutate(&grant)
		}
		raw, _ := json.Marshal(args)
		envelope := protocol.MachineEnvelope{Protocol: protocol.MachineProtocol, JTI: fmt.Sprintf("service_request_%d", sequence), MachineID: "mac_e2e", WorkspaceID: "ws_e2e", OperationID: operationID, Operation: ops.OpServiceConfigure, Args: raw, Grant: cp.Sign(protocol.TypGrant, grant), IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), TimeoutSec: 30, MaxOutputBytes: maxOut}
		return cp.Sign(protocol.TypMachine, envelope)
	}
	good := map[string]any{"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "expectedSha256": nil}
	refuse := func(name, token, code string) {
		t.Helper()
		job, rej := ex.Verify(context.Background(), token)
		if job != nil || rej == nil || rej.Code != code {
			t.Fatalf("%s: want rejection %s, got job=%v rej=%v", name, code, job, rej)
		}
	}
	refuse("grant without a resource", signed(good, 4096, func(g *protocol.GrantClaims) { g.Res = "" }), protocol.CodeConstraint)
	refuse("path constraint has no meaning here", signed(good, 4096, func(g *protocol.GrantClaims) {
		g.Constraints = map[string]any{"pathPrefixes": []any{filepath.Dir(p.Path)}}
	}), protocol.CodeConstraint)
	refuse("foreign constraint", signed(good, 4096, func(g *protocol.GrantClaims) { g.Constraints = map[string]any{"maxLines": float64(3)} }), protocol.CodeConstraint)
	refuse("inadequate metadata budget", signed(good, 1024, nil), protocol.CodeConstraint)
	refuse("protected unit", signed(map[string]any{"unit": "sshd.service", "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "expectedSha256": nil}, 4096, nil), protocol.CodeInvalidPayload)
	refuse("path smuggled into the envelope", signed(map[string]any{"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "expectedSha256": nil, "path": "/etc/passwd"}, 4096, nil), protocol.CodeInvalidPayload)
	refuse("version of another profile", signed(map[string]any{"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": strings.Repeat("d", 64), "expectedSha256": nil}, 4096, nil), protocol.CodeNotAllowed)
	if r.runner.count() != 0 {
		t.Fatal("a refused request touched systemd")
	}
	job, rej := ex.Verify(context.Background(), signed(good, 4096, func(g *protocol.GrantClaims) {
		g.Constraints = map[string]any{"maxTimeoutSec": float64(60), "maxOutputBytes": float64(4096)}
	}))
	if job == nil {
		t.Fatalf("an exact approved request was refused: %v", rej)
	}
}

func TestServiceConfigureDefaultsOffNotAdvertisedAndRefused(t *testing.T) {
	r := newMRig(t)
	cfg, err := machine.LoadConfig(r.cfgPath, r.getenv)
	if err != nil {
		t.Fatal(err)
	}
	audit, err := machine.OpenAudit(filepath.Join(r.dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer audit.Close()
	cp := protocoltest.New("cp-x")
	id := &agent.Identity{ID: "mac_e2e", WorkspaceID: "ws_e2e"}
	ex, err := machine.NewExecutor(cfg, id, cp.KeySet(), protocol.NewMemoryReplayCache(nil), audit, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), machine.Deps{Runner: r.runner})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(ex.Capabilities(), ","), ops.OpServiceConfigure) {
		t.Fatal("service.configure advertised by default")
	}
	_, tok := cp.Machine(protocoltest.MachineSpec{MachineID: "mac_e2e", WorkspaceID: "ws_e2e", Operation: ops.OpServiceConfigure, Args: map[string]any{}})
	if job, rej := ex.Verify(context.Background(), tok); job != nil || rej == nil || rej.Code != protocol.CodeDisabledByConfig {
		t.Fatalf("a disabled operation must be refused: %v %v", job, rej)
	}
	if r.runner.count() != 0 {
		t.Fatal("a refused request touched systemd")
	}
}
