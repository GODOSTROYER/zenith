package ops

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWriteStrictArgsAndConstraints(t *testing.T) {
	// Go regex repetitions stop at 1000. Preserve the 1024-byte path contract
	// with a separate bound, including the previously unexecutable boundary.
	for _, size := range []int{2, 1000, 1001, 1024} {
		if !canonicalWritePath("/" + strings.Repeat("a", size-1)) {
			t.Fatal("canonical path within the original byte bound was refused")
		}
	}
	for _, p := range []string{"", "/", "/" + strings.Repeat("a", 1024), "/opt/\u00e9", "/opt//app", "/opt/../app", "/opt/app/", "/opt/app\n"} {
		if canonicalWritePath(p) {
			t.Fatal("overlong or noncanonical path was accepted")
		}
	}
	good := `{"path":"/opt/customer/settings.txt","contentRef":"settings","contentVersion":"` + strings.Repeat("c", 64) + `","expectedSha256":null}`
	if _, err := parseFileWrite(json.RawMessage(good)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		strings.Replace(good, `,"expectedSha256":null`, "", 1),
		strings.Replace(good, `"path":`, `"path":"/opt/customer/other.txt","path":`, 1),
		strings.Replace(good, `"settings"`, `"https://example.invalid/a"`, 1),
		strings.Replace(good, `"`+strings.Repeat("c", 64)+`"`, `"../v1"`, 1),
		strings.Replace(good, `null`, `"bad-digest"`, 1),
		strings.Replace(good, `settings.txt`, `../settings.txt`, 1),
		strings.Replace(good, `settings.txt`, `config.yaml`, 1),
		strings.Replace(good, `/opt/customer/`, `/etc/`, 1),
		strings.TrimSuffix(good, "}") + `,"content":"inert-plaintext-marker"}`,
		good + ` {}`,
	} {
		if _, err := parseFileWrite(json.RawMessage(raw)); err == nil {
			t.Fatal("hostile write args were accepted")
		} else if strings.Contains(err.Error(), "inert-plaintext-marker") {
			t.Fatal("input plaintext leaked in error")
		}
	}
	for _, c := range []map[string]any{
		{"pathPrefixes": []any{"/opt/customer"}},
		{"maxTimeoutSec": float64(10), "maxOutputBytes": float64(4096)},
	} {
		if err := ValidateFileWriteConstraints(json.RawMessage(good), c); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []map[string]any{
		{"pathPrefixes": []any{"/opt/customer-other"}},
		{"pathPrefixes": []any{"/opt//customer"}},
		{"pathPrefixes": []any{}},
		{"maxLines": float64(1)},
		{"allowWrite": true},
		{"maxTimeoutSec": float64(1.5)},
	} {
		if ValidateFileWriteConstraints(json.RawMessage(good), c) == nil {
			t.Fatal("unenforced or mismatched constraint was accepted")
		}
	}
}
func TestWriteDisabledAndInvalidProfiles(t *testing.T) {
	if ValidateFileWriteConfig(FileWriteConfig{}) != nil {
		t.Fatal("default must remain off")
	}
	p := FileWriteProfile{Path: "/opt/customer/settings.txt", ContentRef: "settings", ContentVersion: "v1", SourcePath: "/opt/customer/templates/settings.txt", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024}
	c := FileWriteConfig{Enabled: true, BackupDir: "/opt/customer/backups", MaxBackupBytes: 4096, MaxBackups: 4, Profiles: []FileWriteProfile{p}}
	version, err := FileWriteProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	p.ContentVersion = version
	c.Profiles[0] = p
	if err := ValidateFileWriteConfig(c); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"0777", "0644", "755", "0"} {
		c.Profiles[0].Mode = mode
		if ValidateFileWriteConfig(c) == nil {
			t.Fatal("arbitrary mode accepted")
		}
	}
	c.Profiles[0] = p
	c.Profiles = append(c.Profiles, p)
	if ValidateFileWriteConfig(c) == nil {
		t.Fatal("duplicate destinations accepted")
	}
	for _, op := range Supported(Config{}) {
		if op == OpFileWrite {
			t.Fatal("writes advertised by default")
		}
	}
}

func TestImmutableProfileVersionCanonicalContract(t *testing.T) {
	p := FileWriteProfile{Path: "/opt/customer/settings.txt", ContentRef: "settings", SourcePath: "/opt/customer/templates/settings.txt", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024}
	c := FileWriteConfig{Enabled: true, BackupDir: "/opt/customer/backups", MaxBackupBytes: 4096, MaxBackups: 4}
	version, err := FileWriteProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	if version != "35151291277ab8b765fd6cd5495149778c3fa28673d82ac6d2b295aff74a9c82" {
		t.Fatal("canonical domain-separated profile version changed")
	}
	p.ContentVersion = "ignored-only-by-metadata-computation"
	again, err := FileWriteProfileVersion(c, p)
	if err != nil || again != version {
		t.Fatal("version must exclude itself")
	}
}
