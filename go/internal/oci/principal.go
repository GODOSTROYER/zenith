package oci

import (
	"context"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	InstancePrincipal   = "instance_principal"
	ResourcePrincipal   = "resource_principal"
	OKEWorkloadIdentity = "oke_workload_identity"
)

var ErrPrincipal = errors.New("OCI principal is unavailable, expired, malformed or does not match local tenancy and region")

// Principal is an immutable in-memory key/token pair, exposed only inside a
// provider callback. Never serialize it, include it in errors or persist it.
type Principal struct {
	Key     *rsa.PrivateKey
	KeyID   string
	Tenancy string
	Region  string
	Expires time.Time
}

func (Principal) String() string { return "[OCI principal redacted]" }

type Provider interface {
	WithPrincipal(context.Context, func(Principal) error) error
}

type PrincipalConfig struct{ Auth, Region, Tenancy string }

// PrincipalDeps is for fakes only. Endpoints are fixed in production and never
// supplied by jobs. A fake client can route them to a local TLS/HTTP test server.
type PrincipalDeps struct {
	Getenv   func(string) string
	ReadFile func(string) ([]byte, error)
	Client   *http.Client
	Now      func() time.Time
}

type principalProvider struct {
	cfg    PrincipalConfig
	deps   PrincipalDeps
	mu     sync.Mutex
	cached Principal
}

func NewProvider(cfg PrincipalConfig, deps PrincipalDeps) (Provider, error) {
	if !RegionID(cfg.Region) || !OCID(cfg.Tenancy) || !strings.HasPrefix(cfg.Tenancy, "ocid1.tenancy.") {
		return nil, ErrPrincipal
	}
	switch cfg.Auth {
	case InstancePrincipal, ResourcePrincipal, OKEWorkloadIdentity:
	default:
		return nil, ErrPrincipal
	}
	if deps.Getenv == nil {
		deps.Getenv = os.Getenv
	}
	if deps.ReadFile == nil {
		deps.ReadFile = boundedFile
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Client != nil {
		deps.Client = noRedirects(deps.Client)
	}
	return &principalProvider{cfg: cfg, deps: deps}, nil
}

func boundedFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, ErrPrincipal
	}
	defer f.Close()
	return boundedRead(f)
}
func boundedRead(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, ErrPrincipal
	}
	return data, nil
}
func noRedirects(client *http.Client) *http.Client {
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}

func (p *principalProvider) WithPrincipal(ctx context.Context, use func(Principal) error) error {
	if ctx.Err() != nil {
		return ErrPrincipal
	}
	p.mu.Lock()
	principal := p.cached
	var err error
	if p.cfg.Auth == ResourcePrincipal { // Re-read platform-managed files on every use for rotation.
		principal, err = p.resource()
	} else if principal.Key == nil || !p.deps.Now().Add(time.Minute).Before(principal.Expires) {
		switch p.cfg.Auth {
		case InstancePrincipal:
			principal, err = p.instance(ctx)
		case OKEWorkloadIdentity:
			principal, err = p.oke(ctx)
		}
		if err == nil && principal.Tenancy == p.cfg.Tenancy && principal.Region == p.cfg.Region {
			p.cached = principal
		}
	}
	p.mu.Unlock()
	if err != nil || principal.Key == nil || principal.Tenancy != p.cfg.Tenancy || principal.Region != p.cfg.Region || !p.deps.Now().Add(time.Minute).Before(principal.Expires) || ctx.Err() != nil {
		return ErrPrincipal
	}
	return use(principal)
}

// Tokens come from trusted local platform material or verified TLS endpoints.
// Claims are decoded for binding/expiry, not advertised as signature verification;
// OCI verifies the security token on the signed service request.
func tokenPrincipal(token string, key *rsa.PrivateKey, region, tenancyClaim string) (Principal, error) {
	token = strings.TrimSpace(token)
	if len(token) > 32000 {
		return Principal{}, ErrPrincipal
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
		return Principal{}, ErrPrincipal
	}
	for _, part := range parts {
		if _, err := base64.RawURLEncoding.Strict().DecodeString(part); err != nil {
			return Principal{}, ErrPrincipal
		}
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	value, err := DecodeJSON(raw)
	obj, ok := value.(map[string]any)
	if err != nil || !ok {
		return Principal{}, ErrPrincipal
	}
	exp, ok := obj["exp"].(json.Number)
	if !ok {
		return Principal{}, ErrPrincipal
	}
	seconds, err := exp.Int64()
	if err != nil || seconds <= 0 {
		return Principal{}, ErrPrincipal
	}
	tenancy, _ := obj[tenancyClaim].(string)
	if !OCID(tenancy) || !strings.HasPrefix(tenancy, "ocid1.tenancy.") {
		return Principal{}, ErrPrincipal
	}
	if tenancyClaim == "tenant" {
		if advertised, exists := obj["opc-tenant"]; exists && advertised != tenancy {
			return Principal{}, ErrPrincipal
		}
	}
	return Principal{Key: key, KeyID: "ST$" + token, Region: region, Tenancy: tenancy, Expires: time.Unix(seconds, 0)}, nil
}

func privateKey(data []byte, password []byte) (*rsa.PrivateKey, error) {
	block, rest := pem.Decode(data)
	if block == nil || len(strings.TrimSpace(string(rest))) != 0 {
		return nil, ErrPrincipal
	}
	der := block.Bytes
	if x509.IsEncryptedPEMBlock(block) {
		var err error
		der, err = x509.DecryptPEMBlock(block, password)
		if err != nil {
			return nil, ErrPrincipal
		}
		defer clear(der)
	}
	if key, err := x509.ParsePKCS1PrivateKey(der); err == nil {
		if key.N.BitLen() >= 2048 {
			return key, nil
		}
		return nil, ErrPrincipal
	}
	value, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, ErrPrincipal
	}
	key, ok := value.(*rsa.PrivateKey)
	if !ok || key.N.BitLen() < 2048 {
		return nil, ErrPrincipal
	}
	return key, nil
}

func (p *principalProvider) material(value string) ([]byte, error) {
	if value == "" || len(value) > 1<<20 {
		return nil, ErrPrincipal
	}
	if filepath.IsAbs(value) {
		data, err := p.deps.ReadFile(value)
		if err != nil || len(data) > 1<<20 {
			return nil, ErrPrincipal
		}
		return data, nil
	}
	return []byte(value), nil
}

func (p *principalProvider) resource() (Principal, error) {
	env := p.deps.Getenv
	if env("OCI_RESOURCE_PRINCIPAL_VERSION") != "2.2" || env("OCI_RESOURCE_PRINCIPAL_REGION") != p.cfg.Region {
		return Principal{}, ErrPrincipal
	}
	tokenRef, keyRef := env("OCI_RESOURCE_PRINCIPAL_RPST"), env("OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM")
	if filepath.IsAbs(tokenRef) != filepath.IsAbs(keyRef) {
		return Principal{}, ErrPrincipal
	}
	token, err := p.material(tokenRef)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(token)
	keyBytes, err := p.material(keyRef)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(keyBytes)
	var password []byte
	if ref := env("OCI_RESOURCE_PRINCIPAL_PRIVATE_PEM_PASSPHRASE"); ref != "" {
		password, err = p.material(ref)
		if err != nil {
			return Principal{}, ErrPrincipal
		}
		defer clear(password)
	}
	key, err := privateKey(keyBytes, password)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	return tokenPrincipal(string(token), key, p.cfg.Region, "res_tenant")
}

func (p *principalProvider) client(roots *x509.CertPool) *http.Client {
	if p.deps.Client != nil {
		return p.deps.Client
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
		TLSHandshakeTimeout: 10 * time.Second, MaxResponseHeaderBytes: 16 << 10,
	}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func fetch(client *http.Client, request *http.Request) ([]byte, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrPrincipal
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, ErrPrincipal
	}
	return boundedRead(response.Body)
}
