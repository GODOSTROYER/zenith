package machine

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

const packageObservedDockerFilters = "path-exclude /usr/share/doc/*\npath-exclude /usr/share/doc/kde/HTML/*/*\npath-exclude /usr/share/gnome/help/*/*\npath-exclude /usr/share/info/*\npath-exclude /usr/share/linda/*\npath-exclude /usr/share/lintian/overrides/*\npath-exclude /usr/share/locale/*\npath-exclude /usr/share/man/*\npath-exclude /usr/share/omf/*/*-*.emf\npath-include /usr/share/doc/*/copyright\npath-include /usr/share/doc/kde/HTML/C/*\npath-include /usr/share/gnome/help/*/C/*\npath-include /usr/share/locale/all_languages\npath-include /usr/share/locale/currency/*\npath-include /usr/share/locale/l10n/*\npath-include /usr/share/locale/languages\npath-include /usr/share/locale/locale.alias\npath-include /usr/share/omf/*/*-C.emf\n"

func packageNativeModel(t *testing.T) (map[string][]byte, map[string]map[string]string, packageHelperConfig, ops.PackageInstallProfile, pinnedDeb) {
	t.Helper()
	raw, p := packageModelDeb(t, packageModelControl, packageModelEntries())
	deb, e := parsePinnedDeb(raw, p)
	if e != nil {
		t.Fatal("canonical pinned data-only model archive refused")
	}
	files := map[string][]byte{
		"diversions":        []byte("/usr/share/man/man1/sh.1.gz\n/usr/share/man/man1/sh.distrib.1.gz\ndash\n/bin/sh\n/bin/sh.distrib\ndash\n"),
		"triggers/File":     []byte("/usr/share/debianutils/shells.d debianutils/noawait\n"),
		"triggers/Unincorp": {}, "triggers/ldconfig": []byte("libc-bin\n"),
		"config/dpkg.cfg":          []byte("# native configuration\nno-debsig\nlog /var/log/dpkg.log\n"),
		"config/dpkg.cfg.d/docker": []byte(packageObservedDockerFilters),
		"identity/passwd":          []byte("root:x:0:0:root:/root:/bin/sh\n"),
		"identity/group":           []byte("root:x:0:\n"),
		"identity/nsswitch.conf":   []byte("passwd: files systemd\ngroup: files systemd\n"),
	}
	installed := map[string]map[string]string{}
	for _, name := range []string{"dash", "debianutils", "libc-bin"} {
		installed[name] = map[string]string{"Package": name, "Status": "install ok installed", "Architecture": "amd64", "Version": "1"}
	}
	c := packageHelperConfig{PackageInstall: ops.PackageInstallConfig{Enabled: true, Profiles: []ops.PackageInstallProfile{p}}}
	return files, installed, c, p, deb
}

func TestPackageNativeRegistrationGrammarAndEffects(t *testing.T) {
	// These are pure modeled contracts, not installed-host or default authority
	// acceptance. The captured stock rows came from root's read-only 1.21.23 probe.
	for _, test := range []struct {
		name   string
		ok     bool
		mutate func(map[string][]byte, map[string]map[string]string, *packageHelperConfig, ops.PackageInstallProfile)
	}{
		{"observed stock registrations and all eighteen documentation filters", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
		}},
		{"disjoint numeric statoverride", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("#0 #0 755 /srv/disjoint\n")
		}},
		{"disjoint named identities from protected files first NSS", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 0755 /srv/disjoint\n")
		}},
		{"disjoint local diversion", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/one\n/srv/two\n:\n")
		}},
		{"matching architecture and explicit await interest", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("libc-bin:amd64/await\n")
		}},
		{"similarly named payload neighbor is disjoint", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/File"] = []byte("/opt/zenith-packages-other debianutils/noawait\n")
		}},
		{"inactive dotted config remains opaque", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg.d/disabled.conf"] = []byte("pre-invoke hostile\n")
		}},
		{"initialized native absence of File interests", true, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			delete(f, "triggers/File")
		}},
		{"missing Unincorp initialization refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			delete(f, "triggers/Unincorp")
		}},
		{"pending Unincorp is never settled", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/Unincorp"] = []byte("ldconfig -\n")
		}},
		{"native update record refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["updates/0001"] = []byte("Package: partial\n")
		}},
		{"pending installed tuple refuses", false, func(_ map[string][]byte, m map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			m["dash"]["Triggers-Pending"] = "ldconfig"
		}},
		{"awaited installed tuple refuses", false, func(_ map[string][]byte, m map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			m["dash"]["Triggers-Awaited"] = "libc-bin"
		}},
		{"half configured installed tuple refuses", false, func(_ map[string][]byte, m map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			m["dash"]["Status"] = "install ok half-configured"
		}},
		{"foreign installed interest refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("foreign\n")
		}},
		{"foreign architecture interest refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("libc-bin:arm64\n")
		}},
		{"unknown interest option refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("libc-bin/force\n")
		}},
		{"duplicate identity with conflicting interest flags refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("libc-bin\nlibc-bin:amd64/noawait\n")
		}},
		{"file interest missing final framing refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/File"] = []byte("/usr/share/debianutils/shells.d debianutils")
		}},
		{"duplicate file interest refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/File"] = append(f["triggers/File"], f["triggers/File"]...)
		}},
		{"unknown trigger filename refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/unknown_name"] = []byte("libc-bin\n")
		}},
		{"torn explicit trigger refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = []byte("libc-bin")
		}},
		{"empty transient explicit trigger refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/ldconfig"] = nil
		}},
		{"shared archive directory file trigger refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/File"] = []byte("/opt debianutils/noawait\n")
		}},
		{"payload subtree file trigger refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, p ops.PackageInstallProfile) {
			f["triggers/File"] = []byte("/opt/zenith-packages/" + p.ProfileRef + "/future debianutils/noawait\n")
		}},
		{"native custody trigger refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["triggers/File"] = []byte("/var/lib/dpkg debianutils/noawait\n")
		}},
		{"diversion source equal to payload ancestor refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/opt\n/srv/redirect\ndash\n")
		}},
		{"diversion redirect equal to source custody refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, p ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/original\n" + p.SourcePath + "\ndash\n")
		}},
		{"diversion payload descendant refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, p ops.PackageInstallProfile) {
			f["diversions"] = []byte("/opt/zenith-packages/" + p.ProfileRef + "/future\n/srv/redirect\ndash\n")
		}},
		{"incomplete diversion triplet refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/one\n/srv/two\n")
		}},
		{"torn diversion final frame refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/one\n/srv/two\ndash")
		}},
		{"chained or conflicting diversion endpoints refuse", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/one\n/srv/two\ndash\n/srv/two\n/srv/three\ndash\n")
		}},
		{"foreign diversion owner refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/one\n/srv/two\nforeign\n")
		}},
		{"noncanonical path refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["diversions"] = []byte("/srv/../opt\n/srv/two\ndash\n")
		}},
		{"equivalent mode shared directory statoverride refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /opt/zenith-packages\n")
		}},
		{"statoverride config custody refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("#0 #0 600 /etc/zenithd/package-install.json\n")
		}},
		{"duplicate statoverride refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("#0 #0 755 /srv/disjoint\n#0 #0 755 /srv/disjoint\n")
		}},
		{"invalid numeric identity refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("#4294967295 #0 755 /srv/disjoint\n")
		}},
		{"invalid octal mode refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("#0 #0 888 /srv/disjoint\n")
		}},
		{"unknown named identity refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("foreign root 755 /srv/disjoint\n")
		}},
		{"NSS network first identity refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			f["identity/nsswitch.conf"] = []byte("passwd: ldap files\ngroup: files\n")
		}},
		{"NSS success override refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			f["identity/nsswitch.conf"] = []byte("passwd: files [SUCCESS=continue] systemd\ngroup: files\n")
		}},
		{"malformed local passwd GID cannot fall through NSS", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			f["identity/passwd"] = []byte("root:x:0:not-a-gid:root:/root:/bin/sh\n")
		}},
		{"missing local passwd GID cannot fall through NSS", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			f["identity/passwd"] = []byte("root:x:0::root:/root:/bin/sh\n")
		}},
		{"duplicate local identity refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			f["identity/passwd"] = append(f["identity/passwd"], f["identity/passwd"]...)
		}},
		{"missing captured identity input refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["statoverride"] = []byte("root root 755 /srv/disjoint\n")
			delete(f, "identity/group")
		}},
		{"active dotted option alternative is not inferred", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg.d/active"] = []byte("path-exclude=/usr/share/doc/*\n")
		}},
		{"unsafe IO option remains refused", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg.d/docker"] = []byte("force-unsafe-io\n")
		}},
		{"force overwrite option refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte("force-overwrite\n")
		}},
		{"config native hook refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte("pre-invoke /srv/execute\n")
		}},
		{"alternate native root refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte("root /srv/root\n")
		}},
		{"arbitrary log refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte("log /srv/output\n")
		}},
		{"broad payload filter refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg.d/docker"] = []byte("path-exclude /opt/*\n")
		}},
		{"escaping documentation filter refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg.d/docker"] = []byte("path-exclude /usr/share/../../opt/*\n")
		}},
		{"leading whitespace cannot hide hook", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte(" pre-invoke hostile\n")
		}},
		{"torn active config refuses", false, func(f map[string][]byte, _ map[string]map[string]string, _ *packageHelperConfig, _ ops.PackageInstallProfile) {
			f["config/dpkg.cfg"] = []byte("no-debsig")
		}},
		{"disabled write source custody remains protected", false, func(f map[string][]byte, _ map[string]map[string]string, c *packageHelperConfig, _ ops.PackageInstallProfile) {
			c.FileWrite.Profiles = []ops.FileWriteProfile{{SourcePath: "/srv/source", Path: "/srv/output"}}
			f["diversions"] = []byte("/srv/source\n/srv/other\ndash\n")
		}},
		{"disabled upload destination custody remains protected", false, func(f map[string][]byte, _ map[string]map[string]string, c *packageHelperConfig, _ ops.PackageInstallProfile) {
			c.FileUpload.Profiles = []ops.FileUploadProfile{{SourcePath: "/srv/source", Path: "/srv/output"}}
			f["statoverride"] = []byte("#0 #0 600 /srv/output\n")
		}},
		{"documentation filters cannot overlap configured source", false, func(_ map[string][]byte, _ map[string]map[string]string, c *packageHelperConfig, _ ops.PackageInstallProfile) {
			c.FileUpload.Profiles = []ops.FileUploadProfile{{SourcePath: "/usr/share/data/source", Path: "/srv/output"}}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			files, installed, c, p, deb := packageNativeModel(t)
			test.mutate(files, installed, &c, p)
			original := map[string][]byte{}
			for name, raw := range files {
				original[name] = bytes.Clone(raw)
			}
			if got := packageNativeAdmits(files, installed, c, p, deb); got != test.ok {
				t.Fatal("native grammar/effect decision differs from the fixed contract")
			}
			if !reflect.DeepEqual(files, original) {
				t.Fatal("parser changed native registry/config/identity input")
			}
		})
	}
}

func TestPackageNativeConfigFragmentSelection(t *testing.T) {
	for _, name := range []string{"docker", "00_safe", "A-Z", "9"} {
		if !packageNativeConfigName("dpkg.cfg.d/" + name) {
			t.Fatal("actual native active fragment name refused")
		}
	}
	for _, name := range []string{".hidden", "disabled.conf", "docker~", "a/b", "", "safe+"} {
		if packageNativeConfigName("dpkg.cfg.d/" + name) {
			t.Fatal("inactive native fragment name activated")
		}
	}
	if !packageNativeConfig([]byte(packageObservedDockerFilters)) || strings.Count(packageObservedDockerFilters, "\n") != 18 {
		t.Fatal("observed finite native filter set drifted")
	}
}

func TestPackageNativeEffectiveSafeIOPolicy(t *testing.T) {
	for _, test := range []struct {
		name   string
		ok     bool
		mutate func(map[string][]byte)
	}{
		{"exact observed Docker row is neutralized only by canonical safe policy", true, func(_ map[string][]byte) {}},
		{"same raw row at a different active filename refuses", false, func(f map[string][]byte) {
			f["config/dpkg.cfg.d/other"] = f[packageNativeDockerSpeedupKey]
			delete(f, packageNativeDockerSpeedupKey)
		}},
		{"same row at main config refuses", false, func(f map[string][]byte) {
			f["config/dpkg.cfg"] = f[packageNativeDockerSpeedupKey]
			delete(f, packageNativeDockerSpeedupKey)
		}},
		{"altered observed comment bytes refuse", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = append([]byte("# changed\n"), f[packageNativeDockerSpeedupKey]...)
		}},
		{"second unsafe row refuses", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = append(f[packageNativeDockerSpeedupKey], []byte("force-unsafe-io\n")...)
		}},
		{"hook added to observed fragment refuses", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = append(f[packageNativeDockerSpeedupKey], []byte("pre-invoke /srv/hostile\n")...)
		}},
		{"unknown option added to observed fragment refuses", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = append(f[packageNativeDockerSpeedupKey], []byte("unknown-option\n")...)
		}},
		{"force all cannot replace observed row", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = bytes.Replace(f[packageNativeDockerSpeedupKey], []byte("force-unsafe-io"), []byte("force-all"), 1)
		}},
		{"torn observed fragment refuses", false, func(f map[string][]byte) {
			f[packageNativeDockerSpeedupKey] = f[packageNativeDockerSpeedupKey][:len(f[packageNativeDockerSpeedupKey])-1]
		}},
		{"second active fragment cannot reenable unsafe IO", false, func(f map[string][]byte) { f["config/dpkg.cfg.d/zzz"] = []byte("force-unsafe-io\n") }},
		{"canonical effective policy does not waive pending native state", false, func(f map[string][]byte) { f["triggers/Unincorp"] = []byte("ldconfig -\n") }},
		{"canonical effective policy does not waive foreign native interests", false, func(f map[string][]byte) { f["triggers/ldconfig"] = []byte("foreign\n") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			files, installed, c, p, deb := packageNativeModel(t)
			files[packageNativeDockerSpeedupKey] = []byte(packageNativeDockerSpeedup)
			test.mutate(files)
			before := map[string][]byte{}
			for name, raw := range files {
				before[name] = bytes.Clone(raw)
			}
			if packageNativeConfig([]byte(packageNativeDockerSpeedup)) || packageNativeRegistrations(files, installed) {
				t.Fatal("strict raw unsafe config was admitted")
			}
			if packageNativeEffectiveRegistrations(files, installed) != test.ok || packageNativeEffectiveAdmits(files, installed, c, p, deb) != test.ok {
				t.Fatal("canonical effective safe policy differs from finite contract")
			}
			if !reflect.DeepEqual(files, before) {
				t.Fatal("effective policy changed raw native snapshot")
			}
		})
	}
}

func TestPackageNativeFixedSafeCommand(t *testing.T) {
	for _, test := range []struct {
		name   string
		ok     bool
		mutate func(*ops.CmdSpec)
	}{
		{"canonical fixed safe install command", true, func(_ *ops.CmdSpec) {}},
		{"missing safe override refuses", false, func(c *ops.CmdSpec) { c.Args = append(c.Args[:1], c.Args[2:]...) }},
		{"later unsafe option refuses", false, func(c *ops.CmdSpec) { c.Args = append(c.Args, "--force-unsafe-io") }},
		{"reordered safe options refuse", false, func(c *ops.CmdSpec) { c.Args[0], c.Args[1] = c.Args[1], c.Args[0] }},
		{"alternate executable refuses", false, func(c *ops.CmdSpec) { c.Path = "/srv/dpkg" }},
		{"caller archive outside private custody refuses", false, func(c *ops.CmdSpec) { c.Args[4] = "/srv/source.deb" }},
		{"escaped staged path refuses", false, func(c *ops.CmdSpec) { c.Args[4] = packageHelperState + "/staged/../source.deb" }},
		{"alternate native log refuses", false, func(c *ops.CmdSpec) { c.Args[2] = "--log=/srv/log" }},
		{"native force environment refuses", false, func(c *ops.CmdSpec) { c.Env = append(c.Env, "DPKG_FORCE=unsafe-io") }},
		{"alternate HOME refuses", false, func(c *ops.CmdSpec) {
			for i, value := range c.Env {
				if value == "HOME=/nonexistent" {
					c.Env[i] = "HOME=/srv/home"
				}
			}
		}},
		{"command output capture refuses", false, func(c *ops.CmdSpec) { c.MaxStdout = 1 }},
		{"alternate command directory refuses", false, func(c *ops.CmdSpec) { c.Dir = "/srv" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := packageNativeInstallCommand(packageNativePolicyStage)
			test.mutate(&command)
			if packageNativeSafeCommand(command) != test.ok {
				t.Fatal("native command diverged from fixed safe contract")
			}
			if !packageNativeSafeCommand(packageNativeInstallCommand(packageNativePolicyStage)) {
				t.Fatal("command mutation escaped into private builder")
			}
		})
	}
}

func TestPackageNativeEffectiveFlagReadback(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		ok   bool
	}{
		{"safe enabled flags remain exact despite unsafe option description", "unsafe-io description only\nCurrently enabled options:\n security-mac,downgrade\n", true},
		{"actual default unsafe IO flag refuses", "Currently enabled options:\n security-mac,downgrade,unsafe-io\n", false},
		{"unknown enabled flag refuses", "Currently enabled options:\n security-mac,downgrade,other\n", false},
		{"missing enabled options marker refuses", " security-mac,downgrade\n", false},
		{"duplicate enabled options marker refuses", "Currently enabled options:\n security-mac,downgrade\nCurrently enabled options:\n security-mac,downgrade\n", false},
		{"partial effective flags refuse", "Currently enabled options:\n security-mac,downgrade", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if packageNativeSafeFlags([]byte(test.raw)) != test.ok {
				t.Fatal("native effective flags do not prove safe IO")
			}
		})
	}
}
