package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"sync"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// FileWriteConfig is a customer-local v1 template profile. Nothing supplies
// bytes, ownership, modes, commands or new directories through the envelope.
type FileWriteConfig struct {
	Enabled        bool               `json:"enabled"`
	BackupDir      string             `json:"backupDir"`
	MaxBackupBytes int64              `json:"maxBackupBytes"`
	MaxBackups     int                `json:"maxBackups"`
	Profiles       []FileWriteProfile `json:"profiles"`
}
type FileWriteProfile struct {
	Path           string `json:"path"`
	ContentRef     string `json:"contentRef"`
	ContentVersion string `json:"contentVersion"`
	SourcePath     string `json:"sourcePath"`
	SHA256         string `json:"sha256"`
	Mode           string `json:"mode"` // exactly 0600 or 0640
	MaxBytes       int64  `json:"maxBytes"`
}
type fileWriteArgs struct {
	Path           string  `json:"path"`
	ContentRef     string  `json:"contentRef"`
	ContentVersion string  `json:"contentVersion"`
	ExpectedSHA256 *string `json:"expectedSha256"`
}

var writeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
var writeDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var writePath = regexp.MustCompile(`^/[A-Za-z0-9._@:+,=/\-]+$`)

// One lock serializes all writers AND retained-backup budget reservations in
// this process. External writers of the same UID remain outside this lock.
var fileWriteMu sync.Mutex

func init() { register(Operation{Name: OpFileWrite, Prepare: prepareFileWrite}) }

func canonicalWritePath(p string) bool {
	if len(p) < 2 || len(p) > 1024 || !writePath.MatchString(p) || strings.Contains(p, "..") || path.Clean(p) != p {
		return false
	}
	for _, c := range strings.Split(p, "/") {
		if c == "." || c == ".." {
			return false
		}
	}
	return true
}

// Protected host configuration is never writable even through a local profile.
func deniedWritePath(p string) bool {
	for _, d := range []string{"/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev", "/run", "/var/lib/zenithd", "/var/spool", "/var/log", "/root"} {
		if underPrefix(p, d) {
			return true
		}
	}
	for _, c := range strings.Split(strings.ToLower(p), "/") {
		if strings.HasPrefix(c, ".") || c == "systemd" || c == "cron" || c == "crontabs" || c == "sudoers" || c == "sudoers.d" || c == "polkit-1" || c == "bin" || c == "sbin" || c == "identity.json" || c == "replay.jsonl" || c == "audit.jsonl" || c == "config.yaml" || c == "config.json" || strings.HasSuffix(c, ".service") || strings.HasSuffix(c, ".socket") || strings.HasSuffix(c, ".timer") || strings.HasSuffix(c, ".sh") {
			return true
		}
	}
	return false
}

// FileWriteProfileVersion binds immutable local execution semantics. JSON fields
// are emitted in this struct order with no whitespace; version is excluded.
// No source content or OS-dependent inode is read by this metadata helper.
func FileWriteProfileVersion(c FileWriteConfig, p FileWriteProfile) (string, error) {
	if !canonicalWritePath(c.BackupDir) || c.MaxBackupBytes < 1 || c.MaxBackupBytes > 1<<30 || c.MaxBackups < 1 || c.MaxBackups > 4096 || !canonicalWritePath(p.Path) || deniedWritePath(p.Path) || !canonicalWritePath(p.SourcePath) || !writeID.MatchString(p.ContentRef) || !writeDigest.MatchString(p.SHA256) || (p.Mode != "0600" && p.Mode != "0640") || p.MaxBytes < 1 || p.MaxBytes > 1<<20 || underPrefix(p.Path, c.BackupDir) || p.Path == p.SourcePath {
		return "", fmt.Errorf("fileWrite: invalid canonical profile semantics")
	}
	canonical := struct {
		Path           string `json:"path"`
		ContentRef     string `json:"contentRef"`
		SourcePath     string `json:"sourcePath"`
		SHA256         string `json:"sha256"`
		Mode           string `json:"mode"`
		MaxBytes       int64  `json:"maxBytes"`
		BackupDir      string `json:"backupDir"`
		MaxBackupBytes int64  `json:"maxBackupBytes"`
		MaxBackups     int    `json:"maxBackups"`
	}{p.Path, p.ContentRef, p.SourcePath, p.SHA256, p.Mode, p.MaxBytes, c.BackupDir, c.MaxBackupBytes, c.MaxBackups}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("fileWrite: could not canonicalize profile metadata")
	}
	digest := sha256.Sum256(append([]byte("zenith.file.write.profile/v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func ValidateFileWriteConfig(c FileWriteConfig) error {
	if !c.Enabled {
		return nil
	}
	if !canonicalWritePath(c.BackupDir) || c.MaxBackupBytes < 1 || c.MaxBackupBytes > 1<<30 || c.MaxBackups < 1 || c.MaxBackups > 4096 || len(c.Profiles) < 1 || len(c.Profiles) > 64 {
		return fmt.Errorf("fileWrite: invalid private backup limits or profiles")
	}
	seen := map[string]bool{}
	for _, p := range c.Profiles {
		if !canonicalWritePath(p.Path) || deniedWritePath(p.Path) || !canonicalWritePath(p.SourcePath) || !writeID.MatchString(p.ContentRef) || !writeDigest.MatchString(p.ContentVersion) || !writeDigest.MatchString(p.SHA256) || (p.Mode != "0600" && p.Mode != "0640") || p.MaxBytes < 1 || p.MaxBytes > 1<<20 || seen[p.Path] || underPrefix(p.Path, c.BackupDir) || p.Path == p.SourcePath {
			return fmt.Errorf("fileWrite: invalid or duplicate immutable template profile")
		}
		computed, err := FileWriteProfileVersion(c, p)
		if err != nil || computed != p.ContentVersion {
			return fmt.Errorf("fileWrite: contentVersion does not bind immutable execution semantics")
		}
		seen[p.Path] = true
	}
	// A destination cannot overwrite any source or the backup directory tree.
	for _, p := range c.Profiles {
		for _, s := range c.Profiles {
			if p.Path == s.SourcePath {
				return fmt.Errorf("fileWrite: destination aliases a template")
			}
		}
	}
	return nil
}
func parseFileWrite(raw json.RawMessage) (fileWriteArgs, error) {
	var a fileWriteArgs
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&a) != nil {
		return a, invalid("file.write args do not match the strict schema")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return a, invalid("file.write args contain trailing data")
	}
	// Explicitly reject duplicate JSON members instead of last-value-wins.
	fields := map[string]json.RawMessage{}
	scan := json.NewDecoder(bytes.NewReader(raw))
	tok, err := scan.Token()
	if err != nil || tok != json.Delim('{') {
		return a, invalid("file.write args must be an object")
	}
	for scan.More() {
		token, er := scan.Token()
		key, ok := token.(string)
		if er != nil || !ok || fields[key] != nil {
			return a, invalid("file.write has duplicate or invalid members")
		}
		var value json.RawMessage
		if scan.Decode(&value) != nil {
			return a, invalid("file.write args are invalid")
		}
		fields[key] = value
	}
	if len(fields) == 0 || len(fields) != 4 || fields["expectedSha256"] == nil || !canonicalWritePath(a.Path) || deniedWritePath(a.Path) || !writeID.MatchString(a.ContentRef) || !writeDigest.MatchString(a.ContentVersion) || (a.ExpectedSHA256 != nil && !writeDigest.MatchString(*a.ExpectedSHA256)) {
		return a, invalid("file.write requires canonical path, opaque ref/version and explicit prior digest or null")
	}
	return a, nil
}

// Write grants fail closed for every constraint not actually enforced by both
// executors. Existing read/exec grants keep their compatibility behavior.
func ValidateFileWriteConstraints(raw json.RawMessage, c map[string]any) error {
	a, err := parseFileWrite(raw)
	if err != nil {
		return err
	}
	for k, v := range c {
		switch k {
		case "maxTimeoutSec", "maxOutputBytes":
			n, ok := v.(float64)
			if !ok || n < 1 || n != float64(int64(n)) || n > 1<<30 {
				return protocol.Errorf(protocol.CodeConstraint, "invalid write budget constraint")
			}
		case "pathPrefixes":
			ps, ok := v.([]any)
			if !ok || len(ps) > 64 {
				return protocol.Errorf(protocol.CodeConstraint, "invalid write path constraint")
			}
			allowed := false
			for _, v := range ps {
				p, ok := v.(string)
				if !ok || !canonicalWritePath(p) {
					return protocol.Errorf(protocol.CodeConstraint, "invalid write path constraint")
				}
				if underPrefix(a.Path, p) {
					allowed = true
				}
			}
			if !allowed {
				return protocol.Errorf(protocol.CodeConstraint, "write destination is outside signed scope")
			}
		default:
			return protocol.Errorf(protocol.CodeConstraint, "unsupported file.write constraint")
		}
	}
	return nil
}
func prepareFileWrite(e *Env, req *Request) (Runnable, error) {
	if !e.Cfg.FileWrite.Enabled {
		return nil, disabled("file.write is disabled locally")
	}
	if !fileWritePlatform() {
		return nil, unsupportedf("file.write requires Linux")
	}
	if err := ValidateFileWriteConfig(e.Cfg.FileWrite); err != nil {
		return nil, disabled("file.write local profile is invalid")
	}
	a, err := parseFileWrite(req.Args)
	if err != nil {
		return nil, err
	}
	for _, d := range []string{e.StateDir, e.ConfigFile, e.AuditFile, e.Cfg.FileWrite.BackupDir} {
		if d != "" && underPrefix(a.Path, d) {
			return nil, notAllowed("write destination holds protected local state")
		}
	}
	for _, p := range e.Cfg.FileWrite.Profiles {
		if p.Path == a.Path && p.ContentRef == a.ContentRef && p.ContentVersion == a.ContentVersion {
			for _, d := range []string{e.StateDir, e.ConfigFile, e.AuditFile, e.Cfg.FileWrite.BackupDir} {
				if d != "" && underPrefix(p.SourcePath, d) {
					return nil, notAllowed("template source holds protected local custody")
				}
			}
			return func(ctx context.Context) (Result, error) { return runFileWrite(ctx, e, a, p) }, nil
		}
	}
	return nil, notAllowed("write does not match an exact local immutable template profile")
}
func writeFailure(phase, effect, backup string) Result {
	d := map[string]any{"error": "refused", "reason": "file.write did not establish verified durable postconditions", "phase": phase, "effect": effect, "postcondition": "unverified"}
	if effect == "unknown" {
		d["error"] = "mutation_uncertain"
	}
	if backup != "" {
		d["backupRef"] = backup
	}
	return Result{OK: false, Data: d, Err: "file.write " + phase + ": " + effect}
}
