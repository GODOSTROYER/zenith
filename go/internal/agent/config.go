// Package agent is the shared core of zenith-runner and zenithd: config
// loading, identity storage, registration, the signed HTTP client, the
// long-poll / heartbeat / result loop, revocation handling and graceful
// shutdown. The two binaries plug in a Processor that verifies and executes
// one dispatched job or machine request.
package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/miniyaml"
)

// Common is the configuration shared by both agents. Both binaries embed it
// in their own config struct, so its members appear at the top level of the
// config file.
type Common struct {
	ControlPlane ControlPlaneConfig `json:"controlPlane"`
	TLS          TLSConfig          `json:"tls"`
	// StateDir holds the identity key, the replay cache and (zenithd) the
	// audit log. It is created 0700.
	StateDir string `json:"stateDir"`
	// Name is the human-readable agent name sent at registration.
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
	Log    LogConfig         `json:"log"`
	// Registration names a file containing the single-use registration token
	// for automatic registration on first `run`. The token itself is never
	// stored in the config file; ZENITH_REGISTRATION_TOKEN also works.
	Registration RegistrationConfig `json:"registration"`

	PollWaitSec      int   `json:"pollWaitSec"`      // long-poll wait requested from the server (0-25)
	HeartbeatSec     int   `json:"heartbeatSec"`     // default 30
	MaxConcurrent    int   `json:"maxConcurrent"`    // jobs executing at once
	ShutdownGraceSec int   `json:"shutdownGraceSec"` // in-flight drain time on SIGTERM
	MaxResultBytes   int64 `json:"maxResultBytes"`   // hard cap on one posted result
}

// ControlPlaneConfig locates the control plane.
type ControlPlaneConfig struct {
	// URL is the control-plane origin, e.g. https://zenith.example.com (an
	// optional path prefix is allowed). It must be https; plain http is
	// accepted only for a loopback host (local development).
	URL string `json:"url"`
}

// TLSConfig configures server verification and optional client-cert mTLS.
type TLSConfig struct {
	// CAFile pins the CA bundle (PEM) used to verify the control plane. When
	// empty the system roots are used. Certificate verification is never
	// disabled.
	CAFile     string `json:"caFile"`
	ClientCert string `json:"clientCert"`
	ClientKey  string `json:"clientKey"`
}

// LogConfig configures process logging.
type LogConfig struct {
	Level  string `json:"level"`  // debug|info|warn|error
	Format string `json:"format"` // json|text
}

// RegistrationConfig configures auto-registration.
type RegistrationConfig struct {
	TokenFile string `json:"tokenFile"`
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

// ApplyDefaults fills zero values. defaultStateDir is per binary.
func (c *Common) ApplyDefaults(defaultStateDir string) {
	if c.StateDir == "" {
		c.StateDir = defaultStateDir
	}
	if c.Name == "" {
		if h, err := os.Hostname(); err == nil && nameRe.MatchString(h) {
			c.Name = h
		} else {
			c.Name = "agent"
		}
	}
	if c.PollWaitSec == 0 {
		c.PollWaitSec = 20
	}
	if c.HeartbeatSec == 0 {
		c.HeartbeatSec = 30
	}
	if c.MaxConcurrent == 0 {
		c.MaxConcurrent = 4
	}
	if c.ShutdownGraceSec == 0 {
		c.ShutdownGraceSec = 30
	}
	if c.MaxResultBytes == 0 {
		c.MaxResultBytes = 4 << 20 // stays under the 4.5 MB request limit of serverless hosts
	}
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.Format == "" {
		c.Log.Format = "json"
	}
}

// ApplyEnv applies ZENITH_* environment overrides. getenv is injectable.
func (c *Common) ApplyEnv(getenv func(string) string) {
	if v := getenv("ZENITH_CONTROL_PLANE_URL"); v != "" {
		c.ControlPlane.URL = v
	}
	if v := getenv("ZENITH_STATE_DIR"); v != "" {
		c.StateDir = v
	}
	if v := getenv("ZENITH_AGENT_NAME"); v != "" {
		c.Name = v
	}
	if v := getenv("ZENITH_LOG_LEVEL"); v != "" {
		c.Log.Level = v
	}
	if v := getenv("ZENITH_LOG_FORMAT"); v != "" {
		c.Log.Format = v
	}
	if v := getenv("ZENITH_TLS_CA_FILE"); v != "" {
		c.TLS.CAFile = v
	}
	if v := getenv("ZENITH_TLS_CLIENT_CERT"); v != "" {
		c.TLS.ClientCert = v
	}
	if v := getenv("ZENITH_TLS_CLIENT_KEY"); v != "" {
		c.TLS.ClientKey = v
	}
	if v := getenv("ZENITH_REGISTRATION_TOKEN_FILE"); v != "" {
		c.Registration.TokenFile = v
	}
	if v := getenv("ZENITH_POLL_WAIT_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			c.PollWaitSec = n
		}
	}
}

// Validate checks the shared settings.
func (c *Common) Validate() error {
	if err := validateControlPlaneURL(c.ControlPlane.URL); err != nil {
		return err
	}
	if (c.TLS.ClientCert == "") != (c.TLS.ClientKey == "") {
		return fmt.Errorf("tls.clientCert and tls.clientKey must be set together")
	}
	if c.StateDir == "" {
		return fmt.Errorf("stateDir is required")
	}
	if !nameRe.MatchString(c.Name) {
		return fmt.Errorf("name %q is invalid (letters, digits, . _ -, at most 63 characters)", c.Name)
	}
	if len(c.Labels) > 20 {
		return fmt.Errorf("at most 20 labels are allowed")
	}
	for k, v := range c.Labels {
		if k == "" || len(k) > 64 || len(v) > 128 {
			return fmt.Errorf("label %q is too long or empty", k)
		}
	}
	switch strings.ToLower(c.Log.Level) {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("log.level must be debug, info, warn or error")
	}
	switch strings.ToLower(c.Log.Format) {
	case "json", "text":
	default:
		return fmt.Errorf("log.format must be json or text")
	}
	if c.PollWaitSec < 0 || c.PollWaitSec > 25 {
		return fmt.Errorf("pollWaitSec must be between 0 and 25")
	}
	if c.HeartbeatSec < 5 || c.HeartbeatSec > 300 {
		return fmt.Errorf("heartbeatSec must be between 5 and 300")
	}
	if c.MaxConcurrent < 1 || c.MaxConcurrent > 64 {
		return fmt.Errorf("maxConcurrent must be between 1 and 64")
	}
	if c.ShutdownGraceSec < 0 || c.ShutdownGraceSec > 900 {
		return fmt.Errorf("shutdownGraceSec must be between 0 and 900")
	}
	if c.MaxResultBytes < 64<<10 || c.MaxResultBytes > 64<<20 {
		return fmt.Errorf("maxResultBytes must be between 65536 and 67108864")
	}
	return nil
}

func validateControlPlaneURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("controlPlane.url is required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("controlPlane.url is not a valid URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("controlPlane.url must not contain credentials, a query or a fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return fmt.Errorf("controlPlane.url must be https (plain http is allowed only for a loopback host in local development)")
		}
	default:
		return fmt.Errorf("controlPlane.url must be https")
	}
	return nil
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// LoadFile decodes a JSON or YAML(-subset) config file into dst (a pointer to
// a struct), rejecting unknown fields. Config files are limited to 1 MiB.
func LoadFile(path string, dst any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	return DecodeConfig(raw, strings.ToLower(path), dst)
}

// DecodeConfig decodes config bytes; nameHint is the file name (its
// extension selects YAML vs JSON, otherwise the first byte decides).
func DecodeConfig(raw []byte, nameHint string, dst any) error {
	if len(raw) > 1<<20 {
		return fmt.Errorf("config file is larger than 1 MiB")
	}
	trimmed := bytes.TrimSpace(raw)
	isJSON := len(trimmed) > 0 && trimmed[0] == '{'
	if strings.HasSuffix(nameHint, ".json") {
		isJSON = true
	}
	if !isJSON {
		v, err := miniyaml.Parse(raw)
		if err != nil {
			return fmt.Errorf("config YAML: %w", err)
		}
		raw, err = json.Marshal(v)
		if err != nil {
			return fmt.Errorf("config YAML: %w", err)
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if dec.More() {
		return fmt.Errorf("config: trailing content after the top-level object")
	}
	return nil
}
