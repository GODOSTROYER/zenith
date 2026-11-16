package oci

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"strings"
)

// instance uses only the fixed IMDSv2 identity endpoints and the configured
// regional federation endpoint. No job can redirect this credential traffic.
func (p *principalProvider) instance(ctx context.Context) (Principal, error) {
	client := p.client(nil)
	metadata := func(path string) ([]byte, error) {
		request, err := http.NewRequestWithContext(ctx, "GET", "http://169.254.169.254/opc/v2"+path, nil)
		if err != nil {
			return nil, ErrPrincipal
		}
		request.Header.Set("Authorization", "Bearer Oracle")
		return fetch(client, request)
	}
	region, err := metadata("/instance/region")
	if err != nil || strings.TrimSpace(string(region)) != p.cfg.Region {
		return Principal{}, ErrPrincipal
	}
	certBytes, err := metadata("/identity/cert.pem")
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	keyBytes, err := metadata("/identity/key.pem")
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(keyBytes)
	intermediateBytes, err := metadata("/identity/intermediate.pem")
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	block, _ := pem.Decode(certBytes)
	if block == nil || block.Type != "CERTIFICATE" {
		return Principal{}, ErrPrincipal
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	if p.deps.Now().Before(cert.NotBefore) || !p.deps.Now().Before(cert.NotAfter) {
		return Principal{}, ErrPrincipal
	}
	tenancy := ""
	for _, name := range cert.Subject.Names {
		if value, ok := name.Value.(string); ok && strings.HasPrefix(value, "opc-tenant:") {
			tenancy = strings.TrimPrefix(value, "opc-tenant:")
		}
	}
	if tenancy != p.cfg.Tenancy {
		return Principal{}, ErrPrincipal
	}
	leafKey, err := privateKey(keyBytes, nil)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	public, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok || !public.Equal(&leafKey.PublicKey) {
		return Principal{}, ErrPrincipal
	}
	intermediate, _ := pem.Decode(intermediateBytes)
	if intermediate == nil || intermediate.Type != "CERTIFICATE" {
		return Principal{}, ErrPrincipal
	}
	if _, err := x509.ParseCertificate(intermediate.Bytes); err != nil {
		return Principal{}, ErrPrincipal
	}
	session, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&session.PublicKey)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	body, err := json.Marshal(map[string]any{
		"certificate": base64.StdEncoding.EncodeToString(cert.Raw), "publicKey": base64.StdEncoding.EncodeToString(publicDER),
		"intermediateCertificates": []string{base64.StdEncoding.EncodeToString(intermediate.Bytes)}, "fingerprintAlgorithm": "SHA256",
	})
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "https://auth."+p.cfg.Region+".oraclecloud.com/v1/x509", bytes.NewReader(body))
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	digest := sha256.Sum256(cert.Raw)
	fingerprint := strings.ReplaceAll(fmt.Sprintf("% x", digest), " ", ":")
	if signWithHeaders(request, body, tenancy+"/fed-x509-sha256/"+fingerprint, leafKey, p.deps.Now(), []string{"date", "(request-target)"}, []string{"content-length", "content-type", "x-content-sha256"}) != nil {
		return Principal{}, ErrPrincipal
	}
	response, err := fetch(client, request)
	if err != nil {
		return Principal{}, ErrPrincipal
	}
	defer clear(response)
	var result struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(response, &result) != nil {
		return Principal{}, ErrPrincipal
	}
	principal, err := tokenPrincipal(result.Token, session, p.cfg.Region, "tenant")
	if err == nil && cert.NotAfter.Before(principal.Expires) {
		principal.Expires = cert.NotAfter
	}
	return principal, err
}
