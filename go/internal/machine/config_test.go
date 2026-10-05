package machine

import (
	"bytes"
	"encoding/json"
	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

func TestLocalTemplateConfigDefaultAndValidation(t *testing.T) {
	p := filepath.Join(t.TempDir(), "zenithd.json")
	if err := os.WriteFile(p, []byte(`{"controlPlane":{"url":"https://example.invalid"},"name":"fixture"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(p, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.FileWrite.Enabled {
		t.Fatal("writes must default off")
	}
	cfg.FileWrite = ops.FileWriteConfig{Enabled: true}
	if cfg.Validate() == nil {
		t.Fatal("enabled writes without bounded immutable profile accepted")
	}
}

func TestFileWriteVersionsCLIUsesMetadataOnlyAndLoadingEnforcesVersion(t *testing.T) {
	p := ops.FileWriteProfile{Path: "/opt/customer/settings.txt", ContentRef: "settings", ContentVersion: "v1", SourcePath: "/opt/customer/templates/source-metadata-private.txt", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024}
	c := ops.FileWriteConfig{Enabled: true, BackupDir: "/opt/customer/backups", MaxBackupBytes: 4096, MaxBackups: 4, Profiles: []ops.FileWriteProfile{p}}
	version, err := ops.FileWriteProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(t.TempDir(), "zenithd.json")
	save := func() {
		raw, err := json.Marshal(map[string]any{"controlPlane": map[string]string{"url": "https://example.invalid"}, "name": "fixture", "fileWrite": c})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfgPath, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save()
	var out, errOut bytes.Buffer
	if code := Main([]string{"file-write-versions", "--config", cfgPath}, &out, &errOut, func(string) string { return "" }); code != agent.ExitOK {
		t.Fatal("metadata-only CLI failed")
	}
	if !strings.Contains(out.String(), version) || strings.Contains(out.String(), p.SourcePath) || strings.Contains(out.String(), p.SHA256) {
		t.Fatal("CLI must expose path/ref/version only, without local source identity/hash")
	}
	if _, err := LoadConfig(cfgPath, func(string) string { return "" }); err == nil {
		t.Fatal("ordinary config load accepted reused arbitrary version")
	}
	c.Profiles[0].ContentVersion = version
	save()
	if _, err := LoadConfig(cfgPath, func(string) string { return "" }); err != nil {
		t.Fatal("derived immutable metadata version should validate without reading template bytes", err)
	}
}

func TestFileUploadVersionsMetadataOnlyAndDefaultOff(t *testing.T) {
	p := ops.FileUploadProfile{Path: "/opt/customer/model.bin", SourceRef: "model", SourceVersion: "unreviewed", SourcePath: "/opt/customer/sources/private-model.bin", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024}
	c := ops.FileUploadConfig{Enabled: true, BackupDir: "/opt/customer/backups", MaxBackupBytes: 4096, MaxBackups: 4, Profiles: []ops.FileUploadProfile{p}}
	version, err := ops.FileUploadProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(t.TempDir(), "zenithd.json")
	save := func() {
		raw, err := json.Marshal(map[string]any{"controlPlane": map[string]string{"url": "https://example.invalid"}, "name": "fixture", "fileUpload": c})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfgPath, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	save()
	var out, errOut bytes.Buffer
	if code := Main([]string{"file-upload-versions", "--config", cfgPath}, &out, &errOut, func(string) string { return "" }); code != agent.ExitOK {
		t.Fatal("metadata-only upload version command refused")
	}
	if !strings.Contains(out.String(), version) || !strings.Contains(out.String(), "sourceVersion") || strings.Contains(out.String(), p.SourcePath) || strings.Contains(out.String(), p.SHA256) {
		t.Fatal("upload metadata command exposed local source custody")
	}
	if _, err := LoadConfig(cfgPath, func(string) string { return "" }); err == nil {
		t.Fatal("unreviewed upload version accepted")
	}
	c.Profiles[0].SourceVersion = version
	save()
	cfg, err := LoadConfig(cfgPath, func(string) string { return "" })
	if err != nil || cfg.FileWrite.Enabled {
		t.Fatal("valid upload metadata changed write default")
	}
	cfg.FileUpload = ops.FileUploadConfig{Enabled: true}
	if cfg.Validate() == nil {
		t.Fatal("unbounded upload configuration accepted")
	}
}

func TestPackageInstallDefaultOffAndUnboundedConfigRefused(t *testing.T) {
	cfg := Config{}
	cfg.ApplyDefaults(DefaultStateDir)
	cfg.applyDefaults()
	cfg.ControlPlane.URL = "https://example.invalid"
	cfg.Name = "fixture"
	cfg.Audit.Path = filepath.Join(cfg.StateDir, "audit.jsonl")
	if cfg.PackageInstall.Enabled {
		t.Fatal("package helper must require explicit opt-in")
	}
	cfg.PackageInstall = ops.PackageInstallConfig{Enabled: true}
	if cfg.Validate() == nil {
		t.Fatal("unbounded package profile enabled")
	}
}
