package oci

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testTenancy = "ocid1.tenancy.oc1..fixture"
const testRegion = "us-ashburn-1"

var testTime = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

type principalTransport func(*http.Request) (*http.Response, error)

func (f principalTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func fakeResponse(data []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}
}
func fakeToken(now time.Time, tenancy string) string {
	return fakeTokenWithClaims(now, map[string]any{"res_tenant": tenancy})
}
func fakeTokenWithClaims(now time.Time, claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	claims["exp"] = now.Add(10 * time.Minute).Unix()
	data, _ := json.Marshal(claims)
	return header + "." + base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString([]byte("synthetic-signature-not-an-OCI-credential"))
}
func certFixture(t *testing.T, key *rsa.PrivateKey, tenancy string) []byte {
	t.Helper()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "opc-tenant:" + tenancy}, NotBefore: testTime.Add(-time.Hour), NotAfter: testTime.Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	data, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: data})
}
func basePrincipalConfig(auth string) PrincipalConfig {
	return PrincipalConfig{Auth: auth, Region: testRegion, Tenancy: testTenancy}
}

func TestResourcePrincipalInlineAndRotation(t *testing.T) {
	v, _ := vector(t)
	now := testTime
	env := map[string]string{"OCI_RESOURCE_PRINCIPAL_VERSION": "2.2", "OCI_RESOURCE_PRINCIPAL_REGION": testRegion, "OCI_RESOURCE_PRINCIPAL_RPST": fakeToken(now, testTenancy), "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM": v.PrivateKey}
	provider, err := NewProvider(basePrincipalConfig(ResourcePrincipal), PrincipalDeps{Getenv: func(name string) string { return env[name] }, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	called := false
	err = provider.WithPrincipal(context.Background(), func(p Principal) error {
		called = true
		if p.Tenancy != testTenancy || !strings.HasPrefix(p.KeyID, "ST$") || p.Key == nil {
			t.Fatal("invalid principal")
		}
		return nil
	})
	if err != nil || !called {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Minute)
	if provider.WithPrincipal(context.Background(), func(Principal) error { t.Fatal("expired credentials exposed"); return nil }) == nil {
		t.Fatal("expired token accepted")
	}
	env["OCI_RESOURCE_PRINCIPAL_RPST"] = fakeToken(now, testTenancy)
	if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != nil {
		t.Fatal("rotated token was not reloaded")
	}
}

func TestResourcePrincipalFilesAndRefusals(t *testing.T) {
	v, _ := vector(t)
	tokenPath := filepath.Join(t.TempDir(), "rpst")
	keyPath := filepath.Join(t.TempDir(), "key.pem")
	env := map[string]string{"OCI_RESOURCE_PRINCIPAL_VERSION": "2.2", "OCI_RESOURCE_PRINCIPAL_REGION": testRegion, "OCI_RESOURCE_PRINCIPAL_RPST": tokenPath, "OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM": keyPath}
	files := map[string]string{tokenPath: fakeToken(testTime, testTenancy), keyPath: v.PrivateKey}
	provider, err := NewProvider(basePrincipalConfig(ResourcePrincipal), PrincipalDeps{Getenv: func(name string) string { return env[name] }, ReadFile: func(path string) ([]byte, error) {
		if data, ok := files[path]; ok {
			return []byte(data), nil
		}
		return nil, errors.New("synthetic-sensitive-path")
	}, Now: func() time.Time { return testTime }})
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct{ name, value string }{
		{"OCI_RESOURCE_PRINCIPAL_VERSION", "1.1"}, {"OCI_RESOURCE_PRINCIPAL_REGION", "eu-frankfurt-1"},
		{"OCI_RESOURCE_PRINCIPAL_RPST", fakeToken(testTime, testTenancy)}, {"OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM", "synthetic-sensitive-key"},
	} {
		t.Run(change.name+change.value[:min(5, len(change.value))], func(t *testing.T) {
			old := env[change.name]
			env[change.name] = change.value
			defer func() { env[change.name] = old }()
			err := provider.WithPrincipal(context.Background(), func(Principal) error { t.Fatal("invalid principal exposed"); return nil })
			if err != ErrPrincipal {
				t.Fatal("error must not contain source material")
			}
		})
	}
	files[tokenPath] = fakeToken(testTime, "ocid1.tenancy.oc1..foreign")
	if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != ErrPrincipal {
		t.Fatal("foreign tenancy accepted")
	}
	files[tokenPath] = "synthetic-sensitive-malformed-token"
	if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != ErrPrincipal {
		t.Fatal("malformed token accepted or leaked")
	}
}

func TestInstancePrincipalFederationCacheAndRefresh(t *testing.T) {
	v, key := vector(t)
	cert := certFixture(t, key, testTenancy)
	now := testTime
	federationCalls := 0
	client := &http.Client{Transport: principalTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "169.254.169.254" {
			if r.Header.Get("Authorization") != "Bearer Oracle" {
				t.Fatal("missing IMDSv2 auth")
			}
			switch r.URL.Path {
			case "/opc/v2/instance/region":
				return fakeResponse([]byte(testRegion)), nil
			case "/opc/v2/identity/cert.pem", "/opc/v2/identity/intermediate.pem":
				return fakeResponse(cert), nil
			case "/opc/v2/identity/key.pem":
				return fakeResponse([]byte(v.PrivateKey)), nil
			}
			t.Fatal("unrecognized metadata endpoint")
		}
		if r.URL.String() != "https://auth.us-ashburn-1.oraclecloud.com/v1/x509" {
			t.Fatal("unexpected federation endpoint")
		}
		federationCalls++
		if !strings.Contains(r.Header.Get("Authorization"), testTenancy+"/fed-x509-sha256/") {
			t.Fatal("wrong federation key ID")
		}
		if !strings.Contains(r.Header.Get("Authorization"), `headers="date (request-target) content-length content-type x-content-sha256"`) {
			t.Fatal("federation signing headers differ from the OCI reference")
		}
		var details map[string]any
		wireBody, err := io.ReadAll(r.Body)
		if err != nil || json.Unmarshal(wireBody, &details) != nil {
			t.Fatal("invalid federation body")
		}
		bodyDigest := sha256.Sum256(wireBody)
		canonical := "date: " + r.Header.Get("Date") + "\n(request-target): post /v1/x509\ncontent-length: " + r.Header.Get("Content-Length") + "\ncontent-type: application/json\nx-content-sha256: " + base64.StdEncoding.EncodeToString(bodyDigest[:])
		canonicalDigest := sha256.Sum256([]byte(canonical))
		authorization := r.Header.Get("Authorization")
		signatureParts := strings.Split(authorization, `signature="`)
		if len(signatureParts) != 2 {
			t.Fatal("federation signature absent")
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(signatureParts[1], `"`))
		if err != nil || rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, canonicalDigest[:], signature) != nil {
			t.Fatal("federation signature invalid")
		}
		if details["fingerprintAlgorithm"] != "SHA256" || details["certificate"] == "" || details["publicKey"] == "" {
			t.Fatal("missing federation fields")
		}
		data, _ := json.Marshal(map[string]string{"token": fakeTokenWithClaims(now, map[string]any{"tenant": testTenancy, "opc-tenant": testTenancy})})
		return fakeResponse(data), nil
	})}
	provider, err := NewProvider(basePrincipalConfig(InstancePrincipal), PrincipalDeps{Client: client, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	var keys []*rsa.PrivateKey
	use := func(p Principal) error {
		if p.Key == key {
			t.Fatal("leaf key used for service request")
		}
		keys = append(keys, p.Key)
		return nil
	}
	if err := provider.WithPrincipal(context.Background(), use); err != nil {
		t.Fatal(err)
	}
	if err := provider.WithPrincipal(context.Background(), use); err != nil {
		t.Fatal(err)
	}
	if federationCalls != 1 || keys[0] != keys[1] {
		t.Fatal("token/key cache is not atomic")
	}
	now = now.Add(9*time.Minute + time.Second)
	if err := provider.WithPrincipal(context.Background(), use); err != nil {
		t.Fatal(err)
	}
	if federationCalls != 2 || keys[0] == keys[2] {
		t.Fatal("session key/token not refreshed together")
	}
}

func TestPrincipalTenancyClaimFormats(t *testing.T) {
	_, key := vector(t)
	for _, claim := range []string{"tenant", "res_tenant"} {
		token := fakeTokenWithClaims(testTime, map[string]any{claim: testTenancy})
		if p, err := tokenPrincipal(token, key, testRegion, claim); err != nil || p.Tenancy != testTenancy {
			t.Fatal("valid tenancy claim refused")
		}
	}
	for _, claims := range []map[string]any{
		{"res_tenant": testTenancy},
		{"tenant": testTenancy, "opc-tenant": "ocid1.tenancy.oc1..foreign"},
		{"tenant": testTenancy, "opc-tenant": nil},
	} {
		if _, err := tokenPrincipal(fakeTokenWithClaims(testTime, claims), key, testRegion, "tenant"); err == nil {
			t.Fatal("missing/conflicting instance tenancy claim accepted")
		}
	}
}

func TestInstanceAndOKEFailuresDoNotExposeProviderErrors(t *testing.T) {
	for _, auth := range []string{InstancePrincipal, OKEWorkloadIdentity} {
		t.Run(auth, func(t *testing.T) {
			provider, err := NewProvider(basePrincipalConfig(auth), PrincipalDeps{Getenv: func(string) string { return "synthetic-sensitive-value" }, ReadFile: func(string) ([]byte, error) { return nil, errors.New("synthetic-sensitive-value") }, Client: &http.Client{Transport: principalTransport(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic-sensitive-value") })}, Now: func() time.Time { return testTime }})
			if err != nil {
				t.Fatal(err)
			}
			if err := provider.WithPrincipal(context.Background(), func(Principal) error { t.Fatal("failed credentials exposed"); return nil }); err != ErrPrincipal {
				t.Fatal("provider error was exposed")
			}
		})
	}
}

func TestOKEWorkloadExchangeAndTLSConfiguration(t *testing.T) {
	_, key := vector(t)
	cert := certFixture(t, key, testTenancy)
	env := map[string]string{"OCI_RESOURCE_PRINCIPAL_VERSION": "2.2", "OCI_RESOURCE_PRINCIPAL_REGION": testRegion, "KUBERNETES_SERVICE_HOST": "10.0.0.1", "OCI_KUBERNETES_SERVICE_ACCOUNT_TOKEN_STRING": "synthetic-service-account-token"}
	var podKey string
	client := &http.Client{Transport: principalTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://10.0.0.1:12250/resourcePrincipalSessionTokens" || r.Header.Get("Authorization") != "Bearer synthetic-service-account-token" {
			t.Fatal("wrong proxymux endpoint/auth")
		}
		var request struct{ PodKey string }
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Fatal("invalid pod key payload")
		}
		podKey = request.PodKey
		data, _ := json.Marshal(map[string]string{"token": "ST$" + fakeToken(testTime, testTenancy)})
		encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString(data))
		return fakeResponse(encoded), nil
	})}
	provider, err := NewProvider(basePrincipalConfig(OKEWorkloadIdentity), PrincipalDeps{Getenv: func(name string) string { return env[name] }, ReadFile: func(string) ([]byte, error) { return append([]byte(nil), cert...), nil }, Client: client, Now: func() time.Time { return testTime }})
	if err != nil {
		t.Fatal(err)
	}
	if err := provider.WithPrincipal(context.Background(), func(p Principal) error {
		block, _ := pem.Decode([]byte(podKey))
		if block == nil {
			t.Fatal("pod public key absent")
		}
		public, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil || !public.(*rsa.PublicKey).Equal(&p.Key.PublicKey) {
			t.Fatal("workload token and key mismatch")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	native := provider.(*principalProvider)
	native.deps.Client = nil
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(cert)
	tls := native.client(roots).Transport.(*http.Transport).TLSClientConfig
	if tls.InsecureSkipVerify || tls.RootCAs != roots || tls.MinVersion == 0 {
		t.Fatal("TLS verification was not enforced")
	}
	env["KUBERNETES_SERVICE_HOST"] = "attacker.com/path"
	native.cached = Principal{}
	if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != ErrPrincipal {
		t.Fatal("invalid cluster endpoint allowed")
	}
}

func TestConcurrentPrincipalCacheAndCancellation(t *testing.T) {
	_, key := vector(t)
	now := testTime
	provider := &principalProvider{cfg: basePrincipalConfig(InstancePrincipal), deps: PrincipalDeps{Now: func() time.Time { return now }}, cached: Principal{Key: key, KeyID: "ST$synthetic", Tenancy: testTenancy, Region: testRegion, Expires: now.Add(time.Hour)}}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := provider.WithPrincipal(context.Background(), func(Principal) error { return nil }); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := provider.WithPrincipal(ctx, func(Principal) error { t.Fatal("cancelled callback invoked"); return nil }); err != ErrPrincipal {
		t.Fatal("cancellation ignored")
	}
}
