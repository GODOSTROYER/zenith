//go:build linux

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSystemd stands in only for systemctl. Every file effect in these tests is
// the real unprivileged Linux atomic writer over the same required fixture root.
type fakeSystemd struct {
	mu        sync.Mutex
	loadState string
	active    string
	// afterAction is the state a successful action leaves; "" keeps the state.
	afterAction string
	exit        map[string]int
	actionErr   error
	calls       []string
	shows       int
	// activateAfter makes the unit report "activating" for N shows after an action.
	activateAfter int
	pending       int
}

func (f *fakeSystemd) Run(_ context.Context, s CmdSpec) (CmdResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(s.Args) > 0 && s.Args[0] == "show" {
		f.shows++
		state := f.active
		if f.pending > 0 {
			f.pending--
			state = "activating"
		}
		return CmdResult{Stdout: []byte(fmt.Sprintf("LoadState=%s\nActiveState=%s\nSubState=running\nMainPID=7\n", f.loadState, state))}, nil
	}
	if len(s.Args) == 0 {
		return CmdResult{}, errors.New("unexpected empty argv")
	}
	f.calls = append(f.calls, strings.Join(s.Args, " "))
	if f.actionErr != nil {
		return CmdResult{}, f.actionErr
	}
	code := f.exit[s.Args[0]]
	if code == 0 && f.afterAction != "" {
		f.active = f.afterAction
		f.pending = f.activateAfter
	}
	return CmdResult{ExitCode: code, Stderr: []byte("inert-systemctl-stderr-marker")}, nil
}

func (f *fakeSystemd) actions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func serviceFixture(t *testing.T, action string) (*Env, serviceConfigureArgs, ServiceConfigureProfile, *fakeSystemd, []byte) {
	t.Helper()
	e, _, write, _ := writeFixture(t)
	desired := []byte("APP_MODE=approved-inert-fixture\n")
	if err := os.Chmod(write.SourcePath, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(write.SourcePath, desired, 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(write.SourcePath, 0400); err != nil {
		t.Fatal(err)
	}
	p := ServiceConfigureProfile{Unit: "app.service", ProfileRef: "app-config", Path: write.Path, SourcePath: write.SourcePath, SHA256: writeSHA(desired), Mode: "0600", MaxBytes: 1024, Action: action, SettleSec: 3}
	c := ServiceConfigureConfig{Enabled: true, BackupDir: e.Cfg.FileWrite.BackupDir, MaxBackupBytes: e.Cfg.FileWrite.MaxBackupBytes, MaxBackups: e.Cfg.FileWrite.MaxBackups}
	var err error
	if p.ProfileVersion, err = ServiceConfigureProfileVersion(c, p); err != nil {
		t.Fatal(err)
	}
	c.Profiles = []ServiceConfigureProfile{p}
	e.Cfg.FileWrite = FileWriteConfig{}
	e.Cfg.ServiceConfigure = c
	e.Cfg.Services = ServicesConfig{RestartAllow: []string{"app.service"}}
	sd := &fakeSystemd{loadState: "loaded", active: "active", afterAction: "active", exit: map[string]int{}}
	e.Runner = sd
	e.sleep = func(context.Context, time.Duration) error { return nil }
	return e, serviceConfigureArgs{Unit: p.Unit, ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}, p, sd, desired
}

func serviceRun(t *testing.T, e *Env, a serviceConfigureArgs) Result {
	t.Helper()
	return serviceRunCtx(t, context.Background(), e, a)
}

func serviceRunCtx(t *testing.T, ctx context.Context, e *Env, a serviceConfigureArgs) Result {
	t.Helper()
	raw, _ := json.Marshal(a)
	run, err := e.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal(err)
	}
	r, err := run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func assertNoLeak(t *testing.T, r Result, p ServiceConfigureProfile) {
	t.Helper()
	wire, _ := json.Marshal(r)
	for _, secret := range []string{"approved-inert-fixture", p.SourcePath, p.Path, "inert-systemctl-stderr-marker"} {
		if strings.Contains(string(wire), secret) {
			t.Fatal("result leaked local contents, paths or command output")
		}
	}
}

func TestServiceConfigureCreateReplaceNoopAndConvergence(t *testing.T) {
	e, a, p, sd, desired := serviceFixture(t, "restart")
	created := serviceRun(t, e, a)
	if !created.OK || created.Data["created"] != true || created.Data["changed"] != true || created.Data["action"] != "restart" || created.Data["activeState"] != "active" || created.Data["effect"] != "committed" || created.Data["backupRef"] != nil || created.Data["profileVersion"] != p.ProfileVersion || created.Data["unit"] != p.Unit {
		t.Fatal("create receipt invalid", created.Data)
	}
	writeAssertBytes(t, p.Path, desired)
	if got := sd.actions(); len(got) != 1 || got[0] != "restart --no-pager -- app.service" {
		t.Fatal("create did not converge with exactly one fixed restart argv", got)
	}
	assertNoLeak(t, created, p)

	// byte-identical config on an active unit: verified noop, no systemctl action
	h := p.SHA256
	a.ExpectedSHA256 = &h
	noop := serviceRun(t, e, a)
	if !noop.OK || noop.Data["changed"] != false || noop.Data["action"] != "none" || noop.Data["effect"] != "none" || noop.Data["bytesWritten"] != 0 || noop.Data["transactionRef"] != nil {
		t.Fatal("converged noop did not establish exact postconditions", noop.Data)
	}
	if len(sd.actions()) != 1 {
		t.Fatal("a converged unit was restarted again")
	}

	// byte-identical config on a dead unit is converged by a restart
	sd.active = "inactive"
	revive := serviceRun(t, e, a)
	if !revive.OK || revive.Data["changed"] != false || revive.Data["action"] != "restart" || revive.Data["effect"] != "committed" || revive.Data["transactionRef"] != nil || len(sd.actions()) != 2 {
		t.Fatal("convergence did not revive an inactive unit", revive.Data)
	}

	// replacement retains the prior bytes privately and uses the profile action
	old := []byte("APP_MODE=prior-inert-fixture\n")
	if err := os.WriteFile(p.Path, old, 0600); err != nil {
		t.Fatal(err)
	}
	prior := writeSHA(old)
	a.ExpectedSHA256 = &prior
	replaced := serviceRun(t, e, a)
	ref, ok := replaced.Data["backupRef"].(string)
	if !replaced.OK || !ok || replaced.Data["created"] != false || replaced.Data["changed"] != true {
		t.Fatal("replacement did not retain private custody", replaced.Data)
	}
	writeAssertBytes(t, p.Path, desired)
	writeAssertBytes(t, filepath.Join(e.Cfg.ServiceConfigure.BackupDir, ref+".data"), old)
	raw, err := os.ReadFile(filepath.Join(e.Cfg.ServiceConfigure.BackupDir, ref+".json"))
	var intent map[string]any
	if err != nil || json.Unmarshal(raw, &intent) != nil || intent["operation"] != OpServiceConfigure || intent["profileVersion"] != p.ProfileVersion || intent["profileRef"] != p.ProfileRef || intent["contentVersion"] != nil || intent["bytes"] != nil {
		t.Fatal("service intent did not bind its exact purpose without contents")
	}
	assertNoLeak(t, replaced, p)
}

func TestServiceConfigureReloadActionIsClosedByProfile(t *testing.T) {
	e, a, _, sd, _ := serviceFixture(t, "reload")
	if r := serviceRun(t, e, a); !r.OK || r.Data["action"] != "reload" {
		t.Fatal("profile reload was not honored", r.Data)
	}
	if got := sd.actions(); len(got) != 1 || got[0] != "reload --no-pager -- app.service" {
		t.Fatal("reload argv is not fixed", got)
	}
}

func TestServiceConfigureInactiveReloadProfileRestartsWithExactCustody(t *testing.T) {
	for _, kind := range []string{"create", "replace"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, sd, desired := serviceFixture(t, "reload")
			sd.active = "inactive"
			old := []byte("APP_MODE=prior-inactive-fixture\n")
			if kind == "replace" {
				if err := os.WriteFile(p.Path, old, 0600); err != nil {
					t.Fatal(err)
				}
				prior := writeSHA(old)
				a.ExpectedSHA256 = &prior
			}
			r := serviceRun(t, e, a)
			if !r.OK || r.Data["changed"] != true || r.Data["created"] != (kind == "create") || r.Data["action"] != "restart" || r.Data["activeState"] != "active" || r.Data["effect"] != "committed" || r.Data["profileVersion"] != p.ProfileVersion {
				t.Fatal("inactive reload profile did not establish exact restart postconditions", r.Data)
			}
			writeAssertBytes(t, p.Path, desired)
			if got := sd.actions(); len(got) != 1 || got[0] != "restart --no-pager -- app.service" {
				t.Fatal("inactive unit did not receive exactly one fixed restart", got)
			}
			ref, ok := r.Data["transactionRef"].(string)
			if !ok {
				t.Fatal("committed configuration lost its transaction custody")
			}
			raw, err := os.ReadFile(filepath.Join(e.Cfg.ServiceConfigure.BackupDir, ref+".json"))
			var intent map[string]any
			if err != nil || json.Unmarshal(raw, &intent) != nil || intent["operation"] != OpServiceConfigure || intent["profileRef"] != p.ProfileRef || intent["profileVersion"] != p.ProfileVersion || intent["desiredSha256"] != p.SHA256 || intent["created"] != (kind == "create") || intent["state"] != "commit-may-have-run" {
				t.Fatal("restart did not preserve the exact original file intent")
			}
			if kind == "replace" {
				if r.Data["backupRef"] != ref || intent["priorSha256"] != *a.ExpectedSHA256 {
					t.Fatal("replacement lost its original prior-state binding")
				}
				writeAssertBytes(t, filepath.Join(e.Cfg.ServiceConfigure.BackupDir, ref+".data"), old)
			} else if r.Data["backupRef"] != nil || intent["priorSha256"] != nil {
				t.Fatal("create claimed a prior file or backup")
			}
			assertNoLeak(t, r, p)
		})
	}
}

func TestServiceConfigureInactiveReloadProfileRefusesInexactPrior(t *testing.T) {
	for _, kind := range []string{"prior-on-absent", "absence-on-existing"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, sd, _ := serviceFixture(t, "reload")
			sd.active = "inactive"
			old := []byte("APP_MODE=retained-prior-fixture\n")
			if kind == "prior-on-absent" {
				prior := writeSHA(old)
				a.ExpectedSHA256 = &prior
			} else if err := os.WriteFile(p.Path, old, 0600); err != nil {
				t.Fatal(err)
			}
			r := serviceRun(t, e, a)
			if r.OK || r.Data["error"] != "refused" || r.Data["effect"] != "none" || r.Data["transactionRef"] != nil || len(sd.actions()) != 0 {
				t.Fatal("inactive convergence bypassed the exact file precondition", r.Data)
			}
			if kind == "absence-on-existing" {
				writeAssertBytes(t, p.Path, old)
			} else if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("refused convergence created a configuration")
			}
			entries, err := os.ReadDir(e.Cfg.ServiceConfigure.BackupDir)
			if err != nil || len(entries) != 0 {
				t.Fatal("refused convergence created retained mutation custody")
			}
		})
	}
}

func TestServiceConfigureInactiveReloadProfileRequiresRestartAuthority(t *testing.T) {
	e, a, p, sd, _ := serviceFixture(t, "reload")
	sd.active = "inactive"
	e.Cfg.Services.RestartAllow = []string{"other.service"}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	if run, err := e.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096}); run != nil || err == nil {
		t.Fatal("inactive convergence bypassed existing restart authority")
	}
	if sd.shows != 0 || len(sd.actions()) != 0 {
		t.Fatal("unauthorized convergence consulted or changed the service")
	}
	if _, err := os.Lstat(p.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unauthorized convergence wrote the configuration")
	}
}

func TestServiceConfigureUnitFailureAfterCommitIsDefiniteAndRetained(t *testing.T) {
	for name, setup := range map[string]func(*fakeSystemd){
		"action exits non-zero": func(sd *fakeSystemd) { sd.exit["restart"] = 1 },
		"unit ends failed":      func(sd *fakeSystemd) { sd.afterAction = "failed" },
		"never settles":         func(sd *fakeSystemd) { sd.activateAfter = 1 << 20 },
	} {
		t.Run(name, func(t *testing.T) {
			e, a, p, sd, desired := serviceFixture(t, "restart")
			old := []byte("APP_MODE=prior-inert-fixture\n")
			if err := os.WriteFile(p.Path, old, 0600); err != nil {
				t.Fatal(err)
			}
			prior := writeSHA(old)
			a.ExpectedSHA256 = &prior
			setup(sd)
			r := serviceRun(t, e, a)
			if r.OK || r.Data["error"] != "service_failed" || r.Data["effect"] != "committed" || r.Data["postcondition"] != "unverified" {
				t.Fatal("unhealthy unit was not a definite committed failure", r.Data)
			}
			if phase := r.Data["phase"]; phase != "service_action" && phase != "service_postcondition" {
				t.Fatal("failure phase outside the closed vocabulary", phase)
			}
			ref, ok := r.Data["backupRef"].(string)
			if !ok || r.Data["transactionRef"] == nil {
				t.Fatal("failure lost backup and transaction custody")
			}
			// the new config is committed and the prior bytes remain recoverable
			writeAssertBytes(t, p.Path, desired)
			writeAssertBytes(t, filepath.Join(e.Cfg.ServiceConfigure.BackupDir, ref+".data"), old)
			assertNoLeak(t, r, p)
			if len(sd.actions()) != 1 {
				t.Fatal("zenithd retried or rolled back a service action on its own", sd.actions())
			}
		})
	}
}

func TestServiceConfigureSlowStartWithinBoundSettles(t *testing.T) {
	e, a, _, sd, _ := serviceFixture(t, "restart")
	sd.activateAfter = 4
	if r := serviceRun(t, e, a); !r.OK || r.Data["activeState"] != "active" {
		t.Fatal("a unit that activates within its bound was refused", r.Data)
	}
}

func TestServiceConfigureCancellationDuringActionIsUncertain(t *testing.T) {
	e, a, p, sd, desired := serviceFixture(t, "restart")
	ctx, cancel := context.WithCancel(context.Background())
	sd.actionErr = context.Canceled
	cancel()
	// Cancel is observed by the file engine before any effect when already cancelled.
	pre := serviceRunCtx(t, ctx, e, a)
	if pre.OK || pre.Data["effect"] != "none" || len(sd.actions()) != 0 {
		t.Fatal("pre-cancelled request had effects", pre.Data)
	}
	if _, err := os.Stat(p.Path); err == nil {
		t.Fatal("pre-cancelled request wrote the configuration")
	}

	live, stop := context.WithCancel(context.Background())
	defer stop()
	sd.actionErr = nil
	e.Runner = actionCancelRunner{fakeSystemd: sd, cancel: stop}
	r := serviceRunCtx(t, live, e, a)
	if r.OK || r.Data["error"] != "mutation_uncertain" || r.Data["effect"] != "unknown" || r.Data["phase"] != "service_action" || r.Data["transactionRef"] == nil {
		t.Fatal("cancellation during an in-flight action was not an unknown outcome", r.Data)
	}
	writeAssertBytes(t, p.Path, desired)
	assertNoLeak(t, r, p)
}

// actionCancelRunner cancels the request while systemctl is "running".
type actionCancelRunner struct {
	*fakeSystemd
	cancel context.CancelFunc
}

func (r actionCancelRunner) Run(ctx context.Context, s CmdSpec) (CmdResult, error) {
	if len(s.Args) > 0 && s.Args[0] != "show" {
		r.cancel()
		return CmdResult{}, context.Canceled
	}
	return r.fakeSystemd.Run(ctx, s)
}

func TestServiceConfigureGuardsRefuseWithoutAnyServiceEffect(t *testing.T) {
	for _, kind := range []string{"absence-on-existing", "prior-on-absent", "wrong-prior", "source-digest", "target-symlink", "backup-budget"} {
		t.Run(kind, func(t *testing.T) {
			e, a, p, sd, _ := serviceFixture(t, "restart")
			old := []byte("prior-inert-fixture")
			prior := writeSHA(old)
			switch kind {
			case "absence-on-existing", "wrong-prior":
				if err := os.WriteFile(p.Path, old, 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "wrong-prior" {
					wrong := strings.Repeat("b", 64)
					a.ExpectedSHA256 = &wrong
				}
			case "prior-on-absent":
				a.ExpectedSHA256 = &prior
			case "source-digest":
				if err := os.Chmod(p.SourcePath, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p.SourcePath, old, 0600); err != nil {
					t.Fatal(err)
				}
			case "target-symlink":
				if err := os.Symlink(p.SourcePath, p.Path); err != nil {
					t.Fatal(err)
				}
			case "backup-budget":
				e.Cfg.ServiceConfigure.MaxBackupBytes = 1
				e.Cfg.ServiceConfigure.Profiles[0].ProfileVersion, _ = ServiceConfigureProfileVersion(e.Cfg.ServiceConfigure, e.Cfg.ServiceConfigure.Profiles[0])
				a.ProfileVersion = e.Cfg.ServiceConfigure.Profiles[0].ProfileVersion
			}
			r := serviceRun(t, e, a)
			if r.OK || r.Data["error"] != "refused" || r.Data["effect"] != "none" {
				t.Fatal("native guard permitted effects", r.Data)
			}
			if len(sd.actions()) != 0 {
				t.Fatal("a refused configuration still touched the service")
			}
			assertNoLeak(t, r, p)
		})
	}
}

func TestServiceConfigureAdmissionIsExactAndUsesExistingRestartAuthority(t *testing.T) {
	e, a, p, _, _ := serviceFixture(t, "restart")
	prepare := func(mutate func(*serviceConfigureArgs), tweak func(*Env)) error {
		env := *e
		if tweak != nil {
			tweak(&env)
		}
		arg := a
		if mutate != nil {
			mutate(&arg)
		}
		raw, _ := json.Marshal(arg)
		_, err := env.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096})
		return err
	}
	if err := prepare(nil, nil); err != nil {
		t.Fatal("exact admission refused", err)
	}
	for name, err := range map[string]error{
		"other unit":    prepare(func(x *serviceConfigureArgs) { x.Unit = "other.service" }, nil),
		"other ref":     prepare(func(x *serviceConfigureArgs) { x.ProfileRef = "other" }, nil),
		"other version": prepare(func(x *serviceConfigureArgs) { x.ProfileVersion = strings.Repeat("d", 64) }, nil),
		"write version": prepare(func(x *serviceConfigureArgs) {
			x.ProfileVersion, _ = FileWriteProfileVersion(serviceBudget(e.Cfg.ServiceConfigure), serviceFileProfile(p))
		}, nil),
		"disabled":          prepare(nil, func(x *Env) { x.Cfg.ServiceConfigure.Enabled = false }),
		"unit not allowed":  prepare(nil, func(x *Env) { x.Cfg.Services.RestartAllow = []string{"other.service"} }),
		"no restart policy": prepare(nil, func(x *Env) { x.Cfg.Services.RestartAllow = nil }),
	} {
		if err == nil {
			t.Fatal("inexact or unauthorized admission accepted: " + name)
		}
	}
	// a changed local profile after approval no longer matches the approved version
	tampered := *e
	tampered.Cfg.ServiceConfigure.Profiles = []ServiceConfigureProfile{func() ServiceConfigureProfile { q := p; q.Action = "reload"; return q }()}
	raw, _ := json.Marshal(a)
	if _, err := tampered.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096}); err == nil {
		t.Fatal("tampered local profile was admitted under the old version")
	}
}

func TestServiceConfigureUnloadedUnitRefusesBeforeAnyFileOrServiceEffect(t *testing.T) {
	e, a, p, sd, _ := serviceFixture(t, "restart")
	sd.loadState = "not-found"
	r := serviceRun(t, e, a)
	if r.OK || r.Data["error"] != "refused" || r.Data["phase"] != "guard" || r.Data["effect"] != "none" || len(sd.actions()) != 0 {
		t.Fatal("unloaded unit outcome invalid", r.Data)
	}
	if _, err := os.Stat(p.Path); err == nil {
		t.Fatal("a unit that cannot converge still received a committed configuration")
	}
	assertNoLeak(t, r, p)
}
