package ops

import (
	"encoding/json"
	"strings"
	"testing"
)

func packageModelProfile(t *testing.T) PackageInstallProfile {
	t.Helper()
	p := PackageInstallProfile{ProfileRef: "bundle", Package: "zenith-data-bundle", Version: "1.0", Architecture: "amd64", SourcePath: "/var/lib/zenithd-package-install/archives/bundle.deb", SHA256: strings.Repeat("a", 64), ArchiveBytes: 1024, Payload: []PackagePayloadFile{{Path: "/opt/zenith-packages/bundle", Kind: "directory", Mode: "0755"}, {Path: "/opt/zenith-packages/bundle/data", Kind: "file", Mode: "0644", Bytes: 1, SHA256: strings.Repeat("b", 64)}}}
	v, e := PackageInstallProfileVersion(p)
	if e != nil {
		t.Fatal(e)
	}
	p.ProfileVersion = v
	return p
}
func TestPackageInstallStrictArgs(t *testing.T) {
	p := packageModelProfile(t)
	raw, _ := json.Marshal(PackageInstallArgs{ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion})
	if _, e := ParsePackageInstallArgs(raw); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{`{}`, `{"profileRef":"bundle","profileRef":"other","profileVersion":"` + p.ProfileVersion + `","expectedInstalledVersion":null}`, `{"profileRef":"../bundle","profileVersion":"` + p.ProfileVersion + `","expectedInstalledVersion":null}`, `{"profileRef":"bundle","profileVersion":"` + p.ProfileVersion + `","expectedInstalledVersion":"*"}`, `{"profileRef":"bundle","profileVersion":"` + p.ProfileVersion + `","expectedInstalledVersion":null,"argv":["/bin/sh"]}`} {
		if _, e := ParsePackageInstallArgs(json.RawMessage(bad)); e == nil {
			t.Fatal("unsafe package schema accepted")
		}
	}
}
func TestPackageInstallVersionBindsEntireEffects(t *testing.T) {
	p := packageModelProfile(t)
	v := p.ProfileVersion
	for _, change := range []func(*PackageInstallProfile){func(q *PackageInstallProfile) { q.Version = "2.0" }, func(q *PackageInstallProfile) { q.Architecture = "arm64" }, func(q *PackageInstallProfile) { q.SHA256 = strings.Repeat("c", 64) }, func(q *PackageInstallProfile) { q.Payload[1].SHA256 = strings.Repeat("d", 64) }, func(q *PackageInstallProfile) { q.Payload[1].Mode = "0755" }, func(q *PackageInstallProfile) { q.SourcePath = "/var/lib/zenithd-package-install/archives/other.deb" }} {
		q := p
		q.Payload = append([]PackagePayloadFile(nil), p.Payload...)
		change(&q)
		got, e := PackageInstallProfileVersion(q)
		if e != nil || got == v {
			t.Fatal("effect mutation did not change profile version")
		}
	}
}
func TestPackageInstallRejectsUnsafePayloadMetadata(t *testing.T) {
	p := packageModelProfile(t)
	for _, mutate := range []func(*PackageInstallProfile){func(q *PackageInstallProfile) { q.Payload[1].Path = "/etc/cron.d/task" }, func(q *PackageInstallProfile) { q.Payload[1].Kind = "symlink" }, func(q *PackageInstallProfile) { q.Payload[1].Mode = "4755" }, func(q *PackageInstallProfile) { q.Payload = q.Payload[1:] }, func(q *PackageInstallProfile) { q.Payload[0].Kind = "file" }, func(q *PackageInstallProfile) { q.ArchiveBytes = 4<<20 + 1 }, func(q *PackageInstallProfile) { q.SourcePath = "/tmp/bundle.deb" }} {
		q := p
		q.Payload = append([]PackagePayloadFile(nil), p.Payload...)
		mutate(&q)
		if _, e := PackageInstallProfileVersion(q); e == nil {
			t.Fatal("unsafe payload profile accepted")
		}
	}
}
func TestPackageInstallDisabledFileCustodyStillConflicts(t *testing.T) {
	p := packageModelProfile(t)
	c := Config{PackageInstall: PackageInstallConfig{Enabled: true, Profiles: []PackageInstallProfile{p}}}
	for _, guard := range []Config{{FileWrite: FileWriteConfig{Profiles: []FileWriteProfile{{Path: "/opt/zenith-packages/bundle/data"}}}}, {FileWrite: FileWriteConfig{Profiles: []FileWriteProfile{{SourcePath: "/var/lib/zenithd-package-install/archives/bundle.deb"}}}}, {FileUpload: FileUploadConfig{BackupDir: "/var/lib/zenithd-package-install"}}, {FileUpload: FileUploadConfig{Profiles: []FileUploadProfile{{Path: "/run/zenithd-package-install/install.sock"}}}}} {
		q := c
		q.FileWrite = guard.FileWrite
		q.FileUpload = guard.FileUpload
		if ValidatePackageInstallIsolation(q) == nil {
			t.Fatal("disabled file custody overlap accepted")
		}
	}
	if ValidatePackageInstallIsolation(c) != nil {
		t.Fatal("disjoint package profile refused")
	}
}
func TestPackageInstallUnknownConstraintsRefuse(t *testing.T) {
	p := packageModelProfile(t)
	raw, _ := json.Marshal(PackageInstallArgs{ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion})
	if ValidatePackageInstallConstraints(raw, map[string]any{"maxTimeoutSec": float64(30), "maxOutputBytes": float64(4096)}) != nil {
		t.Fatal("bounded limits refused")
	}
	for _, c := range []map[string]any{{"pathPrefixes": []any{"/opt"}}, {"maxTimeoutSec": 1.5}, {"maxOutputBytes": "2048"}, {"repository": "https://example.invalid"}} {
		if ValidatePackageInstallConstraints(raw, c) == nil {
			t.Fatal("unenforceable constraint accepted")
		}
	}
}
