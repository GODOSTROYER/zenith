// Package machine wires the zenithd semantic operations to the shared agent
// core: configuration, the local audit log and the request executor.
package machine

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

// DefaultStateDir is where zenithd keeps its identity, replay cache and audit log.
const DefaultStateDir = "/var/lib/zenithd"

// Config is the zenithd configuration file (JSON or YAML). The operation
// guards (services, containers, exec, files) sit at the top level.
type Config struct {
	agent.Common
	ops.Config
	Limits LimitsConfig `json:"limits"`
	// Audit configures the local audit log.
	Audit AuditConfig `json:"audit"`
	// RejectUnknownConstraints refuses requests whose grant carries policy
	// constraint keys zenithd does not enforce (default: ignore them).
	RejectUnknownConstraints bool `json:"rejectUnknownConstraints"`
}

// AuditConfig locates the audit log.
type AuditConfig struct {
	// Path defaults to <stateDir>/audit.jsonl (mode 0600, append-only).
	Path string `json:"path"`
}

// LimitsConfig clamps what a request may ask for.
type LimitsConfig struct {
	DefaultTimeoutSec  int   `json:"defaultTimeoutSec"`  // default 30
	MaxTimeoutSec      int   `json:"maxTimeoutSec"`      // default 300
	DefaultOutputBytes int64 `json:"defaultOutputBytes"` // default 64 KiB
	MaxOutputBytes     int64 `json:"maxOutputBytes"`     // default 1 MiB
}

// LoadConfig reads, defaults, applies environment overrides to and validates
// the config file. path may be empty (defaults and environment only).
func LoadConfig(path string, getenv func(string) string) (*Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	var c Config
	if path != "" {
		if err := agent.LoadFile(path, &c); err != nil {
			return nil, err
		}
	}
	c.ApplyDefaults(DefaultStateDir)
	c.applyDefaults()
	c.ApplyEnv(getenv)
	if c.Audit.Path == "" {
		c.Audit.Path = filepath.Join(c.StateDir, "audit.jsonl")
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	l := &c.Limits
	if l.DefaultTimeoutSec == 0 {
		l.DefaultTimeoutSec = 30
	}
	if l.MaxTimeoutSec == 0 {
		l.MaxTimeoutSec = 300
	}
	if l.DefaultOutputBytes == 0 {
		l.DefaultOutputBytes = 64 << 10
	}
	if l.MaxOutputBytes == 0 {
		l.MaxOutputBytes = 1 << 20
	}
	if c.Files.MaxReadBytes == 0 {
		c.Files.MaxReadBytes = 1 << 20
	}
}

// Validate checks the shared and zenithd-specific settings.
func (c *Config) Validate() error {
	if err := c.Common.Validate(); err != nil {
		return err
	}
	l := c.Limits
	if l.DefaultTimeoutSec < 1 || l.MaxTimeoutSec < l.DefaultTimeoutSec || l.MaxTimeoutSec > 3600 {
		return fmt.Errorf("limits: defaultTimeoutSec must be >= 1 and <= maxTimeoutSec (<= 3600)")
	}
	if l.DefaultOutputBytes < 1024 || l.MaxOutputBytes < l.DefaultOutputBytes || l.MaxOutputBytes > 16<<20 {
		return fmt.Errorf("limits: defaultOutputBytes must be >= 1024 and <= maxOutputBytes (<= 16 MiB)")
	}
	if err := ops.ValidateRestartPatterns(c.Services.RestartAllow); err != nil {
		return err
	}
	if err := ops.ValidateReadAllow(c.Files.ReadAllow); err != nil {
		return err
	}
	if err := ops.ValidateFileWriteConfig(c.FileWrite); err != nil {
		return err
	}
	if c.Containers.Socket != "" && !filepath.IsAbs(c.Containers.Socket) {
		return fmt.Errorf("containers.socket must be an absolute path")
	}
	for _, p := range c.Exec.AllowArgv0 {
		if !filepath.IsAbs(p) {
			return fmt.Errorf("exec.allowArgv0 entry %q must be an absolute path", p)
		}
	}
	if !filepath.IsAbs(c.Audit.Path) {
		return fmt.Errorf("audit.path must be an absolute path")
	}
	return nil
}
