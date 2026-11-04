package kinds

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// In-cluster service account locations.
const (
	defaultSATokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	defaultSACAFile    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

// K8sConfig configures the k8s.http proxy.
type K8sConfig struct {
	Toggle
	// Allow maps a capability to "METHOD /path/pattern" entries. In a pattern
	// a segment * matches exactly one path segment and a final ** matches any
	// remainder. Default is deny.
	Allow map[string][]string `json:"allow"`
	// AllowSecrets lifts the built-in refusal of paths under the "secrets"
	// resource. Off by default: a runner that can read Secrets can read every
	// credential in the namespace.
	AllowSecrets bool `json:"allowSecrets"`
	// APIServer defaults to https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT.
	APIServer string `json:"apiServer"`
	// TokenFile and CAFile default to the in-cluster service account paths.
	// The token is re-read for every request (projected tokens rotate).
	TokenFile        string `json:"tokenFile"`
	CAFile           string `json:"caFile"`
	MaxRequestBytes  int64  `json:"maxRequestBytes"`
	MaxResponseBytes int64  `json:"maxResponseBytes"`
}

// K8s is the k8s.http kind.
type K8s struct {
	cfg    K8sConfig
	allow  Allowlist
	server *url.URL
	client *http.Client
}

// NewK8s builds the kind. getenv may be nil (os.Getenv).
func NewK8s(cfg K8sConfig, getenv func(string) string) (*K8s, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	entries := map[string][]string{}
	for cap, es := range cfg.Allow {
		for _, e := range es {
			entries[cap] = append(entries[cap], "k8s:"+strings.TrimSpace(e))
		}
	}
	al, err := ParseAllowlist(entries)
	if err != nil {
		return nil, fmt.Errorf("k8s.http allow: %w", err)
	}
	for cap, rules := range al {
		for _, r := range rules {
			if !r.REST {
				return nil, fmt.Errorf("k8s.http allow: capability %q entries must look like \"METHOD /path\"", cap)
			}
		}
	}
	if cfg.TokenFile == "" {
		cfg.TokenFile = defaultSATokenFile
	}
	if cfg.CAFile == "" {
		cfg.CAFile = defaultSACAFile
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 4 << 20
	}
	if cfg.MaxResponseBytes <= 0 {
		cfg.MaxResponseBytes = 8 << 20
	}
	api := cfg.APIServer
	if api == "" {
		host, port := getenv("KUBERNETES_SERVICE_HOST"), getenv("KUBERNETES_SERVICE_PORT")
		if host == "" {
			return nil, errors.New("k8s.http: apiServer is not configured and KUBERNETES_SERVICE_HOST is unset (not running in a cluster?)")
		}
		if port == "" {
			port = "443"
		}
		api = "https://" + net.JoinHostPort(host, port)
	}
	server, err := url.Parse(api)
	if err != nil || server.Host == "" || (server.Scheme != "https" && server.Scheme != "http") {
		return nil, errors.New("k8s.http: apiServer must be an http(s) URL")
	}
	if server.Scheme == "http" && !isLoopbackHost(server.Hostname()) {
		return nil, errors.New("k8s.http: plain http is only allowed for a loopback apiServer (tests)")
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if server.Scheme == "https" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("k8s.http: cannot read the cluster CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("k8s.http: the cluster CA file contains no certificates")
		}
		tlsCfg.RootCAs = pool
	}
	return &K8s{
		cfg: cfg, allow: al, server: server,
		client: &http.Client{
			Transport: &http.Transport{
				Proxy:               nil, // the API server is reached directly
				DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				TLSClientConfig:     tlsCfg,
				TLSHandshakeTimeout: 10 * time.Second,
				DisableCompression:  true,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// Name implements Kind.
func (*K8s) Name() string { return KindK8sHTTP }

type k8sPayload struct {
	Method      string `json:"method"`
	Path        string `json:"path"`
	BodyB64     string `json:"bodyB64"`
	ContentType string `json:"contentType"`
}

var (
	k8sPathRe = regexp.MustCompile(`^/[A-Za-z0-9._:@=,+~/-]*$`)
	// segments that never proxy to the API server's own resources: they open
	// streams into pods/nodes/services or mint credentials.
	k8sDeniedSegments = map[string]bool{"exec": true, "attach": true, "portforward": true, "proxy": true}
	k8sContentTypes   = map[string]bool{
		"application/json": true, "application/merge-patch+json": true, "application/strategic-merge-patch+json": true,
		"application/json-patch+json": true, "application/apply-patch+yaml": true, "application/yaml": true,
	}
)

// Prepare implements Kind.
func (k *K8s) Prepare(req *Request) (Runnable, error) {
	var pl k8sPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	method := strings.ToUpper(pl.Method)
	switch method {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
	default:
		return nil, invalid("method must be GET, POST, PUT, PATCH or DELETE")
	}
	if len(pl.Path) == 0 || len(pl.Path) > 4096 {
		return nil, invalid("path is missing or too long")
	}
	rawPath, rawQuery, _ := strings.Cut(pl.Path, "?")
	if !k8sPathRe.MatchString(rawPath) {
		return nil, invalid("path contains characters that are not allowed in a Kubernetes API path")
	}
	segs := strings.Split(strings.TrimPrefix(rawPath, "/"), "/")
	for i, s := range segs {
		if s == "." || s == ".." || (s == "" && i != len(segs)-1) {
			return nil, notAllowed("the path contains a dot or empty segment")
		}
		if k8sDeniedSegments[s] {
			return nil, notAllowed("subresource %q is never allowed through k8s.http", s)
		}
		if s == "secrets" && !k.cfg.AllowSecrets {
			return nil, notAllowed("reading or writing Secrets through k8s.http is disabled (allowSecrets)")
		}
		if s == "token" && i >= 2 && segs[i-2] == "serviceaccounts" {
			return nil, notAllowed("minting service account tokens is never allowed through k8s.http")
		}
	}
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return nil, invalid("the query string is malformed")
	}
	for _, key := range []string{"watch", "follow"} {
		for _, v := range q[key] {
			if v != "" && v != "false" && v != "0" {
				return nil, notAllowed("streaming requests (%s) are not supported", key)
			}
		}
	}
	act := Action{Service: "k8s", Protocol: "rest", Method: method, Path: rawPath, Name: method + " " + rawPath}
	if !k.allow.Allows(req.Capability, act) {
		return nil, notAllowed("%s %s is not allowed for capability %q on this runner", method, clipStr(rawPath, 120), req.Capability)
	}
	body, err := decodeB64(pl.BodyB64, k.cfg.MaxRequestBytes)
	if err != nil {
		return nil, err
	}
	ct := strings.ToLower(strings.TrimSpace(pl.ContentType))
	if len(body) > 0 && ct == "" {
		ct = "application/json"
	}
	if ct != "" && !k8sContentTypes[ct] {
		return nil, invalid("contentType %q is not supported", clipStr(pl.ContentType, 60))
	}

	maxResp := min(k.cfg.MaxResponseBytes, req.MaxOutputBytes)
	return func(ctx context.Context, logs agent.LogSink) Outcome {
		tok, err := os.ReadFile(k.cfg.TokenFile)
		if err != nil {
			return failed("k8s_token_unavailable: cannot read the service account token")
		}
		target := *k.server
		target.Path = strings.TrimRight(k.server.Path, "/") + rawPath
		target.RawQuery = rawQuery
		var rdr io.Reader
		if len(body) > 0 {
			rdr = bytes.NewReader(body)
		}
		hreq, err := http.NewRequestWithContext(ctx, method, target.String(), rdr)
		if err != nil {
			return failed("could not build the request")
		}
		hreq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
		hreq.Header.Set("Accept", "application/json")
		hreq.Header.Set("User-Agent", "zenith-runner/k8s.http")
		if ct != "" {
			hreq.Header.Set("Content-Type", ct)
		}
		start := time.Now()
		resp, err := k.client.Do(hreq)
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return failed("k8s_request_failed: %s", redact.String(clipStr(unwrapURLError(err).Error(), 300)))
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxResp+1))
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return failed("k8s_response_read_failed: %s", redact.String(clipStr(err.Error(), 200)))
		}
		logs.Line("info", fmt.Sprintf("k8s.http %s %s -> %d (%dms)", method, rawPath, resp.StatusCode, time.Since(start).Milliseconds()))
		result := map[string]any{"status": resp.StatusCode, "headers": k8sResponseHeaders(resp.Header)}
		if int64(len(data)) > maxResp {
			result["truncated"] = true
			return Outcome{Status: agent.StatusFailed, Result: result, Error: fmt.Sprintf("response_too_large: the response exceeds %d bytes (raise maxOutputBytes)", maxResp)}
		}
		result["bodyB64"] = base64.StdEncoding.EncodeToString(data)
		return Outcome{Status: agent.StatusSucceeded, Result: result}
	}, nil
}

func k8sResponseHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for name, vs := range h {
		ln := strings.ToLower(name)
		if len(vs) == 0 {
			continue
		}
		switch ln {
		case "content-type", "content-length", "date", "etag", "retry-after", "cache-control", "audit-id", "x-kubernetes-pf-flowschema-uid", "x-kubernetes-pf-prioritylevel-uid", "warning":
			out[ln] = clipStr(strings.Join(vs, ", "), 1024)
		}
	}
	return out
}
