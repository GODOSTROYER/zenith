// Package ops implements the zenithd semantic machine operations
// (docs/platform/RUNNER-PROTOCOL.md section 5). Every operation is fixed code:
// no shell string is ever built from arguments. Arguments are decoded
// strictly, validated, and only then used to build argv lists, file opens or
// Docker Engine API calls. Each operation has a local guard (unit-name regex,
// restart allowlist, path allowlist with symlink-escape protection, container
// and exec enable flags) that the control plane cannot override.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/version"
)

// Operation names (src/lib/machines/types.ts MACHINE_OPERATIONS).
const (
	OpInspect          = "machine.inspect"
	OpProcessList      = "process.list"
	OpServiceStatus    = "service.status"
	OpServiceRestart   = "machine.service.restart"
	OpContainerList    = "container.list"
	OpContainerInspect = "container.inspect"
	OpContainerLogs    = "container.logs"
	OpContainerExec    = "container.exec"
	OpFileRead         = "file.read"
	OpFileWrite        = "file.write"
	OpFileUpload       = "file.upload"
	OpPackageInstall   = "package.install"
	OpPortCheck        = "network.portCheck"
	OpDNSCheck         = "network.dnsCheck"
	OpMetrics          = "system.metrics"
	OpLogs             = "system.logs"
	OpExec             = "machine.exec"
)

// Unsupported lists operations that exist in the platform vocabulary but that
// zenithd deliberately does not implement (writing files and installing
// packages need a reviewed design of their own; see docs/platform/ZENITHD.md).
var Unsupported = map[string]bool{OpFileWrite: true, OpFileUpload: true, OpPackageInstall: true}

// Config is the operation-relevant part of the zenithd configuration.
type Config struct {
	Services   ServicesConfig   `json:"services"`
	Containers ContainersConfig `json:"containers"`
	Exec       ExecConfig       `json:"exec"`
	Files      FilesConfig      `json:"files"`
	// SystemctlPath and JournalctlPath default to /usr/bin/...
	SystemctlPath  string `json:"systemctlPath"`
	JournalctlPath string `json:"journalctlPath"`
}

// ServicesConfig guards service operations.
type ServicesConfig struct {
	// RestartAllow lists the units machine.service.restart may restart: exact
	// names or names with '*' wildcards (e.g. "app@*.service"). Empty means no
	// unit may be restarted.
	RestartAllow []string `json:"restartAllow"`
}

// ContainersConfig guards the Docker Engine operations.
type ContainersConfig struct {
	Enabled bool `json:"enabled"`
	// Socket defaults to /var/run/docker.sock.
	Socket string `json:"socket"`
}

// ExecConfig guards machine.exec and container.exec. Both are off by default.
type ExecConfig struct {
	Enabled bool `json:"enabled"`
	// AllowArgv0 optionally restricts machine.exec to these absolute
	// executables. Empty allows any absolute path when exec is enabled.
	AllowArgv0 []string `json:"allowArgv0"`
}

// FilesConfig guards file.read.
type FilesConfig struct {
	// ReadAllow lists absolute directory (or file) prefixes file.read may
	// read. Empty means file.read is refused. Symlinks are resolved before the
	// check, so a link inside an allowed directory cannot lead outside it.
	ReadAllow []string `json:"readAllow"`
	// MaxReadBytes caps one read (default 1 MiB, also bounded by the request).
	MaxReadBytes int64 `json:"maxReadBytes"`
}

// Env carries the collaborators; tests replace them.
type Env struct {
	Cfg        Config
	StateDir   string // never readable through file.read
	ConfigFile string
	ProcRoot   string // default /proc
	OSRelease  string // default /etc/os-release
	Now        func() time.Time
	Resolver   netguard.Resolver
	Runner     CmdRunner
	Docker     *Docker
	Version    string
}

// Request is one validated request to run an operation.
type Request struct {
	JTI            string
	Args           json.RawMessage
	Timeout        time.Duration
	MaxOutputBytes int64
}

// Result is what an operation reports (the MachineResult of the TS contract).
type Result struct {
	OK     bool           `json:"ok"`
	Data   map[string]any `json:"data"`
	Output *Output        `json:"output,omitempty"`
	// Err, when set, makes the job report status "failed" with this error while
	// still returning the (partial) Result. It is never serialized itself.
	Err string `json:"-"`
}

// Output is raw stdout/stderr of an exec-style operation, truncated.
type Output struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  *int   `json:"exitCode"`
	Truncated bool   `json:"truncated"`
}

// Runnable executes a validated operation.
type Runnable func(ctx context.Context) (Result, error)

// Operation implements one semantic operation.
type Operation struct {
	Name string
	// Prepare validates args against the local guards and returns the runnable.
	Prepare func(e *Env, req *Request) (Runnable, error)
}

var registry = map[string]Operation{}

func register(op Operation) { registry[op.Name] = op }

// Supported lists the operations zenithd can run under cfg (used for
// registration and heartbeats): operations whose local guard is closed
// (containers, exec) are omitted.
func Supported(cfg Config) []string {
	var out []string
	for _, name := range []string{OpInspect, OpProcessList, OpServiceStatus, OpServiceRestart, OpContainerList, OpContainerInspect, OpContainerLogs, OpContainerExec, OpFileRead, OpPortCheck, OpDNSCheck, OpMetrics, OpLogs, OpExec} {
		switch name {
		case OpContainerList, OpContainerInspect, OpContainerLogs:
			if !cfg.Containers.Enabled {
				continue
			}
		case OpContainerExec:
			if !cfg.Containers.Enabled || !cfg.Exec.Enabled {
				continue
			}
		case OpExec:
			if !cfg.Exec.Enabled {
				continue
			}
		case OpServiceRestart:
			if len(cfg.Services.RestartAllow) == 0 {
				continue
			}
		case OpFileRead:
			if len(cfg.Files.ReadAllow) == 0 {
				continue
			}
		}
		out = append(out, name)
	}
	return out
}

// Prepare validates a request for the named operation.
func (e *Env) Prepare(name string, req *Request) (Runnable, error) {
	if Unsupported[name] {
		return nil, protocol.Errorf(protocol.CodeUnsupportedOp, "%s is not implemented by zenithd", name)
	}
	op, ok := registry[name]
	if !ok {
		return nil, protocol.Errorf(protocol.CodeUnsupportedOp, "unknown operation %q", clip(name, 40))
	}
	return op.Prepare(e, req)
}

/* --------------------------------- helpers --------------------------------- */

// decodeArgs decodes args strictly; an absent or null args value is {}.
func decodeArgs(raw json.RawMessage, dst any) error {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return protocol.Errorf(protocol.CodeInvalidPayload, "args do not match the operation schema: %v", err)
	}
	if dec.More() {
		return protocol.Errorf(protocol.CodeInvalidPayload, "trailing data after args")
	}
	return nil
}

func invalid(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeInvalidPayload, format, args...)
}

func notAllowed(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeNotAllowed, format, args...)
}

func disabled(format string, args ...any) error {
	return protocol.Errorf(protocol.CodeDisabledByConfig, format, args...)
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func (e *Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func (e *Env) procRoot() string {
	if e.ProcRoot != "" {
		return e.ProcRoot
	}
	return "/proc"
}

func (e *Env) osRelease() string {
	if e.OSRelease != "" {
		return e.OSRelease
	}
	return "/etc/os-release"
}

func (e *Env) runner() CmdRunner {
	if e.Runner != nil {
		return e.Runner
	}
	return ExecRunner{}
}

func (e *Env) systemctl() string {
	if e.Cfg.SystemctlPath != "" {
		return e.Cfg.SystemctlPath
	}
	return firstExisting("/usr/bin/systemctl", "/bin/systemctl")
}

func (e *Env) journalctl() string {
	if e.Cfg.JournalctlPath != "" {
		return e.Cfg.JournalctlPath
	}
	return firstExisting("/usr/bin/journalctl", "/bin/journalctl")
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return paths[0]
}

// ErrUnsupported means the operation cannot run on this host (not Linux, or
// no /proc, no systemd, ...). The executor reports it as a failed result with
// the code unsupported_platform, not as a rejection.
var ErrUnsupported = errors.New("unsupported_platform: this operation needs a Linux host with /proc")

func unsupportedf(format string, args ...any) error {
	return fmt.Errorf("unsupported_platform: "+format, args...)
}

// safeDir cleans a path and requires it to be absolute.
func absClean(p string) (string, error) {
	if p == "" || !filepath.IsAbs(p) {
		return "", invalid("path must be absolute")
	}
	if bytes.IndexByte([]byte(p), 0) >= 0 {
		return "", invalid("path contains a NUL byte")
	}
	return filepath.Clean(p), nil
}

// build info shown by machine.inspect.
func (e *Env) version() string {
	if e.Version != "" {
		return e.Version
	}
	return version.Version
}
