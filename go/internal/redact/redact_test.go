package redact

import (
	"strings"
	"testing"
)

func TestStringRedactsCredentialShapes(t *testing.T) {
	secrets := map[string]string{
		"aws key id":            "found AKIAIOSFODNN7EXAMPLE in env",
		"temporary key id":      "ASIAIOSFODNN7EXAMPLE",
		"aws secret (env form)": "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		"aws secret (ini form)": "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		"jwt":                   "token eyJhbGciOiJFZERTQSJ9.eyJqdGkiOiJqb2JfMSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU",
		"bearer":                "Authorization: Bearer abcdefghijklmnop1234567890",
		"zenith token":          "registration zrt_abcdef123456",
		"github token":          "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"slack token":           "xoxb-1234567890-abcdefghij",
		"password kv":           "db password=hunter2hunter2",
		"json password":         `{"user":"a","password": "hunter2hunter2"}`,
		"api key kv":            "API_KEY: sk_live_abcdefghijklmnop",
		"private key":           "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
		"truncated private key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
		"quoted secret":         `client_secret = "abc def ghi 123"`,
	}
	needles := map[string]string{
		"aws key id": "AKIAIOSFODNN7EXAMPLE", "temporary key id": "ASIAIOSFODNN7EXAMPLE", "aws secret (env form)": "wJalrXUtnFEMI", "aws secret (ini form)": "wJalrXUtnFEMI",
		"jwt": "c2lnbmF0dXJl", "bearer": "abcdefghijklmnop1234567890", "zenith token": "abcdef123456", "github token": "ghp_abcdefghij", "slack token": "xoxb-123456",
		"password kv": "hunter2hunter2", "json password": "hunter2hunter2", "api key kv": "sk_live_abcdefghijklmnop", "private key": "MIIEpAIBAAKCAQEA",
		"truncated private key": "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "quoted secret": "abc def ghi 123",
	}
	for name, in := range secrets {
		out := String(in)
		if strings.Contains(out, needles[name]) {
			t.Errorf("%s: %q leaked: %q", name, needles[name], out)
		}
		if !strings.Contains(out, "REDACTED") {
			t.Errorf("%s: no redaction marker in %q", name, out)
		}
		if String(out) != out {
			t.Errorf("%s: redaction must be idempotent", name)
		}
	}
}

func TestStringKeepsOrdinaryTextAndStructure(t *testing.T) {
	keep := []string{
		"Plan: 1 to add, 0 to change, 0 to destroy.",
		"aws_instance.web: Creating...",
		"Apply complete! Resources: 1 added.",
		`{"name":"web","port":8080,"enabled":true}`,
		"token_type = null",
		"password = (sensitive)",
		"db_password = (sensitive value)",
		"token = (known after apply)",
		"secret: true",
		"listen 8080;",
		"user@example.com logged in from 10.0.0.5",
		"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	}
	for _, in := range keep {
		if out := String(in); out != in {
			t.Errorf("%q was altered to %q", in, out)
		}
	}
	// the key is kept so the log stays readable, only the value goes
	if out := String("password=hunter2hunter2 user=bob"); out != "password=[REDACTED] user=bob" {
		t.Errorf("%q", out)
	}
	if out := String(`{"password": "abc", "name": "web"}`); !strings.Contains(out, `"password": "[REDACTED]"`) || !strings.Contains(out, `"name": "web"`) {
		t.Errorf("%q", out)
	}
}

func TestLinesSuppressesMultiLinePrivateKeys(t *testing.T) {
	var l Lines
	in := []string{"before", "-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "AAAAB3NzaC1yc2EAAAADAQABAAABAQC", "-----END OPENSSH PRIVATE KEY-----", "after"}
	var out []string
	for _, s := range in {
		out = append(out, l.Line(s))
	}
	joined := strings.Join(out, "\n")
	if strings.Contains(joined, "b3BlbnNzaC1") || strings.Contains(joined, "AAAAB3NzaC1") {
		t.Fatalf("key material leaked: %s", joined)
	}
	if out[0] != "before" || out[5] != "after" {
		t.Fatalf("surrounding lines must be untouched: %v", out)
	}
	// a key whose END line never arrives stays suppressed until the stream ends
	var l2 Lines
	l2.Line("-----BEGIN PRIVATE KEY-----")
	if got := l2.Line("more key bytes"); got == "more key bytes" {
		t.Fatal("unterminated key body must be suppressed")
	}
}

func TestRedactionHandlesHostileInputQuickly(t *testing.T) {
	// RE2 guarantees linear time; this guards against an accidental move to a backtracking engine.
	nasty := strings.Repeat("password=", 20000) + strings.Repeat("a", 200000)
	_ = String(nasty)
	_ = String(strings.Repeat("-----BEGIN PRIVATE KEY-----", 5000))
}
