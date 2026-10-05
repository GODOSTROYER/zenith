package ops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// FileUploadConfig pins customer-local binary sources. Envelopes cannot supply
// bytes, URLs, source paths, owners, modes or commands.
type FileUploadConfig struct {
	Enabled        bool                `json:"enabled"`
	BackupDir      string              `json:"backupDir"`
	MaxBackupBytes int64               `json:"maxBackupBytes"`
	MaxBackups     int                 `json:"maxBackups"`
	Profiles       []FileUploadProfile `json:"profiles"`
}

type FileUploadProfile struct {
	Path          string `json:"path"`
	SourceRef     string `json:"sourceRef"`
	SourceVersion string `json:"sourceVersion"`
	SourcePath    string `json:"sourcePath"`
	SHA256        string `json:"sha256"`
	Mode          string `json:"mode"`
	MaxBytes      int64  `json:"maxBytes"`
}

type fileUploadArgs struct {
	Path           string  `json:"path"`
	SourceRef      string  `json:"sourceRef"`
	SourceVersion  string  `json:"sourceVersion"`
	ExpectedSHA256 *string `json:"expectedSha256"`
}

// A closed internal selector reuses the writer without changing its Env or
// allowing a caller to choose arbitrary execution or version functions.
type fileMutationPurpose uint8

const (
	fileWritePurpose fileMutationPurpose = iota
	fileUploadPurpose
	serviceConfigurePurpose
)

func init() { register(Operation{Name: OpFileUpload, Prepare: prepareFileUpload}) }

func uploadProfile(p FileUploadProfile) FileWriteProfile {
	return FileWriteProfile{Path: p.Path, ContentRef: p.SourceRef, ContentVersion: p.SourceVersion, SourcePath: p.SourcePath, SHA256: p.SHA256, Mode: p.Mode, MaxBytes: p.MaxBytes}
}

func uploadBudget(c FileUploadConfig) FileWriteConfig {
	return FileWriteConfig{Enabled: c.Enabled, BackupDir: c.BackupDir, MaxBackupBytes: c.MaxBackupBytes, MaxBackups: c.MaxBackups}
}

// FileUploadProfileVersion reads metadata only. The purpose and sourceRef field
// deliberately differ from file.write; neither version authorizes the other.
func FileUploadProfileVersion(c FileUploadConfig, p FileUploadProfile) (string, error) {
	if _, err := FileWriteProfileVersion(uploadBudget(c), uploadProfile(p)); err != nil {
		return "", fmt.Errorf("fileUpload: invalid canonical profile semantics")
	}
	canonical := struct {
		Path           string `json:"path"`
		SourceRef      string `json:"sourceRef"`
		SourcePath     string `json:"sourcePath"`
		SHA256         string `json:"sha256"`
		Mode           string `json:"mode"`
		MaxBytes       int64  `json:"maxBytes"`
		BackupDir      string `json:"backupDir"`
		MaxBackupBytes int64  `json:"maxBackupBytes"`
		MaxBackups     int    `json:"maxBackups"`
	}{p.Path, p.SourceRef, p.SourcePath, p.SHA256, p.Mode, p.MaxBytes, c.BackupDir, c.MaxBackupBytes, c.MaxBackups}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("fileUpload: could not canonicalize profile metadata")
	}
	digest := sha256.Sum256(append([]byte("zenith.file.upload.profile/v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

func ValidateFileUploadConfig(c FileUploadConfig) error {
	if !c.Enabled {
		return nil
	}
	if len(c.Profiles) < 1 || len(c.Profiles) > 64 {
		return fmt.Errorf("fileUpload: invalid private backup limits or profiles")
	}
	seen := map[string]bool{}
	for _, p := range c.Profiles {
		version, err := FileUploadProfileVersion(c, p)
		if err != nil || !writeDigest.MatchString(p.SourceVersion) || version != p.SourceVersion || seen[p.Path] {
			return fmt.Errorf("fileUpload: invalid or duplicate immutable binary profile")
		}
		seen[p.Path] = true
	}
	for _, p := range c.Profiles {
		for _, s := range c.Profiles {
			if p.Path == s.SourcePath {
				return fmt.Errorf("fileUpload: destination aliases a binary source")
			}
		}
	}
	return nil
}

// ValidateFileMutationConfig prevents either operation from replacing the
// other's sources or backup custody. It does not enable an operation.
func ValidateFileMutationConfig(c Config) error {
	if err := ValidatePackageInstallIsolation(c); err != nil {
		return err
	}
	if err := ValidateFileWriteConfig(c.FileWrite); err != nil {
		return err
	}
	if err := ValidateFileUploadConfig(c.FileUpload); err != nil {
		return err
	}
	if err := validateServiceConfigureAuthority(c); err != nil {
		return err
	}
	var sources, destinations []FileWriteProfile
	var stores []string
	// Configured custody remains protected when an operation is disabled.
	for _, store := range []string{c.FileWrite.BackupDir, c.FileUpload.BackupDir, c.ServiceConfigure.BackupDir} {
		if store != "" {
			stores = append(stores, store)
		}
	}
	sources = append(sources, c.FileWrite.Profiles...)
	if c.FileWrite.Enabled {
		destinations = append(destinations, c.FileWrite.Profiles...)
	}
	for _, p := range c.FileUpload.Profiles {
		sources = append(sources, uploadProfile(p))
		if c.FileUpload.Enabled {
			destinations = append(destinations, uploadProfile(p))
		}
	}
	for _, p := range c.ServiceConfigure.Profiles {
		sources = append(sources, serviceFileProfile(p))
		if c.ServiceConfigure.Enabled {
			destinations = append(destinations, serviceFileProfile(p))
		}
	}
	// Distinct purposes may not share a destination, a source or private custody.
	if purposesOverlap(c) {
		return fmt.Errorf("file mutation: operations share destination or custody")
	}
	for _, p := range destinations {
		for _, s := range sources {
			if p.Path == s.SourcePath {
				return fmt.Errorf("file mutation: destination aliases retained source custody")
			}
		}
		for _, store := range stores {
			if underPrefix(p.Path, store) || underPrefix(p.SourcePath, store) {
				return fmt.Errorf("file mutation: profile aliases private backup custody")
			}
		}
	}
	return nil
}

func strictFileMutationFields(raw json.RawMessage) (map[string]json.RawMessage, error) {
	fields := map[string]json.RawMessage{}
	scan := json.NewDecoder(bytes.NewReader(raw))
	tok, err := scan.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, invalid("file mutation args must be an object")
	}
	for scan.More() {
		token, er := scan.Token()
		key, ok := token.(string)
		if er != nil || !ok || fields[key] != nil {
			return nil, invalid("file mutation args contain duplicate or invalid members")
		}
		var value json.RawMessage
		if scan.Decode(&value) != nil {
			return nil, invalid("file mutation args are invalid")
		}
		fields[key] = value
	}
	if tok, err = scan.Token(); err != nil || tok != json.Delim('}') {
		return nil, invalid("file mutation args are invalid")
	}
	var extra any
	if scan.Decode(&extra) != io.EOF {
		return nil, invalid("file mutation args contain trailing data")
	}
	return fields, nil
}

func parseFileUpload(raw json.RawMessage) (fileUploadArgs, error) {
	// Preserve the write parser's duplicate/trailing-data refusal, shared path
	// guards and explicit prior preconditions with separate metadata keys.
	// Raw bytes are never accepted.
	var a fileUploadArgs
	fields, err := strictFileMutationFields(raw)
	if err != nil || len(fields) != 4 || fields["sourceRef"] == nil || fields["sourceVersion"] == nil || fields["path"] == nil || fields["expectedSha256"] == nil {
		return a, invalid("file.upload args do not match the strict local-source schema")
	}
	for key := range fields {
		if key != "path" && key != "sourceRef" && key != "sourceVersion" && key != "expectedSha256" {
			return a, invalid("file.upload args contain unsupported members")
		}
	}
	if json.Unmarshal(raw, &a) != nil || !canonicalWritePath(a.Path) || deniedWritePath(a.Path) || !writeID.MatchString(a.SourceRef) || !writeDigest.MatchString(a.SourceVersion) || (a.ExpectedSHA256 != nil && !writeDigest.MatchString(*a.ExpectedSHA256)) {
		return a, invalid("file.upload args do not match the strict local-source schema")
	}
	// Ref/version must be strings; null must not be silently normalized to empty.
	if string(fields["sourceRef"]) == "null" || string(fields["sourceVersion"]) == "null" {
		return a, invalid("file.upload args do not match the strict local-source schema")
	}
	return a, nil
}

func ValidateFileUploadConstraints(raw json.RawMessage, constraints map[string]any) error {
	a, err := parseFileUpload(raw)
	if err != nil {
		return err
	}
	return validateFileMutationConstraints(a.Path, constraints)
}

func prepareFileUpload(e *Env, req *Request) (Runnable, error) {
	if !e.Cfg.FileUpload.Enabled {
		return nil, disabled("file.upload is disabled locally")
	}
	if !fileWritePlatform() {
		return nil, unsupportedf("file.upload requires Linux")
	}
	if ValidateFileMutationConfig(e.Cfg) != nil {
		return nil, disabled("file.upload local profile is invalid")
	}
	a, err := parseFileUpload(req.Args)
	if err != nil {
		return nil, err
	}
	for _, p := range e.Cfg.FileUpload.Profiles {
		if p.Path != a.Path || p.SourceRef != a.SourceRef || p.SourceVersion != a.SourceVersion {
			continue
		}
		for _, d := range []string{e.StateDir, e.ConfigFile, e.AuditFile, e.Cfg.FileUpload.BackupDir, e.Cfg.FileWrite.BackupDir} {
			if d != "" && (underPrefix(a.Path, d) || underPrefix(p.SourcePath, d)) {
				return nil, notAllowed("upload profile holds protected local custody")
			}
		}
		return func(ctx context.Context) (Result, error) {
			return runFileMutation(ctx, e, fileWriteArgs{Path: a.Path, ContentRef: a.SourceRef, ContentVersion: a.SourceVersion, ExpectedSHA256: a.ExpectedSHA256}, uploadProfile(p), fileUploadPurpose)
		}, nil
	}
	return nil, notAllowed("upload does not match an exact local immutable binary profile")
}

func mutationConfig(e *Env, purpose fileMutationPurpose) (FileWriteConfig, bool) {
	switch purpose {
	case fileWritePurpose:
		return e.Cfg.FileWrite, e.Cfg.FileWrite.Enabled
	case fileUploadPurpose:
		return uploadBudget(e.Cfg.FileUpload), e.Cfg.FileUpload.Enabled
	case serviceConfigurePurpose:
		return serviceBudget(e.Cfg.ServiceConfigure), e.Cfg.ServiceConfigure.Enabled
	default:
		return FileWriteConfig{}, false
	}
}

func mutationBackupDir(e *Env, purpose fileMutationPurpose) string {
	cfg, _ := mutationConfig(e, purpose)
	return cfg.BackupDir
}

func mutationProfileVersion(e *Env, purpose fileMutationPurpose, p FileWriteProfile) (string, error) {
	switch purpose {
	case fileWritePurpose:
		return FileWriteProfileVersion(e.Cfg.FileWrite, p)
	case fileUploadPurpose:
		if !e.Cfg.FileUpload.Enabled {
			return "", disabled("file.upload is disabled locally")
		}
		current := false
		for _, configured := range e.Cfg.FileUpload.Profiles {
			if uploadProfile(configured) == p {
				current = true
			}
		}
		if !current {
			return "", notAllowed("file.upload no longer matches the current local profile")
		}
		return FileUploadProfileVersion(e.Cfg.FileUpload, FileUploadProfile{Path: p.Path, SourceRef: p.ContentRef, SourceVersion: p.ContentVersion, SourcePath: p.SourcePath, SHA256: p.SHA256, Mode: p.Mode, MaxBytes: p.MaxBytes})
	case serviceConfigurePurpose:
		if !e.Cfg.ServiceConfigure.Enabled {
			return "", disabled("service.configure is disabled locally")
		}
		for _, configured := range e.Cfg.ServiceConfigure.Profiles {
			if serviceFileProfile(configured) == p {
				return ServiceConfigureProfileVersion(e.Cfg.ServiceConfigure, configured)
			}
		}
		return "", notAllowed("service.configure no longer matches the current local profile")
	default:
		return "", protocol.Errorf(protocol.CodeConstraint, "invalid local file mutation purpose")
	}
}

func mutationFailure(purpose fileMutationPurpose, phase, effect, backup string) Result {
	r := writeFailure(phase, effect, backup)
	if purpose == fileUploadPurpose {
		r.Data["reason"] = "file.upload did not establish verified durable postconditions"
		r.Err = "file.upload " + phase + ": " + effect
	}
	return r
}
