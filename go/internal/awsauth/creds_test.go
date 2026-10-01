package awsauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func envMap(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestChainStaticEnv(t *testing.T) {
	p, src := NewChain(ProviderConfig{Getenv: envMap(map[string]string{
		"AWS_ACCESS_KEY_ID": "AKIAENV", "AWS_SECRET_ACCESS_KEY": "s3cr3t", "AWS_SESSION_TOKEN": "tok",
		// lower-priority sources must be ignored when static keys are present
		"AWS_WEB_IDENTITY_TOKEN_FILE": "/nonexistent", "AWS_ROLE_ARN": "arn:aws:iam::1:role/x",
	})})
	if src != "env" {
		t.Fatalf("source %s", src)
	}
	c, err := p.Retrieve(context.Background())
	if err != nil || c.AccessKeyID != "AKIAENV" || c.SessionToken != "tok" {
		t.Fatalf("%v %v", c, err)
	}
}

func TestChainNoSourceWhenIMDSDisabled(t *testing.T) {
	p, src := NewChain(ProviderConfig{Getenv: envMap(map[string]string{"AWS_EC2_METADATA_DISABLED": "true"})})
	if src != "none" {
		t.Fatal(src)
	}
	if _, err := p.Retrieve(context.Background()); err == nil {
		t.Fatal("expected an error when no source is configured")
	}
}

const stsOK = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
<AssumeRoleWithWebIdentityResult><Credentials>
<AccessKeyId>ASIAWEB</AccessKeyId><SecretAccessKey>websecret</SecretAccessKey><SessionToken>webtoken</SessionToken>
<Expiration>%s</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`

func TestWebIdentityCallsSTSAndCaches(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	if err := os.WriteFile(tokenFile, []byte("the-oidc-jwt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	var gotForm string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_ = r.ParseForm()
		gotForm = r.PostForm.Get("Action") + "|" + r.PostForm.Get("RoleArn") + "|" + r.PostForm.Get("WebIdentityToken") + "|" + r.PostForm.Get("RoleSessionName")
		if r.Header.Get("Authorization") != "" {
			t.Error("AssumeRoleWithWebIdentity must be unsigned")
		}
		fmt.Fprintf(w, stsOK, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	}))
	defer srv.Close()

	now := time.Now()
	clock := &now
	p, src := NewChain(ProviderConfig{
		Getenv:      envMap(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": tokenFile, "AWS_ROLE_ARN": "arn:aws:iam::123456789012:role/zenith", "AWS_REGION": "ap-south-1"}),
		STSEndpoint: srv.URL, Now: func() time.Time { return *clock },
	})
	if src != "web_identity" {
		t.Fatal(src)
	}
	for i := 0; i < 3; i++ {
		c, err := p.Retrieve(context.Background())
		if err != nil || c.AccessKeyID != "ASIAWEB" || c.SessionToken != "webtoken" {
			t.Fatalf("%v %v", c, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("credentials must be cached, STS called %d times", calls.Load())
	}
	if gotForm != "AssumeRoleWithWebIdentity|arn:aws:iam::123456789012:role/zenith|the-oidc-jwt|zenith-runner" {
		t.Fatalf("form: %s", gotForm)
	}
	// 56 minutes later the credentials are within the 5-minute refresh window.
	*clock = now.Add(56 * time.Minute)
	if _, err := p.Retrieve(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("expected a refresh at expiry-5min, STS called %d times", calls.Load())
	}
}

func TestWebIdentitySTSErrorIsReportedWithoutSecrets(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "token")
	_ = os.WriteFile(tokenFile, []byte("super-secret-oidc-token"), 0o600)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		fmt.Fprint(w, `<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>`)
	}))
	defer srv.Close()
	p, _ := NewChain(ProviderConfig{Getenv: envMap(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": tokenFile, "AWS_ROLE_ARN": "arn:aws:iam::1:role/x"}), STSEndpoint: srv.URL})
	_, err := p.Retrieve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Error(), "super-secret-oidc-token") {
		t.Fatal("the web identity token must never appear in errors")
	}
}

func TestContainerCredentialsFullURI(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		fmt.Fprintf(w, `{"AccessKeyId":"ASIACONT","SecretAccessKey":"contsecret","Token":"conttoken","Expiration":"%s"}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	}))
	defer srv.Close() // 127.0.0.1: an allowed http target
	tokenFile := filepath.Join(t.TempDir(), "auth")
	_ = os.WriteFile(tokenFile, []byte("pod-identity-token\n"), 0o600)
	p, src := NewChain(ProviderConfig{Getenv: envMap(map[string]string{
		"AWS_CONTAINER_CREDENTIALS_FULL_URI": srv.URL + "/v1/credentials", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": tokenFile,
	})})
	if src != "container" {
		t.Fatal(src)
	}
	c, err := p.Retrieve(context.Background())
	if err != nil || c.AccessKeyID != "ASIACONT" {
		t.Fatalf("%v %v", c, err)
	}
	if auth != "pod-identity-token" {
		t.Fatalf("authorization token not forwarded: %q", auth)
	}
}

func TestContainerFullURIValidation(t *testing.T) {
	ok := []string{"https://creds.example.com/x", "http://127.0.0.1:8080/x", "http://localhost/x", "http://169.254.170.2/v2/credentials/abc", "http://169.254.170.23/v1/credentials", "http://[fd00:ec2::23]/v1/credentials"}
	bad := []string{"http://evil.example.com/x", "http://10.0.0.5/x", "ftp://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "://"}
	for _, u := range ok {
		if err := checkContainerURI(u); err != nil {
			t.Errorf("%s should be allowed: %v", u, err)
		}
	}
	for _, u := range bad {
		if err := checkContainerURI(u); err == nil {
			t.Errorf("%s should be rejected", u)
		}
	}
}

func TestIMDSv2(t *testing.T) {
	var sawToken atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /latest/api/token", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-aws-ec2-metadata-token-ttl-seconds") == "" {
			w.WriteHeader(400)
			return
		}
		fmt.Fprint(w, "imds-session-token")
	})
	mux.HandleFunc("GET /latest/meta-data/iam/security-credentials/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-aws-ec2-metadata-token") != "imds-session-token" {
			w.WriteHeader(401) // IMDSv1-style unauthenticated access must not be used
			return
		}
		sawToken.Store(true)
		fmt.Fprint(w, "my-instance-role\n")
	})
	mux.HandleFunc("GET /latest/meta-data/iam/security-credentials/my-instance-role", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-aws-ec2-metadata-token") != "imds-session-token" {
			w.WriteHeader(401)
			return
		}
		fmt.Fprintf(w, `{"Code":"Success","AccessKeyId":"ASIAIMDS","SecretAccessKey":"imdssecret","Token":"imdstoken","Expiration":"%s"}`, time.Now().Add(6*time.Hour).UTC().Format(time.RFC3339))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	p, src := NewChain(ProviderConfig{Getenv: envMap(nil), IMDSEndpoint: srv.URL})
	if src != "imds" {
		t.Fatal(src)
	}
	c, err := p.Retrieve(context.Background())
	if err != nil || c.AccessKeyID != "ASIAIMDS" || !sawToken.Load() {
		t.Fatalf("%v %v", c, err)
	}
}

func TestCachedKeepsValidCredentialsWhenRefreshFails(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	n := 0
	inner := funcProvider(func() (Credentials, error) {
		n++
		if n == 1 {
			return Credentials{AccessKeyID: "A", SecretAccessKey: "B", Expires: now.Add(10 * time.Minute)}, nil
		}
		return Credentials{}, fmt.Errorf("sts unavailable")
	})
	c := NewCached(inner, func() time.Time { return now })
	if _, err := c.Retrieve(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = now.Add(6 * time.Minute) // inside the refresh window, but still valid
	got, err := c.Retrieve(context.Background())
	if err != nil || got.AccessKeyID != "A" {
		t.Fatalf("still-valid credentials must be served when refresh fails: %v %v", got, err)
	}
	now = now.Add(10 * time.Minute) // expired
	if _, err := c.Retrieve(context.Background()); err == nil {
		t.Fatal("expired credentials must not be served")
	}
}

type funcProvider func() (Credentials, error)

func (f funcProvider) Retrieve(context.Context) (Credentials, error) { return f() }
