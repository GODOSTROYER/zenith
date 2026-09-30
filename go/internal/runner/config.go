// Package runner wires the zenith-runner job kinds to the shared agent core.
package runner

import (
	"fmt"
	"os"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/runner/kinds"
)

// DefaultStateDir is where the runner keeps its identity, replay cache and
// saved plans unless configured otherwise.
const DefaultStateDir = "/var/lib/zenith-runner"

// Config is the zenith-runner configuration file (JSON or YAML).
type Config struct {
	agent.Common
	// Kinds enables and configures job kinds. A kind that is absent (or has
	// "enabled": false) is disabled and its jobs are rejected.
	Kinds KindsConfig `json:"kinds"`
	// Probes holds settings shared by probe.http / probe.tcp / probe.dns.
	Probes kinds.ProbeConfig `json:"probes"`
	// Limits clamps what a job may ask for.
	Limits LimitsConfig `json:"limits"`
	// RejectUnknownConstraints makes the runner refuse jobs whose grant
	// carries policy constraint keys it does not enforce (default: ignore
	// them; the control plane enforces those before dispatch).
	RejectUnknownConstraints bool `json:"rejectUnknownConstraints"`
}

// KindsConfig holds one block per job kind.
type KindsConfig struct {
	TofuRun   *kinds.TofuConfig `json:"tofu.run"`
	AWSHTTP   *kinds.AWSConfig  `json:"aws.http"`
	K8sHTTP   *kinds.K8sConfig  `json:"k8s.http"`
	ProbeHTTP *kinds.Toggle     `json:"probe.http"`
	ProbeTCP  *kinds.Toggle     `json:"probe.tcp"`
	ProbeDNS  *kinds.Toggle     `json:"probe.dns"`
}

// LimitsConfig bounds job timeouts and output.
type LimitsConfig struct {
	DefaultTimeoutSec  int   `json:"defaultTimeoutSec"`  // when the job names none (default 300)
	MaxTimeoutSec      int   `json:"maxTimeoutSec"`      // hard cap (default 3600)
	DefaultOutputBytes int64 `json:"defaultOutputBytes"` // when the job names none (default 1 MiB)
	MaxOutputBytes     int64 `json:"maxOutputBytes"`     // hard cap (default 8 MiB)
}

// LoadConfig reads, defaults, applies environment overrides to and validates
// the config file.
func LoadConfig(path string, getenv func(string) string) (*Config, error) {
	return loadConfig(path, getenv, true)
}

// LoadConfigForRegister is LoadConfig without the requirement that a job kind
// is enabled, so an agent can register before it is fully configured.
func LoadConfigForRegister(path string, getenv func(string) string) (*Config, error) {
	return loadConfig(path, getenv, false)
}

func loadConfig(path string, getenv func(string) string, requireKinds bool) (*Config, error) {
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
	if err := c.validate(requireKinds); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) applyDefaults() {
	l := &c.Limits
	if l.DefaultTimeoutSec == 0 {
		l.DefaultTimeoutSec = 300
	}
	if l.MaxTimeoutSec == 0 {
		l.MaxTimeoutSec = 3600
	}
	if l.DefaultOutputBytes == 0 {
		l.DefaultOutputBytes = 1 << 20
	}
	if l.MaxOutputBytes == 0 {
		l.MaxOutputBytes = 8 << 20
	}
}

// Validate checks the shared and runner-specific settings.
func (c *Config) Validate() error { return c.validate(true) }

func (c *Config) validate(requireKinds bool) error {
	if err := c.Common.Validate(); err != nil {
		return err
	}
	l := c.Limits
	if l.DefaultTimeoutSec < 1 || l.MaxTimeoutSec < l.DefaultTimeoutSec || l.MaxTimeoutSec > 86400 {
		return fmt.Errorf("limits: defaultTimeoutSec must be >= 1 and <= maxTimeoutSec (<= 86400)")
	}
	if l.DefaultOutputBytes < 1024 || l.MaxOutputBytes < l.DefaultOutputBytes || l.MaxOutputBytes > 64<<20 {
		return fmt.Errorf("limits: defaultOutputBytes must be >= 1024 and <= maxOutputBytes (<= 64 MiB)")
	}
	if requireKinds && len(c.EnabledKinds()) == 0 {
		return fmt.Errorf("no job kind is enabled: add at least one block under \"kinds\" (see docs/platform/RUNNER.md)")
	}
	return nil
}

// EnabledKinds lists the enabled kind names in a stable order.
func (c *Config) EnabledKinds() []string {
	var out []string
	if c.Kinds.TofuRun != nil && c.Kinds.TofuRun.IsOn() {
		out = append(out, kinds.KindTofuRun)
	}
	if c.Kinds.AWSHTTP != nil && c.Kinds.AWSHTTP.IsOn() {
		out = append(out, kinds.KindAWSHTTP)
	}
	if c.Kinds.K8sHTTP != nil && c.Kinds.K8sHTTP.IsOn() {
		out = append(out, kinds.KindK8sHTTP)
	}
	if c.Kinds.ProbeHTTP.IsOn() {
		out = append(out, kinds.KindProbeHTTP)
	}
	if c.Kinds.ProbeTCP.IsOn() {
		out = append(out, kinds.KindProbeTCP)
	}
	if c.Kinds.ProbeDNS.IsOn() {
		out = append(out, kinds.KindProbeDNS)
	}
	return out
}
