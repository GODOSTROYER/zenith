package machine

import (
	"bytes"
	"path"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

// These parsers recognize a conservative subset of dpkg 1.21's persisted
// formats. They never resolve registry paths, run native code, or return argv.
var packageNativeName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,127}$`)
var packageNativeArch = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var packageNativeAccount = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,63}\$?$`)

func packageNativePath(name string) bool {
	if len(name) < 2 || len(name) > 4096 || name[0] != '/' || path.Clean(name) != name {
		return false
	}
	for _, c := range name {
		if c < 33 || c > 126 || strings.ContainsRune(`\:*?[]`, c) {
			return false
		}
	}
	return true
}
func packageNativeLines(raw []byte) ([]string, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	if len(raw) > 2<<20 || raw[len(raw)-1] != '\n' || bytes.ContainsAny(raw, "\x00\r\t") {
		return nil, false
	}
	lines := strings.Split(string(raw[:len(raw)-1]), "\n")
	for _, line := range lines {
		if len(line) == 0 || len(line) > 8192 {
			return nil, false
		}
	}
	return lines, true
}
func packageNativePackage(spec string, installed map[string]map[string]string) (string, bool) {
	parts := strings.Split(spec, ":")
	if len(parts) > 2 || !packageNativeName.MatchString(parts[0]) {
		return "", false
	}
	m := installed[parts[0]]
	if m == nil || (m["Status"] != "install ok installed" && m["Status"] != "hold ok installed") || !packageNativeArch.MatchString(m["Architecture"]) {
		return "", false
	}
	if len(parts) == 2 && (!packageNativeArch.MatchString(parts[1]) || parts[1] != m["Architecture"]) {
		return "", false
	}
	return parts[0] + ":" + m["Architecture"], true
}
func packageNativeInterest(spec string, installed map[string]map[string]string) (string, bool) {
	parts := strings.Split(spec, "/")
	if len(parts) > 2 || (len(parts) == 2 && parts[1] != "await" && parts[1] != "noawait") {
		return "", false
	}
	return packageNativePackage(parts[0], installed)
}

// Config fragments have dpkg's actual alphanumeric/underscore/hyphen name
// filter. Inactive files are still retained and compared as opaque raw bytes.
func packageNativeConfigName(name string) bool {
	if name == "dpkg.cfg" {
		return true
	}
	const prefix = "dpkg.cfg.d/"
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	fragment := strings.TrimPrefix(name, prefix)
	if fragment == "" {
		return false
	}
	for _, c := range fragment {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}
func packageNativeConfig(raw []byte) bool {
	if len(raw) > 65536 || bytes.ContainsAny(raw, "\x00\r") || (len(raw) > 0 && raw[len(raw)-1] != '\n') {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		// dpkg strips trailing space, but does not strip leading space before
		// deciding that a line is a comment or an option. Do not hide an option.
		line = strings.TrimRight(line, " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		switch line {
		case "no-debsig", "log /var/log/dpkg.log",
			"path-exclude /usr/share/doc/*", "path-exclude /usr/share/doc/kde/HTML/*/*",
			"path-exclude /usr/share/gnome/help/*/*", "path-exclude /usr/share/info/*",
			"path-exclude /usr/share/linda/*", "path-exclude /usr/share/lintian/overrides/*",
			"path-exclude /usr/share/locale/*", "path-exclude /usr/share/man/*",
			"path-exclude /usr/share/omf/*/*-*.emf", "path-include /usr/share/doc/*/copyright",
			"path-include /usr/share/doc/kde/HTML/C/*", "path-include /usr/share/gnome/help/*/C/*",
			"path-include /usr/share/locale/all_languages", "path-include /usr/share/locale/currency/*",
			"path-include /usr/share/locale/l10n/*", "path-include /usr/share/locale/languages",
			"path-include /usr/share/locale/locale.alias", "path-include /usr/share/omf/*/*-C.emf":
		default:
			return false
		}
	}
	return true
}

// One observed Docker fragment is unsafe as raw policy. Only the helper's
// private, fixed safe command can neutralize it; its captured bytes stay intact.
const packageNativeDockerSpeedup = "# For most Docker users, package installs happen during \"docker build\", which\n# doesn't survive power loss and gets restarted clean afterwards anyhow, so\n# this minor tweak gives us a nice speedup (much nicer on spinning disks,\n# obviously).\n\nforce-unsafe-io\n"
const packageNativeDockerSpeedupKey = "config/dpkg.cfg.d/docker-apt-speedup"
const packageNativePolicyStage = packageHelperState + "/staged/pi_00000000000000000000000000000000.deb"

func packageNativeInstallCommand(staged string) ops.CmdSpec {
	return ops.CmdSpec{Path: "/usr/bin/dpkg", Args: []string{"--no-triggers", "--refuse-unsafe-io", "--log=" + packageHelperState + "/dpkg.log", "--install", staged},
		Env: append(ops.SafeEnv(), "DPKG_FRONTEND_LOCKED=true"), MaxStdout: 0, MaxStderr: 0}
}
func packageNativeSafeCommand(command ops.CmdSpec) bool {
	if command.Path != "/usr/bin/dpkg" || command.Dir != "" || command.MaxStdout != 0 || command.MaxStderr != 0 || len(command.Args) != 5 ||
		command.Args[0] != "--no-triggers" || command.Args[1] != "--refuse-unsafe-io" || command.Args[2] != "--log="+packageHelperState+"/dpkg.log" || command.Args[3] != "--install" ||
		!reflect.DeepEqual(command.Env, append(ops.SafeEnv(), "DPKG_FRONTEND_LOCKED=true")) {
		return false
	}
	staged := command.Args[4]
	prefix := packageHelperState + "/staged/pi_"
	if !strings.HasPrefix(staged, prefix) || !strings.HasSuffix(staged, ".deb") || len(staged) != len(prefix)+32+4 {
		return false
	}
	for _, c := range staged[len(prefix) : len(staged)-4] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
func packageNativeEffectiveFiles(files map[string][]byte) (map[string][]byte, bool) {
	if !packageNativeSafeCommand(packageNativeInstallCommand(packageNativePolicyStage)) {
		return nil, false
	}
	raw, found := files[packageNativeDockerSpeedupKey]
	if !found || packageNativeConfig(raw) {
		return files, true
	}
	// Exact public dpkg1.21.23 input, not an option/filename family allowance.
	if !bytes.Equal(raw, []byte(packageNativeDockerSpeedup)) || len(raw) != 259 || packageHash(raw) != "ab3af717d57cbbea36555833dc1ae031fa46750b879199ec579ee00be9aa0124" {
		return nil, false
	}
	active := 0
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimRight(line, " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if line != "force-unsafe-io" {
			return nil, false
		}
		active++
	}
	if active != 1 {
		return nil, false
	}
	// This local grammar projection never replaces snapshot, backup or digest data.
	projected := make(map[string][]byte, len(files))
	for name, body := range files {
		projected[name] = body
	}
	projected[packageNativeDockerSpeedupKey] = nil
	return projected, true
}
func packageNativeEffectiveRegistrations(files map[string][]byte, installed map[string]map[string]string) bool {
	projected, ok := packageNativeEffectiveFiles(files)
	return ok && packageNativeRegistrations(projected, installed)
}
func packageNativeEffectiveAdmits(files map[string][]byte, installed map[string]map[string]string, c packageHelperConfig, p ops.PackageInstallProfile, deb pinnedDeb) bool {
	projected, ok := packageNativeEffectiveFiles(files)
	return ok && packageNativeAdmits(projected, installed, c, p, deb)
}
func packageNativeSafeFlags(raw []byte) bool {
	if len(raw) < 1 || len(raw) > 65536 || bytes.ContainsAny(raw, "\x00\r") || bytes.Count(raw, []byte("Currently enabled options:\n")) != 1 {
		return false
	}
	parts := bytes.SplitN(raw, []byte("Currently enabled options:\n"), 2)
	return bytes.Equal(parts[1], []byte(" security-mac,downgrade\n"))
}

func packageNativeNumericID(value string) bool {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return false
	}
	n, e := strconv.ParseUint(value, 10, 32)
	return e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == value
}
func packageNativeIdentity(name, kind string, files map[string][]byte) bool {
	if strings.HasPrefix(name, "#") {
		return packageNativeNumericID(name[1:])
	}
	if !packageNativeAccount.MatchString(name) {
		return false
	}
	// Only a local files-first, default-success NSS stanza is admitted. No NSS
	// callback or network lookup supplies identity to this parser. systemd may
	// follow files, but cannot replace a successfully resolved local account.
	nss, ok := files["identity/nsswitch.conf"]
	if !ok || bytes.ContainsAny(nss, "\x00\r") {
		return false
	}
	key := "passwd"
	count := 7
	if kind == "group" {
		key, count = "group", 4
	}
	stanzas := 0
	for _, line := range strings.Split(string(nss), "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		if strings.HasPrefix(line, key+":") {
			stanzas++
			modules := strings.Fields(strings.TrimPrefix(line, key+":"))
			if len(modules) < 1 || len(modules) > 2 || modules[0] != "files" || (len(modules) == 2 && modules[1] != "systemd") {
				return false
			}
		}
	}
	if stanzas != 1 {
		return false
	}
	raw, ok := files["identity/"+key]
	if !ok {
		return false
	}
	lines, ok := packageNativeLines(raw)
	if !ok {
		return false
	}
	seen := map[string]bool{}
	found := false
	for _, line := range lines {
		fields := strings.Split(line, ":")
		if len(fields) != count || !packageNativeAccount.MatchString(fields[0]) || seen[fields[0]] || !packageNativeNumericID(fields[2]) || (kind != "group" && !packageNativeNumericID(fields[3])) {
			return false
		}
		seen[fields[0]] = true
		if fields[0] == name {
			found = true
		}
	}
	return found
}

// Grammar validation is separate from effect admission so a snapshot can be
// taken under the native frontend lock before a particular profile is chosen.
func packageNativeRegistrations(files map[string][]byte, installed map[string]map[string]string) bool {
	for name, m := range installed {
		if !packageNativeName.MatchString(name) || m["Package"] != name || !packageNativeArch.MatchString(m["Architecture"]) || (m["Status"] != "install ok installed" && m["Status"] != "hold ok installed") || m["Triggers-Pending"] != "" || m["Triggers-Awaited"] != "" {
			return false
		}
	}
	// Missing Unincorp is unproven initialization. File may genuinely be absent
	// when dpkg has no file interests; dpkg deletes its last empty interest file.
	if raw, ok := files["triggers/Unincorp"]; !ok || len(raw) != 0 {
		return false
	}
	diverted := map[string]bool{}
	lines, ok := packageNativeLines(files["diversions"])
	if !ok || len(lines)%3 != 0 {
		return false
	}
	for i := 0; i < len(lines); i += 3 {
		if !packageNativePath(lines[i]) || !packageNativePath(lines[i+1]) || lines[i] == lines[i+1] || diverted[lines[i]] || diverted[lines[i+1]] {
			return false
		}
		if lines[i+2] != ":" {
			if _, ok := packageNativePackage(lines[i+2], installed); !ok {
				return false
			}
		}
		diverted[lines[i]], diverted[lines[i+1]] = true, true
	}
	lines, ok = packageNativeLines(files["statoverride"])
	if !ok {
		return false
	}
	overridden := map[string]bool{}
	for _, line := range lines {
		parts := strings.Split(line, " ")
		if len(parts) != 4 || !packageNativeIdentity(parts[0], "passwd", files) || !packageNativeIdentity(parts[1], "group", files) || !packageNativePath(parts[3]) || overridden[parts[3]] || len(parts[2]) < 1 || len(parts[2]) > 4 {
			return false
		}
		for _, c := range parts[2] {
			if c < '0' || c > '7' {
				return false
			}
		}
		if n, e := strconv.ParseUint(parts[2], 8, 16); e != nil || n > 07777 {
			return false
		}
		overridden[parts[3]] = true
	}
	for name, raw := range files {
		if strings.HasPrefix(name, "config/") {
			if packageNativeConfigName(strings.TrimPrefix(name, "config/")) && !packageNativeConfig(raw) {
				return false
			}
		}
		if strings.HasPrefix(name, "updates/") && len(raw) != 0 {
			return false
		}
		if !strings.HasPrefix(name, "triggers/") || name == "triggers/Unincorp" {
			continue
		}
		trigger := strings.TrimPrefix(name, "triggers/")
		if trigger != "File" && !packageNativeName.MatchString(trigger) {
			return false
		}
		lines, ok := packageNativeLines(raw)
		if !ok || (trigger != "File" && len(lines) == 0) {
			return false
		}
		seen := map[string]bool{}
		for _, line := range lines {
			interest, spec := "", line
			if trigger == "File" {
				parts := strings.Split(line, " ")
				if len(parts) != 2 || !packageNativePath(parts[0]) {
					return false
				}
				interest, spec = parts[0], parts[1]
			}
			identity, ok := packageNativeInterest(spec, installed)
			id := interest + " " + identity
			if !ok || seen[id] {
				return false
			}
			seen[id] = true
		}
	}
	return true
}

type packageNativeEffects struct {
	entries  []string
	subtrees []string
}

func packageNativeFrame(c packageHelperConfig, p ops.PackageInstallProfile, deb pinnedDeb) packageNativeEffects {
	frame := packageNativeEffects{entries: []string{"/opt", "/opt/zenith-packages"}, subtrees: []string{
		"/opt/zenith-packages/" + p.ProfileRef, packageHelperState, "/etc/zenithd", "/var/lib/zenithd", "/run/zenithd-package-install", "/var/lib/dpkg", "/etc/dpkg",
	}}
	for name := range deb.Files {
		frame.entries = append(frame.entries, name)
	}
	for _, profile := range c.PackageInstall.Profiles {
		frame.entries = append(frame.entries, profile.SourcePath)
		frame.subtrees = append(frame.subtrees, "/opt/zenith-packages/"+profile.ProfileRef)
	}
	for _, name := range []string{c.FileWrite.BackupDir, c.FileUpload.BackupDir} {
		if name != "" {
			frame.subtrees = append(frame.subtrees, name)
		}
	}
	for _, profile := range c.FileWrite.Profiles {
		frame.entries = append(frame.entries, profile.Path, profile.SourcePath)
	}
	for _, profile := range c.FileUpload.Profiles {
		frame.entries = append(frame.entries, profile.Path, profile.SourcePath)
	}
	return frame
}
func packageNativeUnder(name, base string) bool {
	return name == base || strings.HasPrefix(name, base+"/")
}
func (frame packageNativeEffects) blocked(name string) bool {
	for _, entry := range frame.entries {
		if packageNativeUnder(entry, name) {
			return true // the endpoint can affect an actual effect or its ancestor
		}
	}
	for _, tree := range frame.subtrees {
		if packageNativeUnder(name, tree) || packageNativeUnder(tree, name) {
			return true
		}
	}
	return false
}
func packageNativeAdmits(files map[string][]byte, installed map[string]map[string]string, c packageHelperConfig, p ops.PackageInstallProfile, deb pinnedDeb) bool {
	if !packageNativeRegistrations(files, installed) {
		return false
	}
	frame := packageNativeFrame(c, p, deb)
	lines, _ := packageNativeLines(files["diversions"])
	for i := 0; i < len(lines); i += 3 {
		if frame.blocked(lines[i]) || frame.blocked(lines[i+1]) {
			return false
		}
	}
	lines, _ = packageNativeLines(files["statoverride"])
	for _, line := range lines {
		if frame.blocked(strings.Split(line, " ")[3]) {
			return false
		}
	}
	lines, _ = packageNativeLines(files["triggers/File"])
	for _, line := range lines {
		if frame.blocked(strings.Split(line, " ")[0]) {
			return false
		}
	}
	// Every admitted filter has this fixed literal prefix. dpkg wildcards can
	// cross '/'; disjointness follows from the prefix, not Go glob emulation.
	for name, raw := range files {
		if !strings.HasPrefix(name, "config/") || !packageNativeConfigName(strings.TrimPrefix(name, "config/")) {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "path-exclude ") || strings.HasPrefix(line, "path-include ") {
				if frame.blocked("/usr/share") {
					return false
				}
			}
		}
	}
	return true
}
