//go:build linux && zenith_systemd_acceptance

package machine_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

const nativeSignedUnit = "zenith-mach01-configure-fixture.service"
const nativeSignedRoot = "/opt/zenith-file-write-tests"
const nativeSignedMarker = nativeSignedRoot + "/.mach01-systemd-executor-active"

func nativeSignedScope(t *testing.T) string {
	t.Helper()
	if os.Getenv("ZENITH_TEST_SERVICE_CONFIGURE_SYSTEMD") != "1" || os.Getenv("ZENITH_FILE_WRITE_TEST_ROOT") != nativeSignedRoot || os.Geteuid() == 0 || os.Getegid() == 0 || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(os.Getenv("ZENITH_GUEST_FIXTURE_RUN_ID")) {
		t.Fatal("explicit signed systemd acceptance requires an owned unprivileged fixture")
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal("cannot prove unprivileged test process")
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(status), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			fields[k] = strings.TrimSpace(v)
		}
	}
	for _, name := range []string{"CapEff", "CapPrm", "CapInh", "CapAmb"} {
		if fields[name] != "0000000000000000" {
			t.Fatal("signed native service test must have no process capabilities")
		}
	}
	if fields["NoNewPrivs"] != "1" {
		t.Fatal("signed native service test requires no-new-privileges")
	}
	helper, err := filepath.Abs("../../../scripts/ci/service-configure-systemd-fixtures.py")
	if err != nil {
		t.Fatal("cannot resolve reviewed fixture helper")
	}
	check := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if exec.CommandContext(ctx, "/usr/bin/python3", helper, "check", strconv.Itoa(os.Geteuid()), strconv.Itoa(os.Getegid()), os.Getenv("ZENITH_GUEST_FIXTURE_RUN_ID")).Run() != nil {
			t.Fatal("root-owned systemd fixture custody check refused")
		}
	}
	check()
	fd, err := syscall.Open("/opt/zenith-file-write-mounts/.mach01-systemd-lease", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal("missing exact systemd fixture lease")
	}
	lease := os.NewFile(uintptr(fd), "systemd-fixture-lease")
	if syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		lease.Close()
		t.Fatal("another native test owns the inert unit")
	}
	check()
	marker, err := os.OpenFile(nativeSignedMarker, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		lease.Close()
		t.Fatal("unsettled earlier signed test remains retained")
	}
	data := os.Getenv("ZENITH_GUEST_FIXTURE_RUN_ID") + "\n"
	written, writeErr := marker.WriteString(data)
	syncErr, closeErr := marker.Sync(), marker.Close()
	if written != len(data) || writeErr != nil || syncErr != nil || closeErr != nil {
		lease.Close()
		t.Fatal("cannot persist signed native test lifetime")
	}
	base, err := os.MkdirTemp(nativeSignedRoot, "mach01-systemd-executor-")
	if err != nil {
		lease.Close()
		t.Fatal("cannot create protected signed test custody")
	}
	t.Cleanup(func() {
		defer func() {
			if lease.Close() != nil {
				t.Error("signed native fixture lease close failed")
			}
			if !t.Failed() && os.Remove(nativeSignedMarker) != nil {
				t.Error("cannot retire signed native test lifetime")
			}
		}()
		if !t.Failed() {
			nativeSignedInvocation(t)
			if os.RemoveAll(base) != nil {
				t.Error("signed local teardown failed; retain native fixture")
			}
		}
	})
	for _, name := range []string{"app", "templates", "backups", "state"} {
		if os.Mkdir(filepath.Join(base, name), 0700) != nil {
			t.Fatal("cannot create disjoint signed local custody")
		}
	}
	return base
}

func nativeSignedInvocation(t *testing.T) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "/usr/bin/systemctl", "show", "--all", "--no-pager", "--property=LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,Job", "--", nativeSignedUnit).Output()
	if err != nil {
		t.Fatal("actual signed systemd observation did not settle")
	}
	rows := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		_, duplicate := rows[key]
		if !ok || duplicate || !strings.Contains(",LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,Job,", ","+key+",") {
			t.Fatal("malformed actual signed systemd observation")
		}
		rows[key] = value
	}
	if len(rows) != 7 || rows["LoadState"] != "loaded" || rows["FragmentPath"] != "/run/systemd/system/"+nativeSignedUnit || rows["ActiveState"] != "active" || rows["SubState"] != "exited" || rows["MainPID"] != "0" || rows["Job"] != "0" || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(rows["InvocationID"]) {
		t.Fatal("actual signed unit ownership or active postcondition is unproved")
	}
	return rows["InvocationID"]
}

// The issuer/key is explicitly a CP contract model. Verification, file-backed
// replay, audit, the atomic filesystem effects and default systemctl runner are
// genuine. No server, daemon deployment or browser approval is started here.
func TestRealServiceConfigureSystemdSignedExecutor(t *testing.T) {
	base := nativeSignedScope(t)
	desired := []byte("APP_MODE=mach01-signed-inert\n")
	sum := sha256.Sum256(desired)
	p := ops.ServiceConfigureProfile{Unit: nativeSignedUnit, ProfileRef: "mach01-signed", Path: filepath.Join(base, "app", "app.env"), SourcePath: filepath.Join(base, "templates", "approved.env"), SHA256: hex.EncodeToString(sum[:]), Mode: "0600", MaxBytes: 1024, Action: "restart", SettleSec: 5}
	if os.WriteFile(p.SourcePath, desired, 0400) != nil {
		t.Fatal("cannot pin signed local inert source")
	}
	c := ops.ServiceConfigureConfig{Enabled: true, BackupDir: filepath.Join(base, "backups"), MaxBackups: 4, MaxBackupBytes: 4096}
	var err error
	p.ProfileVersion, err = ops.ServiceConfigureProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	c.Profiles = []ops.ServiceConfigureProfile{p}
	configPath := filepath.Join(base, "config.json")
	auditPath := filepath.Join(base, "state", "audit.jsonl")
	configBytes, err := json.Marshal(map[string]any{"controlPlane": map[string]string{"url": "https://127.0.0.1:1"}, "name": "mach01-native-fixture", "stateDir": filepath.Join(base, "state"), "services": map[string]any{"restartAllow": []string{p.Unit}}, "serviceConfigure": c, "audit": map[string]string{"path": auditPath}, "rejectUnknownConstraints": true})
	if err != nil || os.WriteFile(configPath, configBytes, 0600) != nil {
		t.Fatal("cannot capture canonical local config")
	}
	cfg, err := machine.LoadConfig(configPath, func(string) string { return "" })
	if err != nil {
		t.Fatal("actual machine config loader refused exact fixture")
	}
	cp := protocoltest.New("mach01-fixture-key")
	audit, err := machine.OpenAudit(auditPath)
	if err != nil {
		t.Fatal("cannot open required actual audit")
	}
	t.Cleanup(func() {
		if audit.Close() != nil {
			t.Error("audit teardown failed; retain native fixture")
		}
	})
	replayPath := filepath.Join(base, "state", "replay.jsonl")
	replay, err := protocol.OpenFileReplayCache(replayPath, nil)
	if err != nil {
		t.Fatal("cannot open genuine persistent replay cache")
	}
	t.Cleanup(func() {
		if replay != nil && replay.Close() != nil {
			t.Error("replay teardown failed; retain native fixture")
		}
	})
	newExecutor := func() *machine.Executor {
		t.Helper()
		// ConfigFile pins existing protected custody; Runner is deliberately nil.
		ex, err := machine.NewExecutor(cfg, &agent.Identity{ID: "mach01_native_machine", WorkspaceID: "mach01_native_workspace"}, cp.KeySet(), replay, audit, agent.NewLogger(agent.LogConfig{Level: "error", Format: "text"}, io.Discard), machine.Deps{ConfigFile: configPath})
		if err != nil {
			t.Fatal("cannot construct production machine executor")
		}
		return ex
	}
	ex := newExecutor()
	sequence := 0
	args := map[string]any{"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "expectedSha256": nil}
	signed := func(arguments map[string]any, mutate func(*protocol.GrantClaims)) string {
		t.Helper()
		sequence++
		now := cp.Now()
		operation := fmt.Sprintf("mach01_native_operation_%d", sequence)
		grant := protocol.GrantClaims{JTI: fmt.Sprintf("mach01_native_grant_%d", sequence), ISS: "zenith-control-plane", AUD: "machine:mach01_native_machine", SUB: "fixture_human", IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), CAP: ops.OpServiceConfigure, OP: operation, Digest: "sha256:fixture", WS: "mach01_native_workspace", Res: "resource:mach01-inert", Constraints: map[string]any{"maxTimeoutSec": 30, "maxOutputBytes": 4096}}
		if mutate != nil {
			mutate(&grant)
		}
		raw, err := json.Marshal(arguments)
		if err != nil {
			t.Fatal(err)
		}
		envelope := protocol.MachineEnvelope{Protocol: protocol.MachineProtocol, JTI: fmt.Sprintf("mach01_native_request_%d", sequence), MachineID: "mach01_native_machine", WorkspaceID: "mach01_native_workspace", OperationID: operation, Operation: ops.OpServiceConfigure, Args: raw, Grant: cp.Sign(protocol.TypGrant, grant), IAT: now.Unix(), EXP: now.Add(5 * time.Minute).Unix(), TimeoutSec: 30, MaxOutputBytes: 4096}
		return cp.Sign(protocol.TypMachine, envelope)
	}
	good := signed(args, nil)
	before := nativeSignedInvocation(t)
	after := ""
	t.Run("signed-create-through-default-runner", func(t *testing.T) {
		job, rejected := ex.Verify(context.Background(), good)
		if job == nil || rejected != nil {
			t.Fatal("genuine resource-scoped signed request was refused")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		result := job.Run(ctx, nil)
		wire, ok := result.Result.(map[string]any)
		if !ok || wire == nil {
			t.Fatal("actual signed execution did not return the production result shape")
		}
		data, ok := wire["data"].(map[string]any)
		if ctx.Err() != nil || result.Status != agent.StatusSucceeded || !ok || wire["ok"] != true || data["created"] != true || data["effect"] != "committed" || data["action"] != "restart" || data["unit"] != p.Unit || data["profileVersion"] != p.ProfileVersion || data["transactionRef"] == nil {
			t.Fatal("actual signed execution did not establish committed native postconditions")
		}
		actual, err := os.ReadFile(p.Path)
		if err != nil || string(actual) != string(desired) {
			t.Fatal("signed native independent file readback differs")
		}
		after = nativeSignedInvocation(t)
		if after == before {
			t.Fatal("signed mutation did not cause a new actual systemd invocation")
		}
	})
	if t.Failed() {
		return
	}
	refuse := func(t *testing.T, token, code string) {
		t.Helper()
		job, rejection := ex.Verify(context.Background(), token)
		if job != nil || rejection == nil || rejection.Code != code {
			t.Fatal("inexact signed authority did not refuse with the exact protocol code")
		}
		actual, err := os.ReadFile(p.Path)
		if err != nil || string(actual) != string(desired) || nativeSignedInvocation(t) != after {
			t.Fatal("rejected signed request changed actual filesystem or unit")
		}
	}
	t.Run("persistent-replay-after-executor-reopen", func(t *testing.T) {
		if replay.Close() != nil {
			t.Fatal("original replay handle did not close")
		}
		nextReplay, openErr := protocol.OpenFileReplayCache(replayPath, nil)
		if openErr != nil {
			t.Fatal("genuine replay custody did not reopen")
		}
		replay = nextReplay
		if replay.Len() == 0 {
			t.Fatal("genuine replay custody was not persisted")
		}
		ex = newExecutor()
		refuse(t, good, protocol.CodeReplay)
	})
	if t.Failed() {
		return
	}
	for _, name := range []string{"missing-resource", "unknown-constraint", "stale-profile", "foreign-unit"} {
		t.Run(name+"-has-no-effect", func(t *testing.T) {
			arguments := map[string]any{"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "expectedSha256": nil}
			var mutate func(*protocol.GrantClaims)
			code := protocol.CodeConstraint
			switch name {
			case "missing-resource":
				mutate = func(g *protocol.GrantClaims) { g.Res = "" }
			case "unknown-constraint":
				mutate = func(g *protocol.GrantClaims) { g.Constraints = map[string]any{"maxLines": 1} }
			case "stale-profile":
				arguments["profileVersion"] = strings.Repeat("0", 64)
				code = protocol.CodeNotAllowed
			case "foreign-unit":
				arguments["unit"] = "zenith-mach01-foreign.service"
				code = protocol.CodeNotAllowed
			}
			refuse(t, signed(arguments, mutate), code)
		})
		if t.Failed() {
			return
		}
	}
	auditBytes, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatal("actual audit readback unavailable")
	}
	starts, ends := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(auditBytes)), "\n") {
		var entry machine.AuditEntry
		if json.Unmarshal([]byte(line), &entry) != nil {
			t.Fatal("malformed actual audit receipt")
		}
		if entry.RequestID == "mach01_native_request_1" && entry.Phase == "start" && entry.Verified {
			starts++
		}
		if entry.RequestID == "mach01_native_request_1" && entry.Phase == "end" && entry.Verified && entry.Outcome == agent.StatusSucceeded && entry.Extra["effect"] == "committed" && entry.Extra["transactionRef"] != "" {
			ends++
		}
	}
	if starts != 1 || ends != 1 {
		t.Fatal("actual successful audit/replay path did not remain once-only")
	}
}
