//go:build linux

package ops

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"testing"
)

// This golden runs the genuine service handler and atomic file mapper. Only
// systemctl replies are modeled; it does not prove a live systemd installation.
func compareServiceConfigureGolden(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Fatal("authentic service.configure golden requires an unprivileged Linux user")
	}
	// Reuse the existing fixed filesystem-golden root after file.write's child
	// cleanup. Canonical profile versions bind these paths on every comparison.
	const root = "/opt/zenith-file-write-golden"
	rootFD, err := writeDir(root, true)
	if err != nil {
		t.Fatal("provision the protected persistent unprivileged filesystem-golden root")
	}
	entries, err := rootFD.ReadDir(-1)
	if err != nil || len(entries) != 0 {
		rootFD.Close()
		t.Fatal("service golden requires the exact empty filesystem-golden root")
	}
	type ownedDirectory struct {
		path string
		fd   *os.File
	}
	owned := []ownedDirectory{}
	t.Cleanup(func() {
		defer rootFD.Close()
		for _, dir := range owned {
			defer dir.fd.Close()
		}
		if !writeDirSame(root, rootFD, true) {
			t.Error("filesystem-golden root identity changed; retain fixture custody")
			return
		}
		for _, dir := range owned {
			if !writeDirSame(dir.path, dir.fd, true) {
				t.Error("owned service-golden directory identity changed; retain fixture custody")
				return
			}
		}
		for _, dir := range owned {
			if err := os.RemoveAll(dir.path); err != nil {
				t.Error("could not remove the positively owned service-golden directory")
			}
		}
	})
	for _, name := range []string{"service-app", "service-templates", "service-backups"} {
		path := filepath.Join(root, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal("could not create the absent private service-golden directory")
		}
		fd, err := writeDir(path, true)
		if err != nil {
			t.Fatal("could not capture the created service-golden directory")
		}
		owned = append(owned, ownedDirectory{path: path, fd: fd})
	}
	desired := []byte("APP_MODE=approved-inert-service-golden\n")
	source := filepath.Join(root, "service-templates", "app.env")
	if err := os.WriteFile(source, desired, 0400); err != nil {
		t.Fatal("could not create the local approved inert service source")
	}
	p := ServiceConfigureProfile{
		Unit: "app.service", ProfileRef: "app-config", Path: filepath.Join(root, "service-app", "app.env"),
		SourcePath: source, SHA256: writeSHA(desired), Mode: "0600", MaxBytes: 1024, Action: "reload", SettleSec: 3,
	}
	c := ServiceConfigureConfig{Enabled: true, BackupDir: filepath.Join(root, "service-backups"), MaxBackups: 4, MaxBackupBytes: 4096}
	if p.ProfileVersion, err = ServiceConfigureProfileVersion(c, p); err != nil {
		t.Fatal("could not bind the exact local service profile")
	}
	c.Profiles = []ServiceConfigureProfile{p}
	sd := &fakeSystemd{loadState: "loaded", active: "inactive", afterAction: "active", exit: map[string]int{}}
	e := &Env{Cfg: Config{ServiceConfigure: c, Services: ServicesConfig{RestartAllow: []string{p.Unit}}}, Runner: sd}
	a := serviceConfigureArgs{Unit: p.Unit, ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}
	r := serviceRun(t, e, a)
	if !r.OK || r.Err != "" || r.Output != nil || r.Data["changed"] != true || r.Data["created"] != true || r.Data["bytesWritten"] != len(desired) || r.Data["action"] != "restart" || r.Data["activeState"] != "active" || r.Data["phase"] != "verified" || r.Data["effect"] != "committed" || r.Data["postcondition"] != "verified" || r.Data["unit"] != p.Unit || r.Data["profileRef"] != p.ProfileRef || r.Data["profileVersion"] != p.ProfileVersion || r.Data["backupRef"] != nil {
		t.Fatal("actual service mapper did not produce the exact verified create receipt")
	}
	if got := sd.actions(); len(got) != 1 || got[0] != "restart --no-pager -- app.service" {
		t.Fatal("inactive reload profile did not use the fixed modeled restart")
	}
	actual, targetStat, err := writeRead(owned[0].fd, "app.env", 1024, false)
	if err != nil || !bytes.Equal(actual, desired) || targetStat.Mode&07777 != 0600 || targetStat.Uid != uint32(os.Geteuid()) || targetStat.Nlink != 1 {
		t.Fatal("service golden has no exact private target-file custody")
	}
	ref, ok := r.Data["transactionRef"].(string)
	if !ok || !regexp.MustCompile(`^fw_[0-9a-f]{32}$`).MatchString(ref) {
		t.Fatal("actual service mapper lost its opaque transaction identity")
	}
	intentBytes, intentStat, err := writeRead(owned[2].fd, ref+".json", 4096, false)
	var intent map[string]any
	if err != nil || intentStat.Mode&syscall.S_IFMT != syscall.S_IFREG || intentStat.Mode&07777 != 0600 || intentStat.Uid != uint32(os.Geteuid()) || intentStat.Nlink != 1 || json.Unmarshal(intentBytes, &intent) != nil || len(intent) != 10 || intent["version"] != float64(1) || intent["operation"] != OpServiceConfigure || intent["profileRef"] != p.ProfileRef || intent["profileVersion"] != p.ProfileVersion || intent["path"] != p.Path || intent["priorSha256"] != nil || intent["desiredSha256"] != p.SHA256 || intent["mode"] != p.Mode || intent["created"] != true || intent["state"] != "commit-may-have-run" || intent["contentRef"] != nil || intent["contentVersion"] != nil || intent["bytes"] != nil {
		t.Fatal("service golden has no exact purpose-bound private original intent")
	}
	if _, err := os.Lstat(filepath.Join(c.BackupDir, ref+".data")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("service create claimed an unexpected prior-byte backup")
	}
	assertNoLeak(t, r, p)
	wire, err := json.Marshal(r)
	if err != nil || bytes.Contains(wire, bytes.TrimSpace(desired)) {
		t.Fatal("service golden leaked local approved configuration bytes")
	}
	// A real unchanged attempt and an inexact-prior refusal must preserve the
	// committed target and must not create another intent or service action.
	h := p.SHA256
	current := a
	current.ExpectedSHA256 = &h
	noop := serviceRun(t, e, current)
	if !noop.OK || noop.Data["changed"] != false || noop.Data["action"] != "none" || noop.Data["effect"] != "none" || noop.Data["transactionRef"] != nil {
		t.Fatal("actual service golden did not retain the verified unchanged boundary")
	}
	refused := serviceRun(t, e, a)
	if refused.OK || refused.Data["effect"] != "none" || refused.Data["transactionRef"] != nil || len(sd.actions()) != 1 {
		t.Fatal("actual service golden did not refuse the inexact prior without effects")
	}
	writeAssertBytes(t, p.Path, desired)
	retained, err := os.ReadDir(c.BackupDir)
	if err != nil || len(retained) != 1 || retained[0].Name() != ref+".json" {
		t.Fatal("service golden lost or added private intent custody")
	}
	assertNoLeak(t, noop, p)
	assertNoLeak(t, refused, p)
	// This is the only normalization. Every other result and argument field is
	// emitted by the actual handler/profile mapper and compared without edits.
	copyData := make(map[string]any, len(r.Data))
	for key, value := range r.Data {
		copyData[key] = value
	}
	r.Data = copyData
	r.Data["transactionRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	compareGolden(t, OpServiceConfigure, map[string]any{"operation": OpServiceConfigure, "args": a, "result": r})
}
