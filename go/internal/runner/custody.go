package runner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// CredentialModeLabel is the registration label through which the runner
// declares its credential mode to the control plane. The control plane refuses
// to dispatch a connection's work to a runner whose declared mode differs from
// the custody the connection requires.
const CredentialModeLabel = "zenith.credentialMode"

// Credential modes.
const (
	// ModeLocalOnly: credentials come only from this host's own environment
	// (instance or container role, local profile, customer-IdP web identity).
	// Zenith never sends, mints or receives credential material for this runner.
	ModeLocalOnly = "local_only"
	// ModeFederated: the runner's identity may be federated from Zenith's OIDC
	// issuer (a workload token file provisioned by the customer). No static key
	// material crosses the wire in either direction.
	ModeFederated = "federated"
)

// CredentialModeValue returns the configured mode; the zero value means local_only.
func (c *Config) CredentialModeValue() string {
	if c.CredentialMode == "" {
		return ModeLocalOnly
	}
	return c.CredentialMode
}

func (c *Config) applyCredentialMode() error {
	switch c.CredentialMode {
	case "", ModeLocalOnly:
		c.CredentialMode = ModeLocalOnly
	case ModeFederated:
	default:
		return fmt.Errorf("credentialMode must be %q or %q", ModeLocalOnly, ModeFederated)
	}
	if c.Labels == nil {
		c.Labels = map[string]string{}
	}
	if old, ok := c.Labels[CredentialModeLabel]; ok && old != c.CredentialMode {
		return fmt.Errorf("registration label %s conflicts with credentialMode", CredentialModeLabel)
	}
	c.Labels[CredentialModeLabel] = c.CredentialMode
	return nil
}

// checkLocalCustody refuses a local_only runner whose web identity token was
// issued by the Zenith control plane: that is federated custody, and the
// runner must say so (credentialMode: federated) instead of advertising local
// custody it does not have. A token file that cannot be read or parsed is not
// an error here; the credential chain reports it when it is used.
func checkLocalCustody(cfg *Config, getenv func(string) string, readFile func(string) ([]byte, error)) error {
	if cfg.CredentialModeValue() != ModeLocalOnly {
		return nil
	}
	path := getenv("AWS_WEB_IDENTITY_TOKEN_FILE")
	if path == "" {
		return nil
	}
	raw, err := readFile(path)
	if err != nil || len(raw) > 64<<10 {
		return nil
	}
	issuer := jwtIssuer(strings.TrimSpace(string(raw)))
	if issuer == "" {
		return nil
	}
	iss, err := url.Parse(issuer)
	if err != nil {
		return nil
	}
	cp, err := url.Parse(cfg.ControlPlane.URL)
	if err != nil {
		return nil
	}
	if strings.HasPrefix(iss.Path, "/api/oidc") || (cp.Host != "" && strings.EqualFold(iss.Host, cp.Host)) {
		return fmt.Errorf("credentialMode is local_only, but the web identity token in AWS_WEB_IDENTITY_TOKEN_FILE is issued by the Zenith control plane; set credentialMode to %q or use an identity source local to this host", ModeFederated)
	}
	return nil
}

// jwtIssuer returns the unverified iss claim of a compact JWT, or "".
func jwtIssuer(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Iss string `json:"iss"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	return claims.Iss
}

// custodyGuard enforces, for every job, that credential material neither
// arrives from nor leaves to the control plane.
type custodyGuard struct {
	mode    string
	getenv  func(string) string
	secrets func(context.Context) []string // extra exact values from the active credential source
}

// envSecretNames are the variables whose values are credentials this runner may hold locally.
var envSecretNames = []string{"AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN"}

func (g *custodyGuard) knownSecrets(ctx context.Context) []string {
	var out []string
	for _, n := range envSecretNames {
		if v := g.getenv(n); len(v) >= 8 {
			out = append(out, v)
		}
	}
	if g.secrets != nil {
		out = append(out, g.secrets(ctx)...)
	}
	return out
}

// checkPayload rejects a dispatched job whose payload carries credential
// material (any mode: a job never carries credentials, the runner signs with
// its own identity). Opaque base64 file bodies are not inspected here.
func (g *custodyGuard) checkPayload(payload []byte) error {
	var generic map[string]json.RawMessage
	if json.Unmarshal(payload, &generic) != nil {
		return nil
	}
	delete(generic, "files")
	delete(generic, "bodyB64")
	structure, err := json.Marshal(generic)
	if err != nil {
		return nil
	}
	if kinds := redact.Shapes(string(structure)); len(kinds) > 0 {
		return fmt.Errorf("the job payload carries credential material (%s); runner jobs never carry credentials", strings.Join(kinds, ", "))
	}
	return nil
}

// guardResult redacts the error text and, for a local_only runner, withholds a
// result that contains credential material (known local secret values or
// high-confidence credential shapes). The status is kept: the work may have
// happened, only the body is replaced by an explicit marker.
func (g *custodyGuard) guardResult(ctx context.Context, rb agent.ResultBody) agent.ResultBody {
	if rb.Error != "" {
		rb.Error = redact.String(rb.Error)
	}
	if g.mode != ModeLocalOnly || rb.Result == nil {
		return rb
	}
	encoded, err := json.Marshal(rb.Result)
	if err != nil {
		return rb
	}
	text := string(encoded)
	kinds := redact.Shapes(text)
	for _, s := range g.knownSecrets(ctx) {
		if strings.Contains(text, s) {
			kinds = append(kinds, "local-credential")
			break
		}
	}
	if len(kinds) == 0 {
		return rb
	}
	rb.Result = map[string]any{
		"withheld":     "credential_material_detected",
		"kinds":        kinds,
		"redacted":     true,
		"completeness": "best_effort",
		"note":         "this local_only runner withheld the result body because it contained credential material; the job status is unchanged",
	}
	return rb
}
