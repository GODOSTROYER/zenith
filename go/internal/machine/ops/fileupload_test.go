package ops

import (
	"encoding/json"
	"strings"
	"testing"
)

func uploadMetadata(t *testing.T) (FileUploadConfig, FileUploadProfile) {
	t.Helper()
	p := FileUploadProfile{Path: "/opt/customer/model.bin", SourceRef: "model", SourcePath: "/opt/customer/sources/model.bin", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024}
	c := FileUploadConfig{Enabled: true, BackupDir: "/opt/customer/backups", MaxBackupBytes: 4096, MaxBackups: 4}
	v, err := FileUploadProfileVersion(c, p)
	if err != nil {
		t.Fatal(err)
	}
	p.SourceVersion = v
	c.Profiles = []FileUploadProfile{p}
	return c, p
}

func TestUploadStrictMetadataAndPriorPreconditions(t *testing.T) {
	_, p := uploadMetadata(t)
	a := fileUploadArgs{Path: p.Path, SourceRef: p.SourceRef, SourceVersion: p.SourceVersion}
	raw, _ := json.Marshal(a)
	if got, err := parseFileUpload(raw); err != nil || got.ExpectedSHA256 != nil || got.SourceVersion != p.SourceVersion {
		t.Fatal("explicit absent-target admission was refused")
	}
	prior := strings.Repeat("b", 64)
	a.ExpectedSHA256 = &prior
	raw, _ = json.Marshal(a)
	if got, err := parseFileUpload(raw); err != nil || got.ExpectedSHA256 == nil || *got.ExpectedSHA256 != prior {
		t.Fatal("exact replacement precondition was refused")
	}
	good := string(raw)
	for _, hostile := range []string{
		strings.Replace(good, `,"expectedSha256":"`+prior+`"`, "", 1),
		strings.Replace(good, `"path":`, `"path":"/opt/customer/other.bin","path":`, 1),
		strings.Replace(good, `"sourceRef"`, `"contentRef"`, 1),
		strings.Replace(good, `"sourceVersion"`, `"contentVersion"`, 1),
		strings.Replace(good, `"model"`, `"https://example.invalid/model"`, 1),
		strings.Replace(good, p.Path, "/etc/customer/model.bin", 1),
		strings.Replace(good, p.Path, "/opt/customer/../model.bin", 1),
		strings.Replace(good, prior, "*", 1),
		strings.TrimSuffix(good, "}") + `,"bytes":"inert-upload-marker"}`,
		strings.TrimSuffix(good, "}") + `,"sourcePath":"/private/model"}`,
		good + ` {}`,
	} {
		if _, err := parseFileUpload(json.RawMessage(hostile)); err == nil {
			t.Fatal("hostile upload metadata was accepted")
		} else if strings.Contains(err.Error(), "inert-upload-marker") {
			t.Fatal("upload contents escaped through diagnostics")
		}
	}
	for _, bad := range []map[string]any{{"pathPrefixes": []any{"/opt/customer-other"}}, {"maxLines": float64(1)}, {"sourceURL": true}, {"maxTimeoutSec": float64(1.5)}} {
		if ValidateFileUploadConstraints(raw, bad) == nil {
			t.Fatal("unknown or foreign upload constraint was accepted")
		}
	}
	if ValidateFileUploadConstraints(raw, map[string]any{"pathPrefixes": []any{"/opt/customer"}, "maxOutputBytes": float64(4096)}) != nil {
		t.Fatal("bounded exact upload grant was refused")
	}
}

func TestUploadVersionSeparatesPurposeAndAllLocalSemantics(t *testing.T) {
	c, p := uploadMetadata(t)
	if p.SourceVersion != "3bb0a75afec194631fef7a4827441ba9fa7a2264804a8a910758ee1979c9a63e" {
		t.Fatal("canonical upload metadata domain changed")
	}
	writeVersion, err := FileWriteProfileVersion(uploadBudget(c), uploadProfile(p))
	if err != nil || writeVersion == p.SourceVersion {
		t.Fatal("upload and write profile purposes collided")
	}
	for _, mutate := range []func(*FileUploadConfig, *FileUploadProfile){
		func(_ *FileUploadConfig, p *FileUploadProfile) { p.SourceRef = "other" },
		func(_ *FileUploadConfig, p *FileUploadProfile) { p.SourcePath = "/opt/customer/sources/other.bin" },
		func(_ *FileUploadConfig, p *FileUploadProfile) { p.SHA256 = strings.Repeat("b", 64) },
		func(_ *FileUploadConfig, p *FileUploadProfile) { p.Mode = "0640" },
		func(_ *FileUploadConfig, p *FileUploadProfile) { p.MaxBytes++ },
		func(c *FileUploadConfig, _ *FileUploadProfile) { c.MaxBackups++ },
		func(c *FileUploadConfig, _ *FileUploadProfile) { c.MaxBackupBytes++ },
		func(c *FileUploadConfig, _ *FileUploadProfile) { c.BackupDir = "/opt/customer/other-backups" },
	} {
		changed, profile := c, p
		mutate(&changed, &profile)
		changed.Profiles = []FileUploadProfile{profile}
		if ValidateFileUploadConfig(changed) == nil {
			t.Fatal("unchanged version accepted changed local upload semantics")
		}
	}
	c.Profiles[0].SourceVersion = writeVersion
	if ValidateFileUploadConfig(c) == nil {
		t.Fatal("write version substituted for upload version")
	}
}

func TestUploadDefaultsAndCrossOperationCustody(t *testing.T) {
	if ValidateFileUploadConfig(FileUploadConfig{}) != nil {
		t.Fatal("upload must default off")
	}
	for _, op := range Supported(Config{}) {
		if op == OpFileUpload {
			t.Fatal("upload advertised by default")
		}
	}
	c, p := uploadMetadata(t)
	disabled := Config{FileWrite: FileWriteConfig{Profiles: []FileWriteProfile{{Path: p.Path, SourcePath: p.Path}}}}
	if ValidateFileMutationConfig(disabled) != nil {
		t.Fatal("disabled destination validation unexpectedly enabled mutation admission")
	}
	write := uploadProfile(p)
	write.Path = "/opt/customer/settings.txt"
	write.SourcePath = p.Path
	wc := FileWriteConfig{Enabled: true, BackupDir: "/opt/customer/write-backups", MaxBackupBytes: 4096, MaxBackups: 4}
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	if ValidateFileMutationConfig(Config{FileUpload: c, FileWrite: wc}) == nil {
		t.Fatal("upload destination overwrote a write source")
	}
	wc.Enabled = false
	if ValidateFileMutationConfig(Config{FileUpload: c, FileWrite: wc}) == nil {
		t.Fatal("upload overwrote retained source custody of disabled write")
	}
	wc.Enabled = true
	write.SourcePath = "/opt/customer/templates/settings.txt"
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	if ValidateFileMutationConfig(Config{FileUpload: c, FileWrite: wc}) != nil {
		t.Fatal("disjoint purpose-separated profiles were refused")
	}

	inactive := c
	inactive.Enabled = false
	write.Path = p.SourcePath
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	if ValidateFileMutationConfig(Config{FileUpload: inactive, FileWrite: wc}) == nil {
		t.Fatal("write overwrote retained source custody of disabled upload")
	}
	write.Path = "/opt/customer/settings.txt"
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	c.Profiles[0].Path = wc.BackupDir + "/model.bin"
	c.Profiles[0].SourceVersion, _ = FileUploadProfileVersion(c, c.Profiles[0])
	if ValidateFileMutationConfig(Config{FileUpload: c, FileWrite: wc}) == nil {
		t.Fatal("upload destination overwrote write backup custody")
	}
}
