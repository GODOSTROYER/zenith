package ops

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// PackageInstallConfig contains local metadata only. The privileged helper owns
// its independent root configuration and authenticates the original signed token.
type PackageInstallConfig struct {
	Enabled  bool                    `json:"enabled"`
	Profiles []PackageInstallProfile `json:"profiles"`
}

type PackageInstallProfile struct {
	ProfileRef     string               `json:"profileRef"`
	ProfileVersion string               `json:"profileVersion"`
	Package        string               `json:"package"`
	Version        string               `json:"version"`
	Architecture   string               `json:"architecture"`
	SourcePath     string               `json:"sourcePath"`
	SHA256         string               `json:"sha256"`
	ArchiveBytes   int64                `json:"archiveBytes"`
	Payload        []PackagePayloadFile `json:"payload"`
}

type PackagePayloadFile struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Mode   string `json:"mode"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type PackageInstallArgs struct {
	ProfileRef               string  `json:"profileRef"`
	ProfileVersion           string  `json:"profileVersion"`
	ExpectedInstalledVersion *string `json:"expectedInstalledVersion"`
}

var packageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{1,63}$`)
var packageVersion = regexp.MustCompile(`^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~-]{0,127}$`)

func init() {
	register(Operation{Name: OpPackageInstall, Prepare: func(_ *Env, _ *Request) (Runnable, error) {
		return nil, protocol.Errorf(protocol.CodeNotAllowed, "package.install requires the original authenticated signed request and the private root helper")
	}})
}

// ParsePackageInstallArgs is a closed metadata parser, never an authority proof.
func ParsePackageInstallArgs(raw json.RawMessage) (PackageInstallArgs, error) {
	var a PackageInstallArgs
	fields, err := strictFileMutationFields(raw)
	if err != nil || len(fields) != 3 || fields["profileRef"] == nil || fields["profileVersion"] == nil || fields["expectedInstalledVersion"] == nil || json.Unmarshal(raw, &a) != nil || !writeID.MatchString(a.ProfileRef) || !writeDigest.MatchString(a.ProfileVersion) {
		return a, invalid("package.install requires strict pinned local profile metadata")
	}
	for k := range fields {
		if k != "profileRef" && k != "profileVersion" && k != "expectedInstalledVersion" {
			return a, invalid("package.install contains unsupported members")
		}
	}
	if a.ExpectedInstalledVersion != nil && (len(*a.ExpectedInstalledVersion) > 128 || !packageVersion.MatchString(*a.ExpectedInstalledVersion)) {
		return a, invalid("package.install prior version is invalid")
	}
	return a, nil
}

func validatePackageProfile(p PackageInstallProfile) error {
	if !writeID.MatchString(p.ProfileRef) || !packageName.MatchString(p.Package) || (len(p.Version) > 128 || !packageVersion.MatchString(p.Version)) || (p.Architecture != "amd64" && p.Architecture != "arm64") || !writeDigest.MatchString(p.SHA256) || !canonicalWritePath(p.SourcePath) || !strings.HasPrefix(p.SourcePath, "/var/lib/zenithd-package-install/archives/") || p.ArchiveBytes < 1 || p.ArchiveBytes > 4<<20 || len(p.Payload) < 1 || len(p.Payload) > 256 {
		return fmt.Errorf("invalid pinned package profile")
	}
	base := "/opt/zenith-packages/" + p.ProfileRef
	seen := map[string]bool{}
	kinds := map[string]string{}
	total := int64(0)
	for _, f := range p.Payload {
		if seen[f.Path] || path.Clean(f.Path) != f.Path || (f.Path != base && !strings.HasPrefix(f.Path, base+"/")) || len(f.Path) > 512 || strings.ContainsAny(f.Path, "\x00\n\r\\") || strings.Contains(f.Path, " ") {
			return fmt.Errorf("invalid package payload path")
		}
		seen[f.Path] = true
		kinds[f.Path] = f.Kind
		if f.Kind == "directory" {
			if f.Mode != "0755" || f.Bytes != 0 || f.SHA256 != "" {
				return fmt.Errorf("invalid package directory")
			}
		} else if f.Kind == "file" {
			if (f.Mode != "0644" && f.Mode != "0755") || f.Bytes < 0 || f.Bytes > 1<<20 || !writeDigest.MatchString(f.SHA256) {
				return fmt.Errorf("invalid package file")
			}
			total += f.Bytes
		} else {
			return fmt.Errorf("unsupported package payload type")
		}
	}
	if total > 8<<20 {
		return fmt.Errorf("package payload budget exceeded")
	}
	// Every containing directory below the fixed root must be explicit.
	for _, f := range p.Payload {
		for d := path.Dir(f.Path); d != "/opt/zenith-packages"; d = path.Dir(d) {
			if !seen[d] || kinds[d] != "directory" {
				return fmt.Errorf("package payload lacks explicit parent directory")
			}
		}
	}
	return nil
}

// PackageInstallProfileVersion purpose-separates immutable metadata. It reads no
// archive, invokes no helper and grants no privilege.
func PackageInstallProfileVersion(p PackageInstallProfile) (string, error) {
	if err := validatePackageProfile(p); err != nil {
		return "", err
	}
	p.ProfileVersion = ""
	p.Payload = append([]PackagePayloadFile(nil), p.Payload...)
	sort.Slice(p.Payload, func(i, j int) bool { return p.Payload[i].Path < p.Payload[j].Path })
	raw, err := json.Marshal(struct {
		Distro  string                `json:"distro"`
		Manager string                `json:"manager"`
		Profile PackageInstallProfile `json:"profile"`
	}{"debian:12", "dpkg:1.21", p})
	if err != nil {
		return "", fmt.Errorf("invalid package profile metadata")
	}
	sum := sha256.Sum256(append([]byte("zenith.package.install.profile/v1\x00"), raw...))
	return hex.EncodeToString(sum[:]), nil
}

func ValidatePackageInstallConfig(c PackageInstallConfig) error {
	if !c.Enabled {
		return nil
	}
	if len(c.Profiles) < 1 || len(c.Profiles) > 32 {
		return fmt.Errorf("packageInstall requires bounded pinned profiles")
	}
	refs, names := map[string]bool{}, map[string]bool{}
	for _, p := range c.Profiles {
		v, e := PackageInstallProfileVersion(p)
		if e != nil || v != p.ProfileVersion || refs[p.ProfileRef] || names[p.Package] {
			return fmt.Errorf("packageInstall has invalid or duplicate profile metadata")
		}
		refs[p.ProfileRef] = true
		names[p.Package] = true
	}
	return nil
}

func ValidatePackageInstallConstraints(raw json.RawMessage, c map[string]any) error {
	if _, err := ParsePackageInstallArgs(raw); err != nil {
		return err
	}
	for k, v := range c {
		if k != "maxTimeoutSec" && k != "maxOutputBytes" {
			return protocol.Errorf(protocol.CodeConstraint, "package.install has unenforceable constraints")
		}
		n, ok := v.(float64)
		if !ok || n < 1 || n > 1073741824 || n != float64(int64(n)) {
			return protocol.Errorf(protocol.CodeConstraint, "package.install constraint is invalid")
		}
	}
	return nil
}

func PackageInstallFailure(effect, intent string) Result {
	data := map[string]any{"error": "refused", "phase": "guard", "effect": effect, "postcondition": "unverified"}
	if effect == "unknown" {
		data["error"] = "mutation_uncertain"
		data["phase"] = "uncertain"
	}
	if intent != "" {
		data["transactionRef"] = intent
	}
	return Result{OK: false, Data: data, Err: "package.install did not establish verified postconditions"}
}

// All configured custody remains protected, including disabled file operations.
// The private helper's fixed writable subtree cannot overlap their data.
func ValidatePackageInstallIsolation(c Config) error {
	if len(c.PackageInstall.Profiles) == 0 {
		return nil
	}
	protected := []string{"/opt/zenith-packages", "/var/lib/zenithd-package-install", "/run/zenithd-package-install", "/etc/zenithd/package-install.json", "/var/lib/dpkg"}
	overlap := func(a, b string) bool {
		return a != "" && b != "" && (a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/"))
	}
	custody := []string{c.FileWrite.BackupDir, c.FileUpload.BackupDir}
	for _, p := range c.FileWrite.Profiles {
		custody = append(custody, p.Path, p.SourcePath)
	}
	for _, p := range c.FileUpload.Profiles {
		custody = append(custody, p.Path, p.SourcePath)
	}
	for _, a := range custody {
		if a != "" && !canonicalWritePath(a) {
			return fmt.Errorf("invalid retained file mutation custody")
		}
		for _, b := range protected {
			if overlap(a, b) {
				return fmt.Errorf("package and file mutation custody overlap")
			}
		}
	}
	return nil
}
