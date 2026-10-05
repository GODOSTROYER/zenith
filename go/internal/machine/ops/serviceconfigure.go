package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// ServiceConfigureConfig pins customer-local convergent service configuration.
// Each profile binds ONE application-owned configuration file (rendered from an
// operator-approved local source) to ONE allowlisted systemd service and ONE
// closed convergence action. The envelope can supply none of: bytes, paths, owners,
// modes, unit-file edits, command lines or the action. Privilege is separated:
// zenithd stays unprivileged, never writes unit files or /etc, and reaches systemd
// only through the same services.restartAllow authority machine.service.restart uses.
type ServiceConfigureConfig struct {
	Enabled        bool                      `json:"enabled"`
	BackupDir      string                    `json:"backupDir"`
	MaxBackupBytes int64                     `json:"maxBackupBytes"`
	MaxBackups     int                       `json:"maxBackups"`
	Profiles       []ServiceConfigureProfile `json:"profiles"`
}

type ServiceConfigureProfile struct {
	Unit           string `json:"unit"`
	ProfileRef     string `json:"profileRef"`
	ProfileVersion string `json:"profileVersion"`
	Path           string `json:"path"`
	SourcePath     string `json:"sourcePath"`
	SHA256         string `json:"sha256"`
	Mode           string `json:"mode"` // exactly 0600 or 0640
	MaxBytes       int64  `json:"maxBytes"`
	// Action converges the running service after a changed configuration: reload
	// (ExecReload) or restart. A unit that is not active is always restarted.
	Action string `json:"action"`
	// SettleSec bounds how long the unit may take to report active (1..60).
	SettleSec int `json:"settleSec"`
}

type serviceConfigureArgs struct {
	Unit           string  `json:"unit"`
	ProfileRef     string  `json:"profileRef"`
	ProfileVersion string  `json:"profileVersion"`
	ExpectedSHA256 *string `json:"expectedSha256"`
}

// One lock serializes service convergence in this process; the file mutation
// beneath it additionally takes the shared flock on the private backup store.
var serviceConfigureMu sync.Mutex

func init() { register(Operation{Name: OpServiceConfigure, Prepare: prepareServiceConfigure}) }

// Zenith's own channel and the host's control plane are never convergence targets.
var protectedUnitRes = []*regexp.Regexp{
	regexp.MustCompile(`^(ssh|sshd)(@.*)?\.(service|socket)$`),
	regexp.MustCompile(`^systemd-.*`),
	regexp.MustCompile(`^dbus(-broker)?\.(service|socket)$`),
	regexp.MustCompile(`^amazon-ssm-agent\.service$`),
	regexp.MustCompile(`^snap\.amazon-ssm-agent\..*`),
	regexp.MustCompile(`^zenithd\.service$`),
	regexp.MustCompile(`^zenith-runner\.service$`),
}

func protectedUnit(unit string) bool {
	for _, r := range protectedUnitRes {
		if r.MatchString(unit) {
			return true
		}
	}
	return false
}

func configurableUnit(unit string) bool {
	return ValidUnit(unit) && strings.HasSuffix(unit, ".service") && !protectedUnit(unit)
}

// serviceFileProfile adapts a service profile to the shared atomic file engine.
func serviceFileProfile(p ServiceConfigureProfile) FileWriteProfile {
	return FileWriteProfile{Path: p.Path, ContentRef: p.ProfileRef, ContentVersion: p.ProfileVersion, SourcePath: p.SourcePath, SHA256: p.SHA256, Mode: p.Mode, MaxBytes: p.MaxBytes}
}

func serviceBudget(c ServiceConfigureConfig) FileWriteConfig {
	return FileWriteConfig{Enabled: c.Enabled, BackupDir: c.BackupDir, MaxBackupBytes: c.MaxBackupBytes, MaxBackups: c.MaxBackups}
}

// ServiceConfigureProfileVersion reads metadata only. Its domain differs from
// file.write and file.upload; neither version can authorize the other, and every
// execution-relevant local semantic (unit, action, settle bound, file identity,
// budgets) is bound, so changing any of them requires a fresh approval.
func ServiceConfigureProfileVersion(c ServiceConfigureConfig, p ServiceConfigureProfile) (string, error) {
	if _, err := FileWriteProfileVersion(serviceBudget(c), serviceFileProfile(p)); err != nil {
		return "", fmt.Errorf("serviceConfigure: invalid canonical profile semantics")
	}
	if !configurableUnit(p.Unit) || (p.Action != "reload" && p.Action != "restart") || p.SettleSec < 1 || p.SettleSec > 60 {
		return "", fmt.Errorf("serviceConfigure: invalid canonical profile semantics")
	}
	canonical := struct {
		Unit           string `json:"unit"`
		ProfileRef     string `json:"profileRef"`
		Path           string `json:"path"`
		SourcePath     string `json:"sourcePath"`
		SHA256         string `json:"sha256"`
		Mode           string `json:"mode"`
		MaxBytes       int64  `json:"maxBytes"`
		Action         string `json:"action"`
		SettleSec      int    `json:"settleSec"`
		BackupDir      string `json:"backupDir"`
		MaxBackupBytes int64  `json:"maxBackupBytes"`
		MaxBackups     int    `json:"maxBackups"`
	}{p.Unit, p.ProfileRef, p.Path, p.SourcePath, p.SHA256, p.Mode, p.MaxBytes, p.Action, p.SettleSec, c.BackupDir, c.MaxBackupBytes, c.MaxBackups}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", fmt.Errorf("serviceConfigure: could not canonicalize profile metadata")
	}
	digest := sha256.Sum256(append([]byte("zenith.service.configure.profile/v1\x00"), raw...))
	return hex.EncodeToString(digest[:]), nil
}

// ValidateServiceConfigureConfig checks an enabled configuration. Unit authority
// (services.restartAllow) is cross-checked by ValidateFileMutationConfig, which
// sees the whole Config.
func ValidateServiceConfigureConfig(c ServiceConfigureConfig) error {
	if !c.Enabled {
		return nil
	}
	if len(c.Profiles) < 1 || len(c.Profiles) > 64 {
		return fmt.Errorf("serviceConfigure: invalid private backup limits or profiles")
	}
	paths, refs := map[string]bool{}, map[string]bool{}
	for _, p := range c.Profiles {
		version, err := ServiceConfigureProfileVersion(c, p)
		if err != nil || !writeDigest.MatchString(p.ProfileVersion) || version != p.ProfileVersion || paths[p.Path] || refs[p.ProfileRef] {
			return fmt.Errorf("serviceConfigure: invalid or duplicate immutable service profile")
		}
		paths[p.Path], refs[p.ProfileRef] = true, true
	}
	for _, p := range c.Profiles {
		for _, s := range c.Profiles {
			if p.Path == s.SourcePath {
				return fmt.Errorf("serviceConfigure: destination aliases a source")
			}
		}
	}
	return nil
}

// validateServiceConfigureAuthority proves every enabled profile's unit is inside
// the machine's existing restart allowlist and that no custody is shared.
func validateServiceConfigureAuthority(c Config) error {
	if err := ValidateServiceConfigureConfig(c.ServiceConfigure); err != nil {
		return err
	}
	if !c.ServiceConfigure.Enabled {
		return nil
	}
	for _, p := range c.ServiceConfigure.Profiles {
		if !restartAllowed(c.Services.RestartAllow, p.Unit) {
			return fmt.Errorf("serviceConfigure: unit is not in services.restartAllow")
		}
	}
	return nil
}

func parseServiceConfigure(raw json.RawMessage) (serviceConfigureArgs, error) {
	var a serviceConfigureArgs
	fields, err := strictFileMutationFields(raw)
	if err != nil || len(fields) != 4 || fields["unit"] == nil || fields["profileRef"] == nil || fields["profileVersion"] == nil || fields["expectedSha256"] == nil {
		return a, invalid("service.configure args do not match the strict local-profile schema")
	}
	for key := range fields {
		if key != "unit" && key != "profileRef" && key != "profileVersion" && key != "expectedSha256" {
			return a, invalid("service.configure args contain unsupported members")
		}
	}
	if json.Unmarshal(raw, &a) != nil || !configurableUnit(a.Unit) || !writeID.MatchString(a.ProfileRef) || !writeDigest.MatchString(a.ProfileVersion) || (a.ExpectedSHA256 != nil && !writeDigest.MatchString(*a.ExpectedSHA256)) {
		return a, invalid("service.configure args do not match the strict local-profile schema")
	}
	if string(fields["profileRef"]) == "null" || string(fields["profileVersion"]) == "null" || string(fields["unit"]) == "null" {
		return a, invalid("service.configure args do not match the strict local-profile schema")
	}
	return a, nil
}

// ValidateServiceConfigureConstraints fails closed for every grant constraint the
// guest does not enforce. Paths are never caller-selected, so pathPrefixes has no
// meaning here and is refused rather than silently ignored.
func ValidateServiceConfigureConstraints(raw json.RawMessage, constraints map[string]any) error {
	if _, err := parseServiceConfigure(raw); err != nil {
		return err
	}
	for k, v := range constraints {
		switch k {
		case "maxTimeoutSec", "maxOutputBytes":
			n, ok := v.(float64)
			if !ok || n < 1 || n != float64(int64(n)) || n > 1<<30 {
				return protocol.Errorf(protocol.CodeConstraint, "invalid service configuration budget constraint")
			}
		default:
			return protocol.Errorf(protocol.CodeConstraint, "unsupported service.configure constraint")
		}
	}
	return nil
}

func prepareServiceConfigure(e *Env, req *Request) (Runnable, error) {
	if !e.Cfg.ServiceConfigure.Enabled {
		return nil, disabled("service.configure is disabled locally")
	}
	if !fileWritePlatform() {
		return nil, unsupportedf("service.configure requires Linux")
	}
	if ValidateFileMutationConfig(e.Cfg) != nil {
		return nil, disabled("service.configure local profile is invalid")
	}
	a, err := parseServiceConfigure(req.Args)
	if err != nil {
		return nil, err
	}
	if !restartAllowed(e.Cfg.Services.RestartAllow, a.Unit) {
		return nil, notAllowed("unit is not in services.restartAllow on this machine")
	}
	for _, p := range e.Cfg.ServiceConfigure.Profiles {
		if p.Unit != a.Unit || p.ProfileRef != a.ProfileRef || p.ProfileVersion != a.ProfileVersion {
			continue
		}
		for _, d := range []string{e.StateDir, e.ConfigFile, e.AuditFile, e.Cfg.ServiceConfigure.BackupDir, e.Cfg.FileWrite.BackupDir, e.Cfg.FileUpload.BackupDir} {
			if d != "" && (underPrefix(p.Path, d) || underPrefix(p.SourcePath, d)) {
				return nil, notAllowed("service profile holds protected local custody")
			}
		}
		return func(ctx context.Context) (Result, error) { return runServiceConfigure(ctx, e, a, p) }, nil
	}
	return nil, notAllowed("service.configure does not match an exact local immutable service profile")
}

// serviceFailure never carries command output, paths or arbitrary text.
func serviceFailure(kind, phase, effect, backup, transaction string) Result {
	d := map[string]any{"error": kind, "phase": phase, "effect": effect, "postcondition": "unverified"}
	if backup != "" {
		d["backupRef"] = backup
	}
	if transaction != "" {
		d["transactionRef"] = transaction
	}
	return Result{OK: false, Data: d, Err: "service.configure " + phase + ": " + effect}
}

func serviceUncertain(phase, backup, transaction string) Result {
	return serviceFailure("mutation_uncertain", phase, "unknown", backup, transaction)
}

func receiptString(d map[string]any, key string) string { s, _ := d[key].(string); return s }

func (e *Env) settle(ctx context.Context, d time.Duration) error {
	if e.sleep != nil {
		return e.sleep(ctx, d)
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// systemctlAction runs one fixed `systemctl <verb> --no-pager -- <unit>`.
func (e *Env) systemctlAction(ctx context.Context, verb, unit string) (exit int, err error) {
	res, err := e.runner().Run(ctx, CmdSpec{Path: e.systemctl(), Args: []string{verb, "--no-pager", "--", unit}, Env: SafeEnv(), MaxStdout: 4 << 10, MaxStderr: 4 << 10})
	return res.ExitCode, err
}

func runServiceConfigure(ctx context.Context, e *Env, a serviceConfigureArgs, p ServiceConfigureProfile) (Result, error) {
	serviceConfigureMu.Lock()
	defer serviceConfigureMu.Unlock()

	// Refuse before any file effect when the unit cannot be converged at all: a
	// missing unit, or a systemd that cannot be consulted, must not leave a committed
	// configuration behind.
	if ctx.Err() != nil {
		return serviceFailure("refused", "guard", "none", "", ""), nil
	}
	if pre, perr := e.unitStatus(ctx, p.Unit); perr != nil || pre["loadState"] != "loaded" {
		return serviceFailure("refused", "guard", "none", "", ""), nil
	}

	file, err := runFileMutation(ctx, e, fileWriteArgs{Path: p.Path, ContentRef: p.ProfileRef, ContentVersion: p.ProfileVersion, ExpectedSHA256: a.ExpectedSHA256}, serviceFileProfile(p), serviceConfigurePurpose)
	if err != nil {
		return Result{}, err
	}
	backup, transaction := receiptString(file.Data, "backupRef"), receiptString(file.Data, "transactionRef")
	if !file.OK {
		// The shared engine's receipt is already bounded: only its closed phase and
		// effect vocabulary crosses, never its reason text.
		kind := "refused"
		if receiptString(file.Data, "effect") == "unknown" {
			kind = "mutation_uncertain"
		}
		return serviceFailure(kind, receiptString(file.Data, "phase"), receiptString(file.Data, "effect"), backup, transaction), nil
	}
	changed, _ := file.Data["changed"].(bool)

	// committedFailure: the file (or an attempted action) took effect but the unit
	// did not verify healthy. That is a definite, retained failure, not an unknown.
	fail := func(phase string, attempted bool) (Result, error) {
		if ctx.Err() != nil && attempted {
			return serviceUncertain(phase, backup, transaction), nil
		}
		if changed || attempted {
			return serviceFailure("service_failed", phase, "committed", backup, transaction), nil
		}
		return serviceFailure("refused", phase, "none", backup, transaction), nil
	}

	// A cancelled context only leaves an unknown when something may have changed.
	unknown := func(phase string, action string) (Result, error) {
		if !changed && action == "none" {
			return serviceFailure("refused", phase, "none", backup, transaction), nil
		}
		return serviceUncertain(phase, backup, transaction), nil
	}

	before, err := e.unitStatus(ctx, p.Unit)
	if err != nil || before["loadState"] != "loaded" {
		return fail("service_action", false)
	}
	action := "none"
	switch {
	case before["activeState"] != "active":
		action = "restart" // reload cannot converge an inactive unit, even after a file change
	case changed:
		action = p.Action
	}
	if action != "none" {
		exit, runErr := e.systemctlAction(ctx, action, p.Unit)
		if runErr != nil {
			var cancelled = errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) || ctx.Err() != nil
			if cancelled {
				return unknown("service_action", action)
			}
			return fail("service_action", false)
		}
		if exit != 0 {
			return fail("service_action", true)
		}
	}

	// Postcondition: the unit must report loaded+active within the profile bound.
	// Bounded by poll count, not wall clock, so an injected clock cannot unbound it.
	for poll := 0; ; poll++ {
		if ctx.Err() != nil {
			return unknown("service_postcondition", action)
		}
		st, serr := e.unitStatus(ctx, p.Unit)
		if serr == nil && st["loadState"] == "loaded" && st["activeState"] == "active" {
			d := map[string]any{
				"unit": p.Unit, "profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion,
				"changed": changed, "created": file.Data["created"], "bytesWritten": file.Data["bytesWritten"],
				"action": action, "activeState": "active", "postcondition": "verified", "phase": "verified", "effect": "none",
			}
			if changed || action != "none" {
				d["effect"] = "committed"
			}
			if backup != "" {
				d["backupRef"] = backup
			}
			if transaction != "" {
				d["transactionRef"] = transaction
			}
			return Result{OK: true, Data: d}, nil
		}
		terminal := serr == nil && (st["activeState"] == "failed" || st["activeState"] == "inactive")
		if terminal || poll >= p.SettleSec*4 {
			return fail("service_postcondition", action != "none")
		}
		if e.settle(ctx, 250*time.Millisecond) != nil {
			return unknown("service_postcondition", action)
		}
	}
}

// purposesOverlap keeps service convergence from sharing a destination or a private
// backup store with the file operations (their retained custody is never aliased).
func purposesOverlap(c Config) bool {
	if len(c.ServiceConfigure.Profiles) == 0 && c.ServiceConfigure.BackupDir == "" {
		return false
	}
	destinations := map[string]bool{}
	for _, p := range c.FileWrite.Profiles {
		destinations[p.Path] = true
	}
	for _, p := range c.FileUpload.Profiles {
		destinations[p.Path] = true
	}
	for _, p := range c.ServiceConfigure.Profiles {
		if destinations[p.Path] {
			return true
		}
	}
	store := c.ServiceConfigure.BackupDir
	return store != "" && (store == c.FileWrite.BackupDir || store == c.FileUpload.BackupDir)
}
