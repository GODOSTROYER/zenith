package kinds

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/awsauth"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// AWSConfig configures the aws.http SigV4 signing proxy.
type AWSConfig struct {
	Toggle
	// Allow maps a capability name to the actions it may perform:
	// "service:Action" (a trailing * is the only wildcard) or, for REST
	// services, "service:METHOD /path" (a path segment * matches one segment,
	// a final ** matches the rest). With no entry for a job's capability the
	// job is rejected: the default is deny.
	Allow map[string][]string `json:"allow"`
	// MaxRequestBytes caps the decoded request body (default 8 MiB).
	MaxRequestBytes int64 `json:"maxRequestBytes"`
	// MaxResponseBytes caps the response body returned (default 8 MiB); the
	// job's maxOutputBytes applies as well.
	MaxResponseBytes int64 `json:"maxResponseBytes"`
	// EndpointOverride sends requests to this base URL instead of the AWS host
	// (LocalStack, VPC endpoints behind a proxy, tests). The host allowlist is
	// still enforced on the job's URL, and the request is signed for that
	// host. It is local configuration, never taken from a job.
	EndpointOverride string `json:"endpointOverride"`
	// STSEndpoint and IMDSEndpoint override the credential endpoints (tests).
	STSEndpoint  string `json:"stsEndpoint"`
	IMDSEndpoint string `json:"imdsEndpoint"`
}

// AWSDeps are injectable collaborators (tests).
type AWSDeps struct {
	Creds  awsauth.Provider
	Client *http.Client
	Now    func() time.Time
	Getenv func(string) string
}

// AWS is the aws.http kind.
type AWS struct {
	cfg    AWSConfig
	allow  Allowlist
	creds  awsauth.Provider
	client *http.Client
	now    func() time.Time
	source string
}

// awsHostRe accepts *.amazonaws.com, *.amazonaws.com.cn and *.api.aws with at
// least one label before the suffix, ASCII only. Anything else (including
// evil.amazonaws.com.attacker.com and bare amazonaws.com) is refused.
var awsHostRe = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:amazonaws\.com|amazonaws\.com\.cn|api\.aws)$`)

// AWSHostAllowed reports whether host (no port) may receive signed requests.
func AWSHostAllowed(host string) bool { return awsHostRe.MatchString(host) }

// LocalSecretValues returns the secret parts (secret access key, session token)
// of the credentials this runner currently uses, so the executor can make sure
// they never appear in a result. It uses the provider's cached credentials; an
// error or an empty result means nothing could be listed, never that nothing
// is secret.
func (a *AWS) LocalSecretValues(ctx context.Context) []string {
	creds, err := a.creds.Retrieve(ctx)
	if err != nil {
		return nil
	}
	var out []string
	for _, v := range []string{creds.SecretAccessKey, creds.SessionToken} {
		if len(v) >= 8 {
			out = append(out, v)
		}
	}
	return out
}

// NewAWS builds the kind. It fails on an unparsable allowlist so a typo in
// the config is caught at startup, not at the first job.
func NewAWS(cfg AWSConfig, deps AWSDeps) (*AWS, error) {
	al, err := ParseAllowlist(cfg.Allow)
	if err != nil {
		return nil, fmt.Errorf("aws.http allow: %w", err)
	}
	if cfg.MaxRequestBytes <= 0 {
		cfg.MaxRequestBytes = 8 << 20
	}
	if cfg.MaxResponseBytes <= 0 {
		cfg.MaxResponseBytes = 8 << 20
	}
	if cfg.EndpointOverride != "" {
		u, err := url.Parse(cfg.EndpointOverride)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
			return nil, errors.New("aws.http endpointOverride must be an http(s) URL")
		}
	}
	k := &AWS{cfg: cfg, allow: al, creds: deps.Creds, client: deps.Client, now: deps.Now}
	if k.now == nil {
		k.now = time.Now
	}
	if k.creds == nil {
		k.creds, k.source = awsauth.NewChain(awsauth.ProviderConfig{Getenv: deps.Getenv, Now: k.now, STSEndpoint: cfg.STSEndpoint, IMDSEndpoint: cfg.IMDSEndpoint})
	} else {
		k.source = "injected"
	}
	if k.client == nil {
		k.client = &http.Client{
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
				TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
				TLSHandshakeTimeout:   10 * time.Second,
				DisableCompression:    true, // return the bytes AWS sent
				MaxIdleConnsPerHost:   4,
				IdleConnTimeout:       60 * time.Second,
				ResponseHeaderTimeout: 0, // bounded by the job context
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return k, nil
}

// Name implements Kind.
func (*AWS) Name() string { return KindAWSHTTP }

// CredentialSource names the credential source in use (diagnostics; never a secret).
func (k *AWS) CredentialSource() string { return k.source }

type headerValue []string

// UnmarshalJSON accepts a string or an array of strings.
func (h *headerValue) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*h = headerValue{s}
		return nil
	}
	var ss []string
	if err := json.Unmarshal(b, &ss); err != nil {
		return errors.New("header values must be strings or arrays of strings")
	}
	*h = ss
	return nil
}

type awsPayload struct {
	Service string                 `json:"service"`
	Region  string                 `json:"region"`
	Method  string                 `json:"method"`
	URL     string                 `json:"url"`
	Headers map[string]headerValue `json:"headers"`
	BodyB64 string                 `json:"bodyB64"`
}

var (
	regionRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)
	// stripHeaders are removed from the request before signing: credentials and
	// signing metadata must come only from the runner, and hop-by-hop headers
	// belong to the HTTP stack.
	stripHeaders = map[string]bool{
		"authorization": true, "x-amz-security-token": true, "x-amz-date": true, "x-amz-content-sha256": true,
		"host": true, "content-length": true, "connection": true, "transfer-encoding": true, "expect": true,
		"te": true, "upgrade": true, "keep-alive": true, "proxy-authorization": true, "proxy-connection": true,
		"cookie": true, "user-agent": true, "accept-encoding": true, "x-amz-algorithm": true,
		"x-amz-credential": true, "x-amz-signedheaders": true, "x-amz-signature": true,
	}
	// presignParams smuggle a pre-signed URL's credentials into the query.
	presignParams = []string{"x-amz-signature", "x-amz-credential", "x-amz-algorithm", "x-amz-signedheaders", "x-amz-security-token", "x-amz-date", "x-amz-expires"}
)

// Prepare implements Kind.
func (k *AWS) Prepare(req *Request) (Runnable, error) {
	var pl awsPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	if !serviceRe.MatchString(pl.Service) {
		return nil, invalid("service is missing or malformed")
	}
	if !regionRe.MatchString(pl.Region) {
		return nil, invalid("region is missing or malformed")
	}
	method := strings.ToUpper(pl.Method)
	switch method {
	case "GET", "HEAD", "POST", "PUT", "DELETE", "PATCH":
	default:
		return nil, invalid("method must be GET, HEAD, POST, PUT, DELETE or PATCH")
	}
	if len(pl.URL) == 0 || len(pl.URL) > 8192 {
		return nil, invalid("url is missing or too long")
	}
	u, err := url.Parse(pl.URL)
	if err != nil || u.Opaque != "" {
		return nil, invalid("url is not a valid absolute URL")
	}
	if u.Scheme != "https" {
		return nil, notAllowed("aws.http requires an https:// URL")
	}
	if u.User != nil {
		return nil, notAllowed("the URL must not contain credentials")
	}
	if u.Fragment != "" || u.RawFragment != "" {
		return nil, notAllowed("the URL must not contain a fragment")
	}
	if p := u.Port(); p != "" && p != "443" {
		return nil, notAllowed("only port 443 is allowed")
	}
	host := strings.ToLower(u.Hostname())
	if !AWSHostAllowed(host) {
		return nil, notAllowed("host %q is not an AWS service endpoint (*.amazonaws.com, *.amazonaws.com.cn, *.api.aws)", clipStr(host, 80))
	}
	for key := range u.Query() {
		lk := strings.ToLower(key)
		for _, p := range presignParams {
			if lk == p {
				return nil, notAllowed("the query carries a signing parameter (%s); pre-signed requests are not accepted", p)
			}
		}
	}
	if k.cfg.EndpointOverride == "" && (strings.ContainsAny(u.Path, "\x00") || strings.Contains(u.RawPath, "\x00")) {
		return nil, invalid("the path contains a NUL byte")
	}

	hdr := http.Header{}
	for name, vals := range pl.Headers {
		if !validHeaderName(name) {
			return nil, invalid("header name %q is not valid", clipStr(name, 40))
		}
		if stripHeaders[strings.ToLower(name)] {
			continue
		}
		for _, v := range vals {
			if strings.ContainsAny(v, "\r\n\x00") || len(v) > 8192 {
				return nil, invalid("header %q has an invalid value", clipStr(name, 40))
			}
			hdr.Add(name, v)
		}
	}
	body, err := decodeB64(pl.BodyB64, k.cfg.MaxRequestBytes)
	if err != nil {
		return nil, err
	}
	act, err := ExtractAction(pl.Service, method, u, hdr, body)
	if err != nil {
		return nil, err
	}
	if !k.allow.Allows(req.Capability, act) {
		return nil, notAllowed("%s is not allowed for capability %q on this runner", act.String(), req.Capability)
	}

	maxResp := min(k.cfg.MaxResponseBytes, req.MaxOutputBytes)
	return func(ctx context.Context, logs agent.LogSink) Outcome {
		creds, err := k.creds.Retrieve(ctx)
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return failed("aws_credentials_unavailable: %s", redact.String(err.Error()))
		}
		wirePath := u.EscapedPath()
		sreq := &awsauth.Request{Method: method, Host: host, Path: wirePath, Query: u.RawQuery, Header: hdr, Body: body}
		s3 := pl.Service == "s3" || pl.Service == "s3-outposts" || pl.Service == "s3express"
		if _, err := awsauth.Sign(sreq, creds, awsauth.Options{Service: pl.Service, Region: pl.Region, Time: k.now(), S3Style: s3}); err != nil {
			return failed("could not sign the request")
		}

		target := &url.URL{Scheme: "https", Host: host, Path: u.Path, RawPath: u.RawPath, RawQuery: u.RawQuery}
		if k.cfg.EndpointOverride != "" {
			o, _ := url.Parse(k.cfg.EndpointOverride)
			target.Scheme, target.Host = o.Scheme, o.Host
		}
		var rdr io.Reader
		if len(body) > 0 {
			rdr = bytes.NewReader(body)
		}
		hreq, err := http.NewRequestWithContext(ctx, method, target.String(), rdr)
		if err != nil {
			return failed("could not build the request")
		}
		hreq.Host = host // must equal the signed host even when the connection goes elsewhere
		for name, vals := range sreq.Header {
			for _, v := range vals {
				hreq.Header.Add(name, v)
			}
		}
		hreq.Header.Set("User-Agent", "zenith-runner/aws.http")

		start := time.Now()
		resp, err := k.client.Do(hreq)
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return failed("aws_request_failed: %s", redact.String(clipStr(unwrapURLError(err).Error(), 300)))
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxResp+1))
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return failed("aws_response_read_failed: %s", redact.String(clipStr(err.Error(), 200)))
		}
		logs.Line("info", fmt.Sprintf("aws.http %s -> %d (%dms)", act.String(), resp.StatusCode, time.Since(start).Milliseconds()))
		result := map[string]any{"status": resp.StatusCode, "headers": awsResponseHeaders(resp.Header)}
		if int64(len(data)) > maxResp {
			// A truncated body would fail to parse in the caller's SDK with a
			// misleading error, so the response is reported as too large instead.
			result["truncated"] = true
			return Outcome{Status: agent.StatusFailed, Result: result, Error: fmt.Sprintf("response_too_large: the response exceeds %d bytes (raise maxOutputBytes)", maxResp)}
		}
		result["bodyB64"] = base64.StdEncoding.EncodeToString(data)
		return Outcome{Status: agent.StatusSucceeded, Result: result}
	}, nil
}

func decodeB64(s string, max int64) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	if int64(len(s)) > max*4/3+8 {
		return nil, invalid("bodyB64 exceeds the %d-byte request limit", max)
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b2, err2 := base64.RawStdEncoding.DecodeString(s)
		if err2 != nil {
			return nil, invalid("bodyB64 is not valid base64")
		}
		b = b2
	}
	if int64(len(b)) > max {
		return nil, invalid("the request body exceeds the %d-byte limit", max)
	}
	return b, nil
}

// awsResponseHeaders keeps only headers a caller's SDK needs to interpret a
// response; nothing that could carry local identity or session data.
func awsResponseHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for name, vs := range h {
		ln := strings.ToLower(name)
		if len(vs) == 0 {
			continue
		}
		switch {
		case strings.HasPrefix(ln, "x-amz-"), strings.HasPrefix(ln, "x-amzn-"), strings.HasPrefix(ln, "content-"):
		case ln == "date", ln == "etag", ln == "last-modified", ln == "location", ln == "retry-after", ln == "accept-ranges",
			ln == "cache-control", ln == "expires", ln == "vary", ln == "server":
		default:
			continue
		}
		out[ln] = clipStr(strings.Join(vs, ", "), 2048)
	}
	return out
}
