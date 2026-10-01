package kinds

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/oci"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

const ociCompartment = "ocid1.compartment.oc1..fixture"
const ociTenancy = "ocid1.tenancy.oc1..fixture"
const ociRegion = "us-ashburn-1"
const ociResource = "ocid1.containerinstance.oc1.iad.fixture"

var ociNow = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

type ociProviderFunc func(context.Context, func(oci.Principal) error) error

func (f ociProviderFunc) WithPrincipal(ctx context.Context, use func(oci.Principal) error) error {
	return f(ctx, use)
}

type ociTransportFunc func(*http.Request) (*http.Response, error)

func (f ociTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func ociTestKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	data, err := os.ReadFile("../../oci/testdata/signing-vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ PrivateKey string }
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("invalid signing fixture")
	}
	block, _ := pem.Decode([]byte(fixture.PrivateKey))
	value, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return value.(*rsa.PrivateKey)
}
func ociConfig() OCIConfig {
	return OCIConfig{Enabled: true, Auth: oci.ResourcePrincipal, Region: ociRegion, Tenancy: ociTenancy, AllowedCompartments: []string{ociCompartment}, ResourceCompartments: map[string]string{ociResource: ociCompartment}}
}
func ociReadPayload() map[string]any {
	return map[string]any{"service": "core", "region": ociRegion, "method": "GET", "path": "/20160918/subnets", "query": [][2]string{{"compartmentId", ociCompartment}}, "headers": map[string]string{}}
}
func ociJob(t *testing.T, capability string, payload any) *Request {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &Request{JTI: "job_fixture", Capability: capability, Payload: raw, MaxOutputBytes: 1 << 20}
}
func ociDeps(t *testing.T) OCIDeps {
	t.Helper()
	key := ociTestKey(t)
	return OCIDeps{Now: func() time.Time { return ociNow }, Audit: func(OCIAudit) error { return nil }, Wait: func(context.Context, time.Duration) error { return nil }, Principal: ociProviderFunc(func(_ context.Context, use func(oci.Principal) error) error {
		return use(oci.Principal{Key: key, KeyID: "ST$synthetic-test-token", Tenancy: ociTenancy, Region: ociRegion, Expires: ociNow.Add(time.Hour)})
	})}
}

func TestOCIPrepareRefusesBeforeCredentialOrNetworkAccess(t *testing.T) {
	cases := []struct {
		name, capability string
		patch            map[string]any
		config           func(*OCIConfig)
	}{
		{name: "disabled", config: func(c *OCIConfig) { c.Enabled = false }},
		{name: "secret", capability: "secret.write", patch: map[string]any{"sealedBodyB64": "synthetic-sensitive-value"}},
		{name: "unknown-capability", capability: "logs.read"},
		{name: "region", patch: map[string]any{"region": "eu-frankfurt-1"}},
		{name: "foreign-compartment", patch: map[string]any{"query": [][2]string{{"compartmentId", "ocid1.compartment.oc1..foreign"}}}},
		{name: "unscoped", patch: map[string]any{"query": [][2]string{}}},
		{name: "delete", patch: map[string]any{"method": "DELETE"}},
		{name: "wrong-capability", capability: "firewall.inspect"},
		{name: "secretbundle", patch: map[string]any{"service": "vault", "path": "/20190301/secretbundles/fixture"}},
		{name: "metadata-host", patch: map[string]any{"service": "queue-data", "endpointHost": "169.254.169.254"}},
		{name: "authorization", patch: map[string]any{"headers": map[string]string{"Authorization": "synthetic-sensitive-value"}}},
		{name: "resource-with-forged-scope", patch: map[string]any{"path": "/20160918/subnets/ocid1.subnet.oc1.iad.foreign"}},
		{name: "subtree", patch: map[string]any{"query": [][2]string{{"compartmentId", ociCompartment}, {"compartmentIdInSubtree", "true"}}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := ociConfig()
			if c.config != nil {
				c.config(&cfg)
			}
			deps := ociDeps(t)
			deps.Principal = ociProviderFunc(func(context.Context, func(oci.Principal) error) error {
				t.Fatal("credential lookup on rejected job")
				return nil
			})
			deps.Client = &http.Client{Transport: ociTransportFunc(func(*http.Request) (*http.Response, error) { t.Fatal("network call on rejected job"); return nil, nil })}
			kind, err := NewOCI(cfg, deps)
			if err != nil {
				t.Fatal(err)
			}
			payload := ociReadPayload()
			for key, value := range c.patch {
				payload[key] = value
			}
			cap := c.capability
			if cap == "" {
				cap = "infrastructure.observe"
			}
			if _, err := kind.Prepare(ociJob(t, cap, payload)); err == nil || strings.Contains(err.Error(), "synthetic-sensitive-value") {
				t.Fatal("expected safe rejection")
			}
		})
	}
}

func verifyOCISignature(t *testing.T, r *http.Request, key *rsa.PublicKey) {
	t.Helper()
	auth := r.Header.Get("Authorization")
	signatureMatch := regexp.MustCompile(`signature="([^"]+)"`).FindStringSubmatch(auth)
	headersMatch := regexp.MustCompile(`headers="([^"]+)"`).FindStringSubmatch(auth)
	if len(signatureMatch) != 2 || len(headersMatch) != 2 {
		t.Fatal("missing signature")
	}
	var lines []string
	for _, name := range strings.Split(headersMatch[1], " ") {
		value := r.Header.Get(name)
		switch name {
		case "(request-target)":
			value = strings.ToLower(r.Method) + " " + r.URL.RequestURI()
		case "host":
			value = r.Host
		case "content-length":
			value = r.Header.Get(name)
			if value == "" {
				value = jsonNumber(r.ContentLength)
			}
		}
		lines = append(lines, name+": "+value)
	}
	digest := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	signature, err := base64.StdEncoding.DecodeString(signatureMatch[1])
	if err != nil || rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) != nil {
		t.Fatal("invalid outbound signature")
	}
}
func jsonNumber(value int64) string { data, _ := json.Marshal(value); return string(data) }

// routeOCIClient is a test-only socket destination rewrite. The request keeps
// its signed OCI Host and its exact path/query. No production override exists.
func routeOCIClient(server *httptest.Server) *http.Client {
	endpoint, _ := url.Parse(server.URL)
	client := server.Client()
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &http.Client{Transport: ociTransportFunc(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		target := *r.URL
		target.Scheme, target.Host = endpoint.Scheme, endpoint.Host
		clone.URL = &target
		clone.Host = r.URL.Host
		return transport.RoundTrip(clone)
	})}
}

func TestOCIHTTPEndpointSignsExactQueryAndBoundsOutput(t *testing.T) {
	key := ociTestKey(t)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Host != "iaas.us-ashburn-1.oraclecloud.com" || r.URL.RawQuery != "a=a%20b&a=%2B&compartmentId="+ociCompartment {
			t.Error("signed target changed")
		}
		verifyOCISignature(t, r, &key.PublicKey)
		w.Header().Set("opc-request-id", "oci-test-request")
		w.Header().Set("opc-next-page", "next")
		w.Header().Set("Set-Cookie", "synthetic-sensitive-value")
		w.Header().Set("Authorization", "synthetic-sensitive-value")
		w.Header().Set("etag", strings.Repeat("e", 2100))
		w.WriteHeader(404)
		_, _ = io.WriteString(w, `{"code":"NotAuthorizedOrNotFound"}`)
	}))
	defer server.Close()
	var audit OCIAudit
	deps := ociDeps(t)
	deps.Client = routeOCIClient(server)
	deps.Audit = func(record OCIAudit) error { audit = record; return nil }
	kind, err := NewOCI(ociConfig(), deps)
	if err != nil {
		t.Fatal(err)
	}
	payload := ociReadPayload()
	payload["query"] = [][2]string{{"a", "a b"}, {"a", "+"}, {"compartmentId", ociCompartment}}
	job := ociJob(t, "infrastructure.observe", payload)
	job.MaxOutputBytes = 12
	run, err := kind.Prepare(job)
	if err != nil {
		t.Fatal(err)
	}
	out := run(context.Background(), agent.DiscardSink{})
	if out.Status != agent.StatusSucceeded {
		t.Fatal(out)
	}
	result := out.Result.(map[string]any)
	headers := result["headers"].(map[string]string)
	body, _ := base64.StdEncoding.DecodeString(result["bodyB64"].(string))
	if requests != 1 || result["status"] != 404 || result["truncated"] != true || len(body) != 12 || headers["authorization"] != "" || headers["set-cookie"] != "" || len(headers["etag"]) != 2000 {
		t.Fatal("wrong bounded response")
	}
	if audit.PathTemplate != "/20160918/subnets" || audit.Status != 404 || audit.RequestID != "oci-test-request" || audit.Sealed || audit.JobID != "job_fixture" {
		t.Fatal("incorrect audit record")
	}
}

func TestOCIReadRetriesAndNeverRetriesWrites(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		t.Run(method, func(t *testing.T) {
			calls, waits, audits := 0, 0, 0
			deps := ociDeps(t)
			deps.Audit = func(OCIAudit) error { audits++; return nil }
			deps.Client = &http.Client{Transport: ociTransportFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 503, Header: http.Header{"Retry-After": []string{"2"}}, Body: io.NopCloser(strings.NewReader(`{"code":"Unavailable"}`))}, nil
			})}
			deps.Wait = func(_ context.Context, delay time.Duration) error {
				waits++
				if delay != 2*time.Second {
					t.Fatal("Retry-After ignored")
				}
				return nil
			}
			kind, err := NewOCI(ociConfig(), deps)
			if err != nil {
				t.Fatal(err)
			}
			payload := ociReadPayload()
			cap := "infrastructure.observe"
			if method == "POST" {
				cap = "service.restart"
				payload["service"] = "containerinstances"
				payload["method"] = "POST"
				payload["path"] = "/20210415/containerInstances/" + ociResource + "/actions/restart"
				payload["query"] = [][2]string{}
				payload["headers"] = map[string]string{"opc-retry-token": "fixture-idempotency"}
			}
			run, err := kind.Prepare(ociJob(t, cap, payload))
			if err != nil {
				t.Fatal(err)
			}
			out := run(context.Background(), agent.DiscardSink{})
			if out.Status != agent.StatusSucceeded || out.Result.(map[string]any)["status"] != 503 {
				t.Fatal("OCI error was not an HTTP outcome")
			}
			if method == "GET" && (calls != 4 || waits != 3) || method == "POST" && (calls != 1 || waits != 0) || audits != calls {
				t.Fatal("incorrect retry policy")
			}
		})
	}
}

// The shared v1 verifier is the first gate. This is an offline protocol test;
// production executor construction still requires the integration patch in §10.
func TestOCIV1EnvelopeClaimsAndReplayBeforePrepare(t *testing.T) {
	cp := protocoltest.New("oci-test-control-plane")
	cp.Now = func() time.Time { return ociNow }
	self := protocol.Self{ID: "run_oci", WorkspaceID: "ws_oci"}
	verifier := &protocol.Verifier{Keys: cp.KeySet(), Now: cp.Now, Replay: protocol.NewMemoryReplayCache(cp.Now)}
	base := protocoltest.JobSpec{RunnerID: self.ID, WorkspaceID: self.WorkspaceID, Capability: "infrastructure.observe", Kind: KindOCIHTTP, Payload: ociReadPayload()}
	for name, mutate := range map[string]func(*protocoltest.JobSpec){
		"runner":           func(s *protocoltest.JobSpec) { s.RunnerID = "run_foreign" },
		"workspace":        func(s *protocoltest.JobSpec) { s.WorkspaceID = "ws_foreign" },
		"grant-capability": func(s *protocoltest.JobSpec) { s.GrantCap = "service.restart" },
		"grant-runner":     func(s *protocoltest.JobSpec) { s.GrantAud = "runner:run_foreign" },
		"expired":          func(s *protocoltest.JobSpec) { s.EXP = ociNow.Add(-time.Minute) },
		"future":           func(s *protocoltest.JobSpec) { s.IAT = ociNow.Add(time.Hour) },
		"no-grant":         func(s *protocoltest.JobSpec) { s.OmitGrant = true },
	} {
		t.Run(name, func(t *testing.T) {
			spec := base
			mutate(&spec)
			_, token := cp.Job(spec)
			if _, err := verifier.VerifyJob(token, self, nil); err == nil {
				t.Fatal("unverified OCI envelope accepted")
			}
		})
	}
	_, token := cp.Job(base)
	parts := strings.Split(token, ".")
	replacement := "A"
	if parts[2][0] == 'A' {
		replacement = "B"
	}
	parts[2] = replacement + parts[2][1:]
	if _, err := verifier.VerifyJob(strings.Join(parts, "."), self, nil); err == nil {
		t.Fatal("tampered signature accepted")
	}
	verified, err := verifier.VerifyJob(token, self, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.VerifyJob(token, self, nil); err == nil {
		t.Fatal("OCI job replay accepted")
	}
	kind, err := NewOCI(ociConfig(), ociDeps(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := kind.Prepare(&Request{JTI: verified.Envelope.JTI, Capability: verified.Envelope.Capability, Payload: verified.Envelope.Payload}); err != nil {
		t.Fatal(err)
	}
}

func TestOCIPostSignsEmptyBodyAndRequiresIdempotency(t *testing.T) {
	key := ociTestKey(t)
	deps := ociDeps(t)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		verifyOCISignature(t, r, &key.PublicKey)
		if r.ContentLength != 0 || r.Header.Get("X-Content-Sha256") == "" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("empty POST omitted signed body headers")
		}
		w.WriteHeader(202)
	}))
	defer server.Close()
	deps.Client = routeOCIClient(server)
	kind, err := NewOCI(ociConfig(), deps)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"service": "containerinstances", "region": ociRegion, "method": "POST", "path": "/20210415/containerInstances/" + ociResource + "/actions/restart", "query": [][2]string{}, "headers": map[string]string{}}
	if _, err := kind.Prepare(ociJob(t, "service.restart", payload)); err == nil {
		t.Fatal("write accepted without idempotency token")
	}
	payload["headers"] = map[string]string{"Opc-Retry-Token": "test"}
	run, err := kind.Prepare(ociJob(t, "service.restart", payload))
	if err != nil {
		t.Fatal(err)
	}
	if out := run(context.Background(), agent.DiscardSink{}); out.Status != agent.StatusSucceeded || calls != 1 {
		t.Fatal(out)
	}
}

func TestOCIRefusesRedirectsAndSanitizesFailures(t *testing.T) {
	redirectCalls := 0
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirectCalls++ }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer server.Close()
	deps := ociDeps(t)
	deps.Client = routeOCIClient(server)
	kind, err := NewOCI(ociConfig(), deps)
	if err != nil {
		t.Fatal(err)
	}
	run, err := kind.Prepare(ociJob(t, "infrastructure.observe", ociReadPayload()))
	if err != nil {
		t.Fatal(err)
	}
	if out := run(context.Background(), agent.DiscardSink{}); out.Status != agent.StatusSucceeded || out.Result.(map[string]any)["status"] != 302 || redirectCalls != 0 {
		t.Fatal("followed redirect")
	}
	for _, stage := range []string{"principal", "transport", "read", "audit"} {
		t.Run(stage, func(t *testing.T) {
			deps := ociDeps(t)
			deps.Client = &http.Client{Transport: ociTransportFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
			})}
			switch stage {
			case "principal":
				deps.Principal = ociProviderFunc(func(context.Context, func(oci.Principal) error) error { return errors.New("synthetic-sensitive-value") })
			case "transport":
				deps.Client.Transport = ociTransportFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic-sensitive-value") })
			case "read":
				deps.Client.Transport = ociTransportFunc(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(ociErrorReader{})}, nil
				})
			case "audit":
				deps.Audit = func(OCIAudit) error { return errors.New("synthetic-sensitive-value") }
			}
			kind, err := NewOCI(ociConfig(), deps)
			if err != nil {
				t.Fatal(err)
			}
			run, err := kind.Prepare(ociJob(t, "infrastructure.observe", ociReadPayload()))
			if err != nil {
				t.Fatal(err)
			}
			out := run(context.Background(), agent.DiscardSink{})
			if out.Status != agent.StatusFailed || strings.Contains(out.Error, "synthetic-sensitive-value") {
				t.Fatal("failure leaked external error")
			}
		})
	}
}

type ociErrorReader struct{}

func (ociErrorReader) Read([]byte) (int, error) { return 0, errors.New("synthetic-sensitive-value") }

func TestOCITimeoutBackoffAndAuditJSONL(t *testing.T) {
	now := ociNow
	if delay := ociRetryDelay(now.Add(3*time.Second).Format(http.TimeFormat), 0, now); delay != 3*time.Second {
		t.Fatal("HTTP-date Retry-After ignored")
	}
	delay := ociRetryDelay("invalid", 2, now)
	if delay < 800*time.Millisecond || delay >= time.Second {
		t.Fatal("invalid jittered backoff")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := ociWait(ctx, time.Hour); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("backoff ignored deadline")
	}
	deps := ociDeps(t)
	kind, err := NewOCI(ociConfig(), deps)
	if err != nil {
		t.Fatal(err)
	}
	run, err := kind.Prepare(ociJob(t, "infrastructure.observe", ociReadPayload()))
	if err != nil {
		t.Fatal(err)
	}
	<-ctx.Done()
	if out := run(ctx, agent.DiscardSink{}); out.Status != agent.StatusTimedOut {
		t.Fatal("deadline not classified")
	}
	path := t.TempDir() + "/audit.jsonl"
	write := newOCIAudit(path)
	record := OCIAudit{JobID: "job_fixture", PathTemplate: "/20160918/subnets/{}", RequestID: "request\nnewline"}
	if err := write(record); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), "\n") != 1 || strings.Contains(string(data), "bodyB64") || strings.Contains(string(data), ociResource) {
		t.Fatal("audit is not one safe structured line")
	}
}

func TestOCIResponseHeadersRedactCredentialShapes(t *testing.T) {
	header := http.Header{"Opc-Request-Id": []string{"Bearer synthetic_sensitive_credential"}, "Opc-Next-Page": []string{"page"}, "X-Unknown": []string{"secret"}}
	filtered := ociResponseHeaders(header)
	if strings.Contains(filtered["opc-request-id"], "synthetic_sensitive_credential") || filtered["opc-next-page"] != "page" || len(filtered) != 2 {
		t.Fatal("response headers leaked credential-shaped data or retained an unknown header")
	}
}

func TestOCIConfigAndLocalPolicySnapshot(t *testing.T) {
	cfg := ociConfig()
	deps := ociDeps(t)
	kind, err := NewOCI(cfg, deps)
	if err != nil {
		t.Fatal(err)
	}
	cfg.AllowedCompartments[0] = "ocid1.compartment.oc1..foreign"
	cfg.ResourceCompartments[ociResource] = "ocid1.compartment.oc1..foreign"
	if _, err := kind.Prepare(ociJob(t, "infrastructure.observe", ociReadPayload())); err != nil {
		t.Fatal("caller mutated local allowlist")
	}
	for _, change := range []func(*OCIConfig){func(c *OCIConfig) { c.SecretWrite = true }, func(c *OCIConfig) { c.AllowedCompartments = nil }, func(c *OCIConfig) { c.Auth = "user_principal" }, func(c *OCIConfig) { c.MaxRequestBytes = (1 << 20) + 1 }, func(c *OCIConfig) { c.AllowedRegions = []string{"../metadata"} }, func(c *OCIConfig) { c.ResourceCompartments[ociResource] = "ocid1.compartment.oc1..foreign" }} {
		cfg := ociConfig()
		change(&cfg)
		if _, err := NewOCI(cfg, ociDeps(t)); err == nil {
			t.Fatal("unsafe local configuration accepted")
		}
	}
	cfg = ociConfig()
	cfg.AuditPath = ""
	deps = ociDeps(t)
	deps.Audit = nil
	if _, err := NewOCI(cfg, deps); err == nil {
		t.Fatal("enabled without local audit destination")
	}
}
