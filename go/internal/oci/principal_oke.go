package oci

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/http"
	"regexp"
	"strings"
)

var kubernetesHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$`)

// oke exchanges the local service-account token for a session token at the
// cluster's TLS proxymux (port 12250). It loads the cluster CA, never disables
// certificate verification, and never accepts the endpoint from a job.
func (p *principalProvider) oke(ctx context.Context) (Principal, error) {
	env := p.deps.Getenv
	version := env("OCI_RESOURCE_PRINCIPAL_VERSION")
	if version != "1.1" && version != "2.2" || env("OCI_RESOURCE_PRINCIPAL_REGION") != p.cfg.Region {
		return Principal{}, ErrPrincipal
	}
	host := env("KUBERNETES_SERVICE_HOST")
	if !kubernetesHost.MatchString(host) && net.ParseIP(host) == nil {
		return Principal{}, ErrPrincipal
	}
	certPath := env("OCI_KUBERNETES_SERVICE_ACCOUNT_CERT_PATH")
	if certPath == "" {
		certPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
	}
	cert, err := p.deps.ReadFile(certPath)
	if err != nil || len(cert) > 1<<20 {
		return Principal{}, ErrPrincipal
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(cert) {
		return Principal{}, ErrPrincipal
	}
	token := env("OCI_KUBERNETES_SERVICE_ACCOUNT_TOKEN_STRING")
	if token == "" {
		path := env("OCI_KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH")
		if path == "" {
			path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
		}
		data, err := p.deps.ReadFile(path)
		if err != nil || len(data) > 32000 {
			return Principal{}, ErrPrincipal
		}
		token = strings.TrimSpace(string(data))
		clear(data)
	}
	if token == "" || len(token) > 32000 || strings.ContainsAny(token, " \t") || control(token) {
		return Principal{}, ErrPrincipal
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	body, _ := json.Marshal(map[string]string{"podKey": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))})
	request, err := http.NewRequestWithContext(ctx, "POST", "https://"+net.JoinHostPort(host, "12250")+"/resourcePrincipalSessionTokens", bytes.NewReader(body))
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	data, err := fetch(p.client(roots), request)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(data)
	var encoded string
	if json.Unmarshal(data, &encoded) != nil {
		return Principal{}, ErrPrincipal
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(decoded)
	var result struct{ Token string }
	if json.Unmarshal(decoded, &result) != nil || !strings.HasPrefix(result.Token, "ST$") {
		return Principal{}, ErrPrincipal
	}
	return tokenPrincipal(strings.TrimPrefix(result.Token, "ST$"), key, p.cfg.Region, "res_tenant")
}
