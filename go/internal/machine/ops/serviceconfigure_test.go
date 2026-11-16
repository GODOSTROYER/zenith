package ops

import (
	"encoding/json"
	"strings"
	"testing"
)

func serviceMetadata(t *testing.T) (Config, ServiceConfigureProfile) {
	t.Helper()
	p := ServiceConfigureProfile{Unit: "app.service", ProfileRef: "app-config", Path: "/opt/customer/app/app.env", SourcePath: "/opt/customer/templates/app.env", SHA256: strings.Repeat("a", 64), Mode: "0600", MaxBytes: 1024, Action: "restart", SettleSec: 5}
	sc := ServiceConfigureConfig{Enabled: true, BackupDir: "/opt/customer/sc-backups", MaxBackupBytes: 4096, MaxBackups: 4}
	v, err := ServiceConfigureProfileVersion(sc, p)
	if err != nil {
		t.Fatal(err)
	}
	p.ProfileVersion = v
	sc.Profiles = []ServiceConfigureProfile{p}
	return Config{ServiceConfigure: sc, Services: ServicesConfig{RestartAllow: []string{"app.service"}}}, p
}

func TestServiceConfigureStrictArgsAndPriorPreconditions(t *testing.T) {
	_, p := serviceMetadata(t)
	a := serviceConfigureArgs{Unit: p.Unit, ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}
	raw, _ := json.Marshal(a)
	if got, err := parseServiceConfigure(raw); err != nil || got.ExpectedSHA256 != nil || got.ProfileVersion != p.ProfileVersion {
		t.Fatal("explicit absent-target admission was refused")
	}
	prior := strings.Repeat("b", 64)
	a.ExpectedSHA256 = &prior
	raw, _ = json.Marshal(a)
	if got, err := parseServiceConfigure(raw); err != nil || got.ExpectedSHA256 == nil || *got.ExpectedSHA256 != prior {
		t.Fatal("exact prior digest precondition was refused")
	}
	good := string(raw)
	for _, hostile := range []string{
		strings.Replace(good, `,"expectedSha256":"`+prior+`"`, "", 1),
		strings.Replace(good, `"unit":`, `"unit":"other.service","unit":`, 1),
		strings.Replace(good, `"profileRef"`, `"contentRef"`, 1),
		strings.Replace(good, p.Unit, "app.socket", 1),
		strings.Replace(good, p.Unit, "app.timer", 1),
		strings.Replace(good, p.Unit, "sshd.service", 1),
		strings.Replace(good, p.Unit, "zenithd.service", 1),
		strings.Replace(good, p.Unit, "systemd-journald.service", 1),
		strings.Replace(good, p.Unit, "-app.service", 1),
		strings.Replace(good, p.Unit, "app.service; id", 1),
		strings.Replace(good, p.ProfileRef, "../config", 1),
		strings.Replace(good, prior, "*", 1),
		strings.TrimSuffix(good, "}") + `,"path":"/etc/app.conf"}`,
		strings.TrimSuffix(good, "}") + `,"action":"restart"}`,
		strings.TrimSuffix(good, "}") + `,"content":"inert-config-marker"}`,
		strings.TrimSuffix(good, "}") + `,"argv":["/bin/sh"]}`,
		good + ` {}`,
	} {
		if _, err := parseServiceConfigure(json.RawMessage(hostile)); err == nil {
			t.Fatal("hostile service configuration metadata was accepted: " + hostile)
		} else if strings.Contains(err.Error(), "inert-config-marker") {
			t.Fatal("contents escaped through diagnostics")
		}
	}
	for _, bad := range []map[string]any{{"pathPrefixes": []any{"/opt/customer"}}, {"maxLines": float64(1)}, {"unitPrefix": "app"}, {"maxTimeoutSec": float64(1.5)}, {"maxOutputBytes": "4096"}} {
		if ValidateServiceConfigureConstraints(raw, bad) == nil {
			t.Fatal("unknown or foreign service constraint was accepted")
		}
	}
	if ValidateServiceConfigureConstraints(raw, map[string]any{"maxTimeoutSec": float64(60), "maxOutputBytes": float64(4096)}) != nil {
		t.Fatal("bounded exact service grant was refused")
	}
}

func TestServiceConfigureVersionSeparatesPurposeAndBindsAllLocalSemantics(t *testing.T) {
	cfg, p := serviceMetadata(t)
	writeVersion, err := FileWriteProfileVersion(serviceBudget(cfg.ServiceConfigure), serviceFileProfile(p))
	if err != nil || writeVersion == p.ProfileVersion {
		t.Fatal("service and write profile purposes collided")
	}
	for name, mutate := range map[string]func(*ServiceConfigureConfig, *ServiceConfigureProfile){
		"unit": func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.Unit = "other.service" },
		"ref":  func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.ProfileRef = "other" },
		"path": func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.Path = "/opt/customer/app/other.env" },
		"source": func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) {
			p.SourcePath = "/opt/customer/templates/other.env"
		},
		"digest":      func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.SHA256 = strings.Repeat("b", 64) },
		"mode":        func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.Mode = "0640" },
		"maxBytes":    func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.MaxBytes++ },
		"action":      func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.Action = "reload" },
		"settle":      func(_ *ServiceConfigureConfig, p *ServiceConfigureProfile) { p.SettleSec++ },
		"backupCount": func(c *ServiceConfigureConfig, _ *ServiceConfigureProfile) { c.MaxBackups++ },
		"backupBytes": func(c *ServiceConfigureConfig, _ *ServiceConfigureProfile) { c.MaxBackupBytes++ },
		"backupLocation": func(c *ServiceConfigureConfig, _ *ServiceConfigureProfile) {
			c.BackupDir = "/opt/customer/other-backups"
		},
	} {
		changed, profile := cfg.ServiceConfigure, p
		mutate(&changed, &profile)
		changed.Profiles = []ServiceConfigureProfile{profile}
		if ValidateServiceConfigureConfig(changed) == nil {
			t.Fatal("unchanged version accepted changed local semantics: " + name)
		}
	}
	cfg.ServiceConfigure.Profiles[0].ProfileVersion = writeVersion
	if ValidateServiceConfigureConfig(cfg.ServiceConfigure) == nil {
		t.Fatal("write version substituted for service version")
	}
}

func TestServiceConfigureRejectsUnsafeProfiles(t *testing.T) {
	cfg, p := serviceMetadata(t)
	for name, mutate := range map[string]func(*ServiceConfigureProfile){
		"socket unit":      func(p *ServiceConfigureProfile) { p.Unit = "app.socket" },
		"protected unit":   func(p *ServiceConfigureProfile) { p.Unit = "sshd.service" },
		"zenithd itself":   func(p *ServiceConfigureProfile) { p.Unit = "zenithd.service" },
		"unknown action":   func(p *ServiceConfigureProfile) { p.Action = "stop" },
		"shell action":     func(p *ServiceConfigureProfile) { p.Action = "restart; id" },
		"no settle":        func(p *ServiceConfigureProfile) { p.SettleSec = 0 },
		"long settle":      func(p *ServiceConfigureProfile) { p.SettleSec = 61 },
		"etc destination":  func(p *ServiceConfigureProfile) { p.Path = "/etc/app/app.env" },
		"unit file target": func(p *ServiceConfigureProfile) { p.Path = "/opt/customer/app/app.service" },
		"systemd dir":      func(p *ServiceConfigureProfile) { p.Path = "/opt/customer/systemd/app.env" },
		"world mode":       func(p *ServiceConfigureProfile) { p.Mode = "0644" },
		"source is dest":   func(p *ServiceConfigureProfile) { p.SourcePath = p.Path },
	} {
		q := p
		mutate(&q)
		if v, err := ServiceConfigureProfileVersion(cfg.ServiceConfigure, q); err == nil {
			q.ProfileVersion = v
			c := cfg.ServiceConfigure
			c.Profiles = []ServiceConfigureProfile{q}
			if ValidateServiceConfigureConfig(c) == nil {
				t.Fatal("unsafe service profile accepted: " + name)
			}
		}
	}
}

func TestServiceConfigureDefaultsOffAndRequiresRestartAuthority(t *testing.T) {
	if ValidateServiceConfigureConfig(ServiceConfigureConfig{}) != nil {
		t.Fatal("service configuration must default off")
	}
	for _, op := range Supported(Config{}) {
		if op == OpServiceConfigure {
			t.Fatal("service.configure advertised by default")
		}
	}
	cfg, _ := serviceMetadata(t)
	for _, op := range Supported(Config{ServiceConfigure: cfg.ServiceConfigure}) {
		if op == OpServiceConfigure {
			t.Fatal("service.configure advertised without any restart authority")
		}
	}
	// the profile's unit must already be inside the machine's restart allowlist
	if ValidateFileMutationConfig(cfg) != nil {
		t.Fatal("profile within restart authority was refused")
	}
	for _, allow := range [][]string{nil, {"other.service"}, {"app@*.service"}} {
		cfg.Services.RestartAllow = allow
		if ValidateFileMutationConfig(cfg) == nil {
			t.Fatal("profile outside restart authority was accepted")
		}
	}
}

func TestServiceConfigureCustodyIsSeparateFromFileOperations(t *testing.T) {
	cfg, p := serviceMetadata(t)
	wc := FileWriteConfig{Enabled: true, BackupDir: "/opt/customer/write-backups", MaxBackupBytes: 4096, MaxBackups: 4}
	write := FileWriteProfile{Path: "/opt/customer/app/settings.txt", ContentRef: "settings", SourcePath: "/opt/customer/templates/settings.txt", SHA256: strings.Repeat("c", 64), Mode: "0600", MaxBytes: 1024}
	write.ContentVersion, _ = FileWriteProfileVersion(wc, write)
	wc.Profiles = []FileWriteProfile{write}
	both := cfg
	both.FileWrite = wc
	if err := ValidateFileMutationConfig(both); err != nil {
		t.Fatal("disjoint purpose-separated profiles were refused:", err)
	}
	// same destination
	same := write
	same.Path = p.Path
	same.ContentVersion, _ = FileWriteProfileVersion(wc, same)
	clash := both
	clash.FileWrite.Profiles = []FileWriteProfile{same}
	if ValidateFileMutationConfig(clash) == nil {
		t.Fatal("service destination aliased a file.write destination")
	}
	// file.write destination overwrote the service source
	over := write
	over.Path = p.SourcePath
	over.ContentVersion, _ = FileWriteProfileVersion(wc, over)
	clash = both
	clash.FileWrite.Profiles = []FileWriteProfile{over}
	if ValidateFileMutationConfig(clash) == nil {
		t.Fatal("file.write overwrote service source custody")
	}
	// shared private backup store
	shared := both
	shared.FileWrite.BackupDir = shared.ServiceConfigure.BackupDir
	shared.FileWrite.Profiles = nil
	shared.FileWrite.Enabled = false
	if ValidateFileMutationConfig(shared) == nil {
		t.Fatal("service shared a private backup store with file.write")
	}
	// service destination under any retained backup store
	nested := both
	nested.FileWrite.BackupDir = "/opt/customer/app"
	nested.FileWrite.Profiles = nil
	nested.FileWrite.Enabled = false
	if ValidateFileMutationConfig(nested) == nil {
		t.Fatal("service destination lies under another operation's backup custody")
	}
	// package helper custody
	pkg := cfg
	pkg.PackageInstall = PackageInstallConfig{Enabled: true, Profiles: []PackageInstallProfile{{ProfileRef: "bundle"}}}
	pkg.ServiceConfigure.BackupDir = "/var/lib/zenithd-package-install/backups"
	if ValidateFileMutationConfig(pkg) == nil {
		t.Fatal("service backup custody overlapped the package helper subtree")
	}
}
