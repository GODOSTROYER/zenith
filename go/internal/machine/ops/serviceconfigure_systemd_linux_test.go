//go:build linux && zenith_systemd_acceptance

package ops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const nativeConfigureUnit = "zenith-mach01-configure-fixture.service"
const nativeConfigureRoot = "/opt/zenith-file-write-tests"
const nativeConfigureMarker = nativeConfigureRoot + "/.mach01-systemd-ops-active"

// This explicit tagged acceptance fails missing prerequisites. Normal native152
// does not compile this file and retains its three existing optional skips.
// The root helper owns only the inert unit/rule; this test never uses sudo/root.
func nativeConfigureScope(t *testing.T) string {
	t.Helper()
	if os.Getenv("ZENITH_TEST_SERVICE_CONFIGURE_SYSTEMD") != "1" || os.Getenv("ZENITH_FILE_WRITE_TEST_ROOT") != nativeConfigureRoot || os.Geteuid() == 0 || os.Getegid() == 0 || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(os.Getenv("ZENITH_GUEST_FIXTURE_RUN_ID")) {
		t.Fatal("explicit systemd acceptance requires the owned unprivileged Linux fixture")
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
			t.Fatal("native service test must have no effective, permitted, inherited or ambient capabilities")
		}
	}
	if fields["NoNewPrivs"] != "1" {
		t.Fatal("native service test must run with no-new-privileges")
	}
	helper, err := filepath.Abs("../../../../scripts/ci/service-configure-systemd-fixtures.py")
	if err != nil {
		t.Fatal("cannot resolve the reviewed fixture helper")
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
		t.Fatal("another systemd acceptance owns the inert unit")
	}
	// Root teardown needs this exclusive lease. Recheck after waiting/acquisition.
	check()
	marker, err := os.OpenFile(nativeConfigureMarker, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		lease.Close()
		t.Fatal("unsettled earlier native service test must remain retained")
	}
	data := os.Getenv("ZENITH_GUEST_FIXTURE_RUN_ID") + "\n"
	written, writeErr := marker.WriteString(data)
	syncErr, closeErr := marker.Sync(), marker.Close()
	if written != len(data) || writeErr != nil || syncErr != nil || closeErr != nil {
		lease.Close()
		t.Fatal("cannot persist native service test lifetime")
	}
	base, err := os.MkdirTemp(nativeConfigureRoot, "mach01-systemd-ops-")
	if err != nil {
		lease.Close()
		t.Fatal("cannot create protected test-local custody")
	}
	t.Cleanup(func() {
		defer func() {
			if err := lease.Close(); err != nil {
				t.Error("native fixture lease close failed")
			}
			if !t.Failed() {
				if err := os.Remove(nativeConfigureMarker); err != nil {
					t.Error("cannot retire native service test lifetime")
				}
			}
		}()
		// Killed/failed tests keep the marker, even if the test PID is later gone.
		// The root helper never accepts PID absence as clearance for a late action.
		if !t.Failed() {
			nativeConfigureStatus(t)
			if err := os.RemoveAll(base); err != nil {
				t.Error("owned test-local cleanup failed; native fixture remains retained")
			}
		}
	})
	for _, name := range []string{"app", "templates", "backups"} {
		if os.Mkdir(filepath.Join(base, name), 0700) != nil {
			t.Fatal("cannot create protected local profile directories")
		}
	}
	return base
}

func nativeConfigureStatus(t *testing.T) map[string]string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/bin/systemctl", "show", "--all", "--no-pager", "--property=LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,Job", "--", nativeConfigureUnit).Output()
	if err != nil {
		t.Fatal("actual systemctl observation did not settle")
	}
	result := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(output), "\n"), "\n") {
		k, v, ok := strings.Cut(line, "=")
		_, duplicate := result[k]
		if !ok || duplicate || !strings.Contains(",LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,Job,", ","+k+",") {
			t.Fatal("malformed native systemd observation")
		}
		result[k] = v
	}
	if len(result) != 7 || result["LoadState"] != "loaded" || result["FragmentPath"] != "/run/systemd/system/"+nativeConfigureUnit || result["MainPID"] != "0" || result["Job"] != "" || (result["ActiveState"] != "inactive" && result["ActiveState"] != "active") || (result["SubState"] != "dead" && result["SubState"] != "exited") {
		t.Fatal("native systemd unit identity or terminal state is unproved")
	}
	if result["ActiveState"] == "active" && !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(result["InvocationID"]) {
		t.Fatal("actual active unit has no canonical invocation identity")
	}
	return result
}

func nativeConfigureRun(t *testing.T, e *Env, a serviceConfigureArgs) Result {
	t.Helper()
	if e.Runner != nil || e.sleep != nil || e.Cfg.SystemctlPath != "" {
		t.Fatal("actual systemd acceptance must use the default production runner")
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	run, err := e.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096})
	if err != nil {
		t.Fatal("canonical native service request was refused")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := run(ctx)
	if err != nil || ctx.Err() != nil {
		t.Fatal("native service mutation outcome is unresolved; retain fixture")
	}
	return result
}

func nativeConfigureFile(t *testing.T, path string, mode uint32) {
	t.Helper()
	var st syscall.Stat_t
	if syscall.Lstat(path, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != mode || st.Uid != uint32(os.Geteuid()) || st.Gid != uint32(os.Getegid()) || st.Nlink != 1 {
		t.Fatal("native file custody is not exact private regular ownership/mode")
	}
}

func TestRealServiceConfigureSystemdOps(t *testing.T) {
	base := nativeConfigureScope(t)
	if nativeConfigureStatus(t)["ActiveState"] != "inactive" {
		t.Fatal("fresh inert unit must not already be running")
	}
	desired := []byte("APP_MODE=mach01-first-inert\n")
	p := ServiceConfigureProfile{Unit: nativeConfigureUnit, ProfileRef: "mach01-config", Path: filepath.Join(base, "app", "app.env"), SourcePath: filepath.Join(base, "templates", "first.env"), SHA256: writeSHA(desired), Mode: "0600", MaxBytes: 1024, Action: "restart", SettleSec: 5}
	if os.WriteFile(p.SourcePath, desired, 0400) != nil {
		t.Fatal("cannot pin local inert source")
	}
	c := ServiceConfigureConfig{Enabled: true, BackupDir: filepath.Join(base, "backups"), MaxBackups: 4, MaxBackupBytes: 4096}
	var err error
	p.ProfileVersion, err = ServiceConfigureProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	c.Profiles = []ServiceConfigureProfile{p}
	e := &Env{Cfg: Config{ServiceConfigure: c, Services: ServicesConfig{RestartAllow: []string{nativeConfigureUnit}}}}
	a := serviceConfigureArgs{Unit: p.Unit, ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}
	firstID := ""
	t.Run("create-and-real-restart", func(t *testing.T) {
		result := nativeConfigureRun(t, e, a)
		if !result.OK || result.Data["created"] != true || result.Data["changed"] != true || result.Data["action"] != "restart" || result.Data["effect"] != "committed" || result.Data["unit"] != p.Unit || result.Data["profileVersion"] != p.ProfileVersion {
			t.Fatal("create did not bind actual committed restart receipt")
		}
		writeAssertBytes(t, p.Path, desired)
		nativeConfigureFile(t, p.Path, 0600)
		observed := nativeConfigureStatus(t)
		if observed["ActiveState"] != "active" || observed["SubState"] != "exited" {
			t.Fatal("real systemd did not reach the exact inert active postcondition")
		}
		firstID = observed["InvocationID"]
	})
	if t.Failed() {
		return
	}
	hash := p.SHA256
	a.ExpectedSHA256 = &hash
	t.Run("active-noop-keeps-invocation", func(t *testing.T) {
		result := nativeConfigureRun(t, e, a)
		if !result.OK || result.Data["changed"] != false || result.Data["action"] != "none" || result.Data["effect"] != "none" || result.Data["transactionRef"] != nil || nativeConfigureStatus(t)["InvocationID"] != firstID {
			t.Fatal("native converged noop caused an effect or changed the real invocation")
		}
	})
	if t.Failed() {
		return
	}
	prior := desired
	desired = []byte("APP_MODE=mach01-second-inert\n")
	p.SourcePath = filepath.Join(base, "templates", "second.env")
	p.SHA256 = writeSHA(desired)
	if os.WriteFile(p.SourcePath, desired, 0400) != nil {
		t.Fatal("cannot pin replacement source")
	}
	p.ProfileVersion, err = ServiceConfigureProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	e.Cfg.ServiceConfigure.Profiles = []ServiceConfigureProfile{p}
	a.ProfileVersion = p.ProfileVersion
	secondID := ""
	t.Run("replace-retains-backup-and-restarts", func(t *testing.T) {
		result := nativeConfigureRun(t, e, a)
		backup, ok := result.Data["backupRef"].(string)
		if !result.OK || !ok || backup == "" || result.Data["changed"] != true || result.Data["created"] != false || result.Data["action"] != "restart" || result.Data["effect"] != "committed" {
			t.Fatal("native replacement did not retain committed prior custody")
		}
		writeAssertBytes(t, p.Path, desired)
		writeAssertBytes(t, filepath.Join(c.BackupDir, backup+".data"), prior)
		nativeConfigureFile(t, p.Path, 0600)
		nativeConfigureFile(t, filepath.Join(c.BackupDir, backup+".data"), 0600)
		nativeConfigureFile(t, filepath.Join(c.BackupDir, backup+".json"), 0600)
		intentBytes, err := os.ReadFile(filepath.Join(c.BackupDir, backup+".json"))
		var intent map[string]any
		if err != nil || json.Unmarshal(intentBytes, &intent) != nil || intent["operation"] != OpServiceConfigure || intent["profileVersion"] != p.ProfileVersion || intent["priorSha256"] != hash || intent["desiredSha256"] != p.SHA256 || result.Data["transactionRef"] != backup {
			t.Fatal("native retained intent lost exact purpose/version/prior binding")
		}
		secondID = nativeConfigureStatus(t)["InvocationID"]
		if secondID == firstID {
			t.Fatal("changed config did not reach a new actual systemd invocation")
		}
	})
	if t.Failed() {
		return
	}
	t.Run("wrong-prior-has-no-effect", func(t *testing.T) {
		wrong := strings.Repeat("0", 64)
		bad := a
		bad.ExpectedSHA256 = &wrong
		result := nativeConfigureRun(t, e, bad)
		if result.OK || result.Data["effect"] != "none" || nativeConfigureStatus(t)["InvocationID"] != secondID {
			t.Fatal("wrong prior changed the actual unit or file")
		}
		writeAssertBytes(t, p.Path, desired)
	})
	if t.Failed() {
		return
	}
	for _, name := range []string{"stale-profile", "foreign-unit"} {
		t.Run(name+"-has-no-effect", func(t *testing.T) {
			bad := a
			if name == "stale-profile" {
				bad.ProfileVersion = strings.Repeat("0", 64)
			} else {
				bad.Unit = "zenith-mach01-foreign.service"
			}
			raw, _ := json.Marshal(bad)
			if run, err := e.Prepare(OpServiceConfigure, &Request{Args: raw, MaxOutputBytes: 4096}); err == nil || run != nil {
				t.Fatal("inexact local authority produced a native runnable")
			}
			writeAssertBytes(t, p.Path, desired)
			if nativeConfigureStatus(t)["InvocationID"] != secondID {
				t.Fatal("refused request changed actual service invocation")
			}
		})
		if t.Failed() {
			return
		}
	}
	t.Run("polkit-permits-restart-only", func(t *testing.T) {
		for _, verb := range []string{"start", "stop"} {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := exec.CommandContext(ctx, "/usr/bin/systemctl", verb, "--no-ask-password", "--no-pager", "--", nativeConfigureUnit).Run()
			cancel()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() == 0 || ctx.Err() == context.DeadlineExceeded || nativeConfigureStatus(t)["InvocationID"] != secondID || nativeConfigureStatus(t)["ActiveState"] != "active" {
				t.Fatal("existing account has broader authority than the exact fixture restart rule")
			}
		}
	})
}
