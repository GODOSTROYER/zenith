package awsauth

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Provider returns the runner's local AWS credentials.
type Provider interface {
	Retrieve(ctx context.Context) (Credentials, error)
}

// ProviderConfig drives NewChain. Every field is optional.
type ProviderConfig struct {
	// Getenv defaults to os.Getenv.
	Getenv func(string) string
	// HTTPClient is used for STS calls (honors HTTPS_PROXY by default).
	HTTPClient *http.Client
	// LocalClient is used for the link-local container and IMDS endpoints; by
	// default it never uses a proxy.
	LocalClient *http.Client
	Now         func() time.Time
	// STSEndpoint overrides https://sts.<region>.amazonaws.com (tests; also
	// AWS_ENDPOINT_URL_STS).
	STSEndpoint string
	// IMDSEndpoint overrides http://169.254.169.254 (tests; also
	// AWS_EC2_METADATA_SERVICE_ENDPOINT).
	IMDSEndpoint string
}

// RefreshBefore is how long before expiry cached credentials are replaced.
const RefreshBefore = 5 * time.Minute

// NewChain selects the credential source from the environment, in the order
// the AWS SDKs use for the sources implemented here:
//
//  1. static keys: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY [+ AWS_SESSION_TOKEN]
//  2. web identity (EKS IRSA, GKE/Azure federation into AWS):
//     AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN -> STS AssumeRoleWithWebIdentity
//  3. container credentials (ECS task role, EKS Pod Identity):
//     AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or _FULL_URI
//  4. EC2 instance profile via IMDSv2 (unless AWS_EC2_METADATA_DISABLED=true)
//
// The first source whose configuration is present is used; a failure to
// retrieve from it is reported, never silently replaced by a lower source.
// The returned name identifies the source for diagnostics (never a secret).
func NewChain(cfg ProviderConfig) (Provider, string) {
	if cfg.Getenv == nil {
		cfg.Getenv = os.Getenv
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	if cfg.LocalClient == nil {
		cfg.LocalClient = &http.Client{
			Timeout:       5 * time.Second,
			Transport:     &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	env := cfg.Getenv
	switch {
	case env("AWS_ACCESS_KEY_ID") != "" && env("AWS_SECRET_ACCESS_KEY") != "":
		c := Credentials{AccessKeyID: env("AWS_ACCESS_KEY_ID"), SecretAccessKey: env("AWS_SECRET_ACCESS_KEY"), SessionToken: env("AWS_SESSION_TOKEN"), Source: "env"}
		return staticProvider{c}, "env"
	case env("AWS_WEB_IDENTITY_TOKEN_FILE") != "" && env("AWS_ROLE_ARN") != "":
		return NewCached(&webIdentityProvider{cfg: cfg}, cfg.Now), "web_identity"
	case env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") != "" || env("AWS_CONTAINER_CREDENTIALS_FULL_URI") != "":
		return NewCached(&containerProvider{cfg: cfg}, cfg.Now), "container"
	case strings.EqualFold(env("AWS_EC2_METADATA_DISABLED"), "true"):
		return errProvider{errors.New("no AWS credential source is configured (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, a web identity, or a container credential endpoint)")}, "none"
	default:
		return NewCached(&imdsProvider{cfg: cfg}, cfg.Now), "imds"
	}
}

type staticProvider struct{ c Credentials }

func (p staticProvider) Retrieve(context.Context) (Credentials, error) { return p.c, nil }

type errProvider struct{ err error }

func (p errProvider) Retrieve(context.Context) (Credentials, error) { return Credentials{}, p.err }

// Cached wraps a Provider, keeping credentials until RefreshBefore before they
// expire. Concurrent callers share one refresh. If a refresh fails while the
// previous credentials are still valid they are kept.
type Cached struct {
	inner Provider
	now   func() time.Time
	mu    sync.Mutex
	cur   Credentials
	have  bool
}

// NewCached wraps p.
func NewCached(p Provider, now func() time.Time) *Cached {
	if now == nil {
		now = time.Now
	}
	return &Cached{inner: p, now: now}
}

// Retrieve implements Provider.
func (c *Cached) Retrieve(ctx context.Context) (Credentials, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := c.now()
	if c.have && (c.cur.Expires.IsZero() || n.Add(RefreshBefore).Before(c.cur.Expires)) {
		return c.cur, nil
	}
	fresh, err := c.inner.Retrieve(ctx)
	if err != nil {
		if c.have && n.Before(c.cur.Expires) {
			return c.cur, nil
		}
		return Credentials{}, err
	}
	if !fresh.Valid() {
		return Credentials{}, errors.New("credential source returned incomplete credentials")
	}
	c.cur, c.have = fresh, true
	return fresh, nil
}

/* ------------------------------ web identity ------------------------------ */

type webIdentityProvider struct{ cfg ProviderConfig }

func (p *webIdentityProvider) Retrieve(ctx context.Context) (Credentials, error) {
	env := p.cfg.Getenv
	tokenFile, roleARN := env("AWS_WEB_IDENTITY_TOKEN_FILE"), env("AWS_ROLE_ARN")
	session := env("AWS_ROLE_SESSION_NAME")
	if session == "" {
		session = "zenith-runner"
	}
	tok, err := os.ReadFile(tokenFile)
	if err != nil {
		return Credentials{}, fmt.Errorf("read web identity token file: %w", err)
	}
	endpoint := p.cfg.STSEndpoint
	if endpoint == "" {
		endpoint = env("AWS_ENDPOINT_URL_STS")
	}
	if endpoint == "" {
		endpoint = stsEndpoint(firstNonEmpty(env("AWS_REGION"), env("AWS_DEFAULT_REGION")))
	}
	form := url.Values{
		"Action":           {"AssumeRoleWithWebIdentity"},
		"Version":          {"2011-06-15"},
		"RoleArn":          {roleARN},
		"RoleSessionName":  {session},
		"WebIdentityToken": {strings.TrimSpace(string(tok))},
		"DurationSeconds":  {"3600"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Credentials{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.cfg.HTTPClient.Do(req)
	if err != nil {
		return Credentials{}, fmt.Errorf("STS AssumeRoleWithWebIdentity request failed: %w", sanitize(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Code    string `xml:"Error>Code"`
			Message string `xml:"Error>Message"`
		}
		_ = xml.Unmarshal(body, &e)
		return Credentials{}, fmt.Errorf("STS AssumeRoleWithWebIdentity failed: HTTP %d %s %s", resp.StatusCode, e.Code, clip(e.Message, 200))
	}
	var out struct {
		Creds struct {
			AccessKeyID     string `xml:"AccessKeyId"`
			SecretAccessKey string `xml:"SecretAccessKey"`
			SessionToken    string `xml:"SessionToken"`
			Expiration      string `xml:"Expiration"`
		} `xml:"AssumeRoleWithWebIdentityResult>Credentials"`
	}
	if err := xml.Unmarshal(body, &out); err != nil {
		return Credentials{}, errors.New("STS response is not valid XML")
	}
	exp, err := time.Parse(time.RFC3339, out.Creds.Expiration)
	if err != nil {
		return Credentials{}, errors.New("STS response has no valid Expiration")
	}
	return Credentials{AccessKeyID: out.Creds.AccessKeyID, SecretAccessKey: out.Creds.SecretAccessKey, SessionToken: out.Creds.SessionToken, Expires: exp, Source: "web_identity"}, nil
}

func stsEndpoint(region string) string {
	switch {
	case region == "":
		return "https://sts.amazonaws.com"
	case strings.HasPrefix(region, "cn-"):
		return "https://sts." + region + ".amazonaws.com.cn"
	}
	return "https://sts." + region + ".amazonaws.com"
}

/* ---------------------- ECS / EKS container credentials -------------------- */

type containerProvider struct{ cfg ProviderConfig }

func (p *containerProvider) Retrieve(ctx context.Context) (Credentials, error) {
	env := p.cfg.Getenv
	var target string
	if rel := env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"); rel != "" {
		if !strings.HasPrefix(rel, "/") {
			return Credentials{}, errors.New("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with /")
		}
		target = "http://169.254.170.2" + rel
	} else {
		target = env("AWS_CONTAINER_CREDENTIALS_FULL_URI")
		if err := checkContainerURI(target); err != nil {
			return Credentials{}, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return Credentials{}, err
	}
	auth := env("AWS_CONTAINER_AUTHORIZATION_TOKEN")
	if f := env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return Credentials{}, fmt.Errorf("read container authorization token file: %w", err)
		}
		auth = strings.TrimSpace(string(b))
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := p.cfg.LocalClient.Do(req)
	if err != nil {
		return Credentials{}, fmt.Errorf("container credential request failed: %w", sanitize(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Credentials{}, fmt.Errorf("container credential endpoint returned HTTP %d", resp.StatusCode)
	}
	return parseJSONCreds(body, "container")
}

// checkContainerURI enforces the SDK rule for AWS_CONTAINER_CREDENTIALS_FULL_URI:
// https, or http only to loopback or the ECS / EKS Pod Identity link-local
// endpoints.
func checkContainerURI(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("AWS_CONTAINER_CREDENTIALS_FULL_URI is not a valid URL")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme != "http" {
		return errors.New("AWS_CONTAINER_CREDENTIALS_FULL_URI must be https or a loopback / container endpoint")
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	if a, err := netip.ParseAddr(host); err == nil {
		switch {
		case a.IsLoopback(), a == netip.MustParseAddr("169.254.170.2"), a == netip.MustParseAddr("169.254.170.23"), a == netip.MustParseAddr("fd00:ec2::23"):
			return nil
		}
	}
	return errors.New("AWS_CONTAINER_CREDENTIALS_FULL_URI over http is only allowed for loopback and the ECS/EKS container credential endpoints")
}

func parseJSONCreds(body []byte, source string) (Credentials, error) {
	var v struct {
		Code            string `json:"Code"`
		AccessKeyID     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
		Token           string `json:"Token"`
		Expiration      string `json:"Expiration"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return Credentials{}, errors.New("credential response is not valid JSON")
	}
	if v.Code != "" && v.Code != "Success" {
		return Credentials{}, fmt.Errorf("credential endpoint reported %s", clip(v.Code, 64))
	}
	c := Credentials{AccessKeyID: v.AccessKeyID, SecretAccessKey: v.SecretAccessKey, SessionToken: v.Token, Source: source}
	if v.Expiration != "" {
		exp, err := time.Parse(time.RFC3339, v.Expiration)
		if err != nil {
			return Credentials{}, errors.New("credential response has an invalid Expiration")
		}
		c.Expires = exp
	}
	if !c.Valid() {
		return Credentials{}, errors.New("credential response is incomplete")
	}
	return c, nil
}

/* --------------------------------- IMDSv2 ---------------------------------- */

type imdsProvider struct{ cfg ProviderConfig }

func (p *imdsProvider) Retrieve(ctx context.Context) (Credentials, error) {
	base := p.cfg.IMDSEndpoint
	if base == "" {
		base = p.cfg.Getenv("AWS_EC2_METADATA_SERVICE_ENDPOINT")
	}
	if base == "" {
		base = "http://169.254.169.254"
	}
	base = strings.TrimRight(base, "/")
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	do := func(method, path string, hdr map[string]string) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, method, base+path, nil)
		if err != nil {
			return nil, err
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := p.cfg.LocalClient.Do(req)
		if err != nil {
			return nil, sanitize(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return b, nil
	}
	tok, err := do(http.MethodPut, "/latest/api/token", map[string]string{"X-aws-ec2-metadata-token-ttl-seconds": "21600"})
	if err != nil {
		return Credentials{}, fmt.Errorf("IMDSv2 token request failed: %w", err)
	}
	h := map[string]string{"X-aws-ec2-metadata-token": strings.TrimSpace(string(tok))}
	role, err := do(http.MethodGet, "/latest/meta-data/iam/security-credentials/", h)
	if err != nil {
		return Credentials{}, fmt.Errorf("IMDS role lookup failed: %w", err)
	}
	name := strings.TrimSpace(strings.SplitN(string(role), "\n", 2)[0])
	if name == "" || strings.ContainsAny(name, "/?#") {
		return Credentials{}, errors.New("IMDS returned no instance role")
	}
	body, err := do(http.MethodGet, "/latest/meta-data/iam/security-credentials/"+url.PathEscape(name), h)
	if err != nil {
		return Credentials{}, fmt.Errorf("IMDS credential request failed: %w", err)
	}
	return parseJSONCreds(body, "imds")
}

/* --------------------------------- helpers --------------------------------- */

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// sanitize removes URLs (which could carry tokens in the future) from
// network errors.
func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return ne
	}
	return err
}
