package runner

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
)

// Credential-shaped fixtures are assembled at run time so no source line looks
// like a real key.
func fakeKeyID() string { return "AK" + "IA" + strings.Repeat("Q", 16) }

func fakeJWT(iss string) string {
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc([]byte(`{"iss":"`+iss+`"}`)) + "." + enc([]byte("sig-material"))
}

func baseConfig(mode string) *Config {
	c := &Config{CredentialMode: mode}
	c.ControlPlane.URL = "https://cp.example.test"
	return c
}

func TestCredentialModeDefaultsToLocalOnlyAndIsAdvertised(t *testing.T) {
	c := baseConfig("")
	if err := c.applyCredentialMode(); err != nil {
		t.Fatal(err)
	}
	if c.CredentialModeValue() != ModeLocalOnly || c.Labels[CredentialModeLabel] != ModeLocalOnly {
		t.Fatalf("mode=%q labels=%v", c.CredentialMode, c.Labels)
	}
	f := baseConfig(ModeFederated)
	if err := f.applyCredentialMode(); err != nil || f.Labels[CredentialModeLabel] != ModeFederated {
		t.Fatalf("federated: err=%v labels=%v", err, f.Labels)
	}
}

func TestCredentialModeRejectsUnknownAndConflictingLabel(t *testing.T) {
	if err := baseConfig("hybrid").applyCredentialMode(); err == nil {
		t.Fatal("unknown mode must be refused")
	}
	c := baseConfig(ModeLocalOnly)
	c.Labels = map[string]string{CredentialModeLabel: ModeFederated}
	if err := c.applyCredentialMode(); err == nil {
		t.Fatal("a label that contradicts credentialMode must be refused")
	}
}

func TestLocalOnlyRefusesZenithIssuedWebIdentity(t *testing.T) {
	read := func(token string) func(string) ([]byte, error) {
		return func(string) ([]byte, error) { return []byte(token), nil }
	}
	env := func(string) string { return "/var/run/token" }
	none := func(string) string { return "" }

	if err := checkLocalCustody(baseConfig(ModeLocalOnly), env, read(fakeJWT("https://cp.example.test/api/oidc"))); err == nil {
		t.Fatal("a Zenith-issued token must be refused for local_only")
	}
	if err := checkLocalCustody(baseConfig(ModeLocalOnly), env, read(fakeJWT("https://cp.example.test"))); err == nil {
		t.Fatal("an issuer on the control plane host must be refused for local_only")
	}
	if err := checkLocalCustody(baseConfig(ModeFederated), env, read(fakeJWT("https://cp.example.test/api/oidc"))); err != nil {
		t.Fatalf("federated runners may use Zenith-issued identity: %v", err)
	}
	if err := checkLocalCustody(baseConfig(ModeLocalOnly), env, read(fakeJWT("https://oidc.eks.example.test/id/ABC"))); err != nil {
		t.Fatalf("a customer IdP is local custody: %v", err)
	}
	if err := checkLocalCustody(baseConfig(ModeLocalOnly), none, read("")); err != nil {
		t.Fatalf("no token file: %v", err)
	}
	unreadable := func(string) ([]byte, error) { return nil, errors.New("nope") }
	if err := checkLocalCustody(baseConfig(ModeLocalOnly), env, unreadable); err != nil {
		t.Fatalf("an unreadable file is the credential chain's problem, not custody's: %v", err)
	}
}

func TestPayloadWithCredentialMaterialIsRejected(t *testing.T) {
	g := &custodyGuard{mode: ModeLocalOnly, getenv: func(string) string { return "" }}
	if err := g.checkPayload([]byte(`{"service":"ec2","headers":{"x-note":"` + fakeKeyID() + `"}}`)); err == nil {
		t.Fatal("a payload carrying a key id must be rejected")
	}
	if err := g.checkPayload([]byte(`{"service":"ec2","url":"https://ec2.us-east-1.amazonaws.com/","bodyB64":"` + base64.StdEncoding.EncodeToString([]byte(fakeKeyID())) + `"}`)); err != nil {
		t.Fatalf("opaque bodies are not inspected here: %v", err)
	}
	if err := g.checkPayload([]byte(`{"service":"ec2"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestLocalOnlyWithholdsResultWithCredentialMaterial(t *testing.T) {
	secret := "local-secret-" + strings.Repeat("x", 20)
	g := &custodyGuard{
		mode:    ModeLocalOnly,
		getenv:  func(string) string { return "" },
		secrets: func(context.Context) []string { return []string{secret} },
	}
	ctx := context.Background()

	for name, result := range map[string]any{
		"shape":  map[string]any{"body": "key " + fakeKeyID()},
		"exact":  map[string]any{"body": "value=" + secret},
		"nested": []any{map[string]any{"deep": "x " + secret}},
	} {
		out := g.guardResult(ctx, agent.ResultBody{Status: agent.StatusSucceeded, Result: result})
		m, ok := out.Result.(map[string]any)
		if !ok || m["withheld"] != "credential_material_detected" || m["redacted"] != true || m["completeness"] != "best_effort" {
			t.Fatalf("%s: result not withheld: %#v", name, out.Result)
		}
		if out.Status != agent.StatusSucceeded {
			t.Fatalf("%s: status must be kept, got %s", name, out.Status)
		}
	}

	clean := agent.ResultBody{Status: agent.StatusSucceeded, Result: map[string]any{"status": 200}}
	if out := g.guardResult(ctx, clean); out.Result == nil || out.Result.(map[string]any)["withheld"] != nil {
		t.Fatalf("a clean result must pass unchanged: %#v", out.Result)
	}

	withErr := g.guardResult(ctx, agent.ResultBody{Status: agent.StatusFailed, Error: "denied for " + fakeKeyID()})
	if strings.Contains(withErr.Error, fakeKeyID()) {
		t.Fatalf("error text must be redacted: %s", withErr.Error)
	}
}

func TestFederatedKeepsResultButRedactsError(t *testing.T) {
	g := &custodyGuard{mode: ModeFederated, getenv: func(string) string { return "" }}
	out := g.guardResult(context.Background(), agent.ResultBody{Status: agent.StatusFailed, Result: map[string]any{"b": "x " + fakeKeyID()}, Error: "bad " + fakeKeyID()})
	if out.Result.(map[string]any)["b"] == nil {
		t.Fatal("federated results are not withheld by the runner (the control plane sanitizes them)")
	}
	if strings.Contains(out.Error, fakeKeyID()) {
		t.Fatal("error text must be redacted in every mode")
	}
}
