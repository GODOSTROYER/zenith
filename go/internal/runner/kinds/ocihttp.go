package kinds

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/oci"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// OCIConfig is runner-local; jobs cannot select credentials or extend policy.
// Enabled must be explicitly true, unlike older kinds' implicit-on Toggle.
type OCIConfig struct {
	Enabled             bool     `json:"enabled"`
	Auth                string   `json:"auth"`
	Region              string   `json:"region"`
	Tenancy             string   `json:"tenancy"`
	AllowedCompartments []string `json:"allowedCompartments"`
	AllowedRegions      []string `json:"allowedRegions"`
	// OCID -> compartment, or service:region:<primary encoded path> for names.
	// The owner must refresh these bindings after resource moves.
	ResourceCompartments map[string]string `json:"resourceCompartments"`
	MaxRequestBytes      int64             `json:"maxRequestBytes"`
	MaxResponseBytes     int64             `json:"maxResponseBytes"`
	// True is always rejected until sealed-body support exists.
	SecretWrite bool   `json:"secretWrite"`
	AuditPath   string `json:"auditPath"`
}

type OCIDeps struct {
	Principal oci.Provider
	Client    *http.Client
	Now       func() time.Time
	Getenv    func(string) string
	Audit     func(OCIAudit) error
	// Wait is a fake backoff clock for tests. Production waits within ctx.
	Wait func(context.Context, time.Duration) error
}

type OCI struct {
	cfg  OCIConfig
	deps OCIDeps
}

func ValidateOCIConfig(cfg OCIConfig) error {
	if cfg.SecretWrite {
		return errors.New("oci.http secret.write is disabled until sealed-body support exists")
	}
	if !oci.RegionID(cfg.Region) || !oci.OCID(cfg.Tenancy) || !strings.HasPrefix(cfg.Tenancy, "ocid1.tenancy.") {
		return errors.New("oci.http requires a valid region and tenancy")
	}
	switch cfg.Auth {
	case oci.InstancePrincipal, oci.ResourcePrincipal, oci.OKEWorkloadIdentity:
	default:
		return errors.New("oci.http requires a supported principal auth mode")
	}
	if len(cfg.AllowedCompartments) == 0 {
		return errors.New("oci.http requires allowedCompartments")
	}
	allowed := map[string]bool{}
	for _, compartment := range cfg.AllowedCompartments {
		if !oci.OCID(compartment) || (!strings.HasPrefix(compartment, "ocid1.compartment.") && compartment != cfg.Tenancy) {
			return errors.New("oci.http allowedCompartments contains an invalid compartment")
		}
		allowed[compartment] = true
	}
	for _, region := range cfg.AllowedRegions {
		if !oci.RegionID(region) {
			return errors.New("oci.http allowedRegions contains an invalid region")
		}
	}
	for key, compartment := range cfg.ResourceCompartments {
		if key == "" || !allowed[compartment] {
			return errors.New("oci.http resourceCompartments has an invalid local binding")
		}
	}
	if cfg.MaxRequestBytes < 0 || cfg.MaxRequestBytes > oci.MaxRequestBytes || cfg.MaxResponseBytes < 0 || cfg.MaxResponseBytes > 1<<20 {
		return errors.New("oci.http body limits must be between 1 byte and 1 MiB (zero selects the default)")
	}
	return nil
}

// NewOCI performs no credential lookup, network call or audit write.
func NewOCI(cfg OCIConfig, deps OCIDeps) (*OCI, error) {
	if err := ValidateOCIConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.MaxRequestBytes == 0 {
		cfg.MaxRequestBytes = oci.MaxRequestBytes
	}
	if cfg.MaxResponseBytes == 0 {
		cfg.MaxResponseBytes = 1 << 20
	}
	if len(cfg.AllowedRegions) == 0 {
		cfg.AllowedRegions = []string{cfg.Region}
	}
	// Snapshot local policy so later mutations cannot change a prepared request.
	cfg.AllowedRegions = append([]string(nil), cfg.AllowedRegions...)
	cfg.AllowedCompartments = append([]string(nil), cfg.AllowedCompartments...)
	bindings := map[string]string{}
	for key, value := range cfg.ResourceCompartments {
		bindings[key] = value
	}
	cfg.ResourceCompartments = bindings
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Wait == nil {
		deps.Wait = ociWait
	}
	if deps.Principal == nil {
		var err error
		deps.Principal, err = oci.NewProvider(oci.PrincipalConfig{Auth: cfg.Auth, Region: cfg.Region, Tenancy: cfg.Tenancy}, oci.PrincipalDeps{Getenv: deps.Getenv, Now: deps.Now})
		if err != nil {
			return nil, errors.New("oci.http principal configuration is invalid")
		}
	}
	if deps.Client == nil {
		guard := &netguard.Guard{}
		deps.Client = &http.Client{Transport: &http.Transport{
			DialContext: guard.DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 10 * time.Second, MaxResponseHeaderBytes: 16 << 10,
			DisableCompression: true, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute,
		}}
	}
	client := *deps.Client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	deps.Client = &client
	if deps.Audit == nil {
		if cfg.AuditPath == "" {
			return nil, errors.New("oci.http requires a local auditPath")
		}
		deps.Audit = newOCIAudit(cfg.AuditPath)
	}
	return &OCI{cfg: cfg, deps: deps}, nil
}

func (*OCI) Name() string { return KindOCIHTTP }

// Prepare is called only after the shared executor verifies the v1 envelope,
// grant, capability claims and replay cache. Rejections never load credentials.
func (k *OCI) Prepare(req *Request) (Runnable, error) {
	if !k.cfg.Enabled {
		return nil, protocol.Errorf(protocol.CodeKindDisabled, "oci.http is disabled on this runner")
	}
	if req.Capability == "secret.write" {
		return nil, notAllowed("oci.http secret.write is disabled until sealed-body support exists")
	}
	pl, body, err := oci.ParseRequest(req.Payload, k.cfg.MaxRequestBytes)
	if err != nil {
		return nil, invalid("OCI payload does not match the unsigned request schema")
	}
	allowedRegion := false
	for _, region := range k.cfg.AllowedRegions {
		if pl.Region == region {
			allowedRegion = true
		}
	}
	if !allowedRegion {
		return nil, notAllowed("OCI region is outside the local allowlist")
	}
	host, err := oci.ResolveHost(pl.Service, pl.Region, pl.EndpointHost)
	if err != nil {
		return nil, notAllowed("OCI endpoint is not allowed")
	}
	template, allowed := oci.Match(req.Capability, pl.Service, pl.Method, pl.Path)
	if !allowed {
		return nil, notAllowed("OCI request is outside the capability allowlist")
	}
	if oci.BindCompartments(pl, body, k.cfg.AllowedCompartments, k.cfg.ResourceCompartments, template) != nil {
		return nil, notAllowed("OCI compartment binding is absent or outside the local allowlist")
	}
	headers := http.Header{}
	for name, value := range pl.Headers {
		headers.Set(name, value)
	}
	if pl.Method == "POST" && strings.TrimSpace(headers.Get("opc-retry-token")) == "" {
		return nil, invalid("OCI operations require opc-retry-token")
	}
	maxOutput := req.MaxOutputBytes
	if maxOutput <= 0 {
		maxOutput = 1 << 20
	}
	maxOutput = min(maxOutput, k.cfg.MaxResponseBytes)
	// Copy trusted envelope fields; the caller cannot mutate the audit identity.
	jobID, capability := req.JTI, req.Capability
	return func(ctx context.Context, _ agent.LogSink) Outcome {
		audit := OCIAudit{JobID: jobID, Capability: capability, Service: pl.Service, Method: pl.Method, PathTemplate: template, Sealed: false}
		return k.execute(ctx, pl, body, host, headers, maxOutput, audit)
	}, nil
}

func (k *OCI) auditOutcome(audit OCIAudit, outcome Outcome) Outcome {
	if result, ok := outcome.Result.(map[string]any); ok {
		audit.Status, _ = result["status"].(int)
		responseHeaders, _ := result["headers"].(map[string]string)
		audit.RequestID = responseHeaders["opc-request-id"]
	}
	audit.Outcome = outcome.Status
	if k.deps.Audit(audit) != nil {
		return Outcome{Status: agent.StatusFailed, Result: outcome.Result, Error: "oci_audit_failed: the local audit record could not be written"}
	}
	return outcome
}

func (k *OCI) execute(ctx context.Context, pl oci.Request, body []byte, host string, headers http.Header, maxOutput int64, audit OCIAudit) Outcome {
	query := oci.QueryString(pl.Query)
	target := "https://" + host + pl.Path
	if query != "" {
		target += "?" + query
	}
	for attempt := 0; attempt < 4; attempt++ {
		if out, done := ctxOutcome(ctx); done {
			return k.auditOutcome(audit, out)
		}
		request, err := http.NewRequestWithContext(ctx, pl.Method, target, bytes.NewReader(body))
		if err != nil {
			return k.auditOutcome(audit, failed("oci_request_failed: could not construct the request"))
		}
		request.Header = headers.Clone()
		request.Header.Set("User-Agent", "zenith-runner/oci.http")
		err = k.deps.Principal.WithPrincipal(ctx, func(principal oci.Principal) error {
			if principal.Tenancy != k.cfg.Tenancy || principal.Region != k.cfg.Region || !k.deps.Now().Add(time.Minute).Before(principal.Expires) {
				return oci.ErrPrincipal
			}
			return oci.Sign(request, body, principal.KeyID, principal.Key, k.deps.Now())
		})
		if err != nil {
			if out, done := ctxOutcome(ctx); done {
				return k.auditOutcome(audit, out)
			}
			return k.auditOutcome(audit, failed("oci_credentials_unavailable: could not load or sign with the local principal"))
		}
		response, err := k.deps.Client.Do(request)
		if err != nil {
			if out, done := ctxOutcome(ctx); done {
				return k.auditOutcome(audit, out)
			}
			return k.auditOutcome(audit, failed("oci_request_failed: the OCI transport failed"))
		}
		retry := (pl.Method == "GET" || pl.Method == "HEAD") && (response.StatusCode == 429 || response.StatusCode >= 500) && attempt < 3
		if retry {
			response.Body.Close()
			attemptOutcome := k.auditOutcome(audit, Outcome{Status: agent.StatusSucceeded, Result: map[string]any{"status": response.StatusCode, "headers": ociResponseHeaders(response.Header)}})
			if attemptOutcome.Status != agent.StatusSucceeded {
				return attemptOutcome
			}
			delay := ociRetryDelay(response.Header.Get("retry-after"), attempt, k.deps.Now())
			if k.deps.Wait(ctx, delay) != nil {
				if out, done := ctxOutcome(ctx); done {
					return out
				}
				return failed("oci_request_failed: retry interrupted")
			}
			continue
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, maxOutput+1))
		response.Body.Close()
		if err != nil {
			if out, done := ctxOutcome(ctx); done {
				return k.auditOutcome(audit, out)
			}
			return k.auditOutcome(audit, Outcome{Status: agent.StatusFailed, Result: map[string]any{"status": response.StatusCode, "headers": ociResponseHeaders(response.Header)}, Error: "oci_response_read_failed: could not read the bounded OCI response"})
		}
		truncated := int64(len(data)) > maxOutput
		if truncated {
			data = data[:maxOutput]
		}
		return k.auditOutcome(audit, Outcome{Status: agent.StatusSucceeded, Result: map[string]any{
			"status": response.StatusCode, "headers": ociResponseHeaders(response.Header), "bodyB64": base64.StdEncoding.EncodeToString(data), "truncated": truncated,
		}})
	}
	return failed("oci_request_failed: retry limit reached")
}

func ociResponseHeaders(header http.Header) map[string]string {
	out := map[string]string{}
	for _, name := range []string{"opc-request-id", "opc-next-page", "opc-work-request-id", "etag", "retry-after", "content-type"} {
		value := header.Get(name)
		if value != "" {
			out[name] = clipStr(redact.String(value), 2000)
		}
	}
	return out
}

var _ Kind = (*OCI)(nil)
