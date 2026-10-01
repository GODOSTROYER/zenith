package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// HTTPError is a non-2xx response from the control plane.
type HTTPError struct {
	Status  int
	Code    string // machine code from the JSON body, if any
	Message string
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("control plane returned %d %s", e.Status, e.Code)
	}
	return fmt.Sprintf("control plane returned %d", e.Status)
}

// Sentinel conditions the loop reacts to.
var (
	// ErrRevoked: the control plane revoked this agent (401 agent_revoked or a
	// heartbeat with revoked:true). Terminal: the agent exits with code 3.
	ErrRevoked = errors.New("agent revoked by the control plane")
	// ErrUpgradeRequired: 426 upgrade_required. Terminal: exit code 4.
	ErrUpgradeRequired = errors.New("control plane requires a newer agent protocol version")
)

// BuildTLS builds a TLS config: TLS >= 1.2, system roots or the pinned CA,
// and the optional client certificate. Server verification is never disabled.
func BuildTLS(c TLSConfig) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.CAFile != "" {
		pem, err := os.ReadFile(c.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read tls.caFile: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("tls.caFile %s contains no PEM certificates", c.CAFile)
		}
		cfg.RootCAs = pool
	}
	if c.ClientCert != "" {
		cert, err := tls.LoadX509KeyPair(c.ClientCert, c.ClientKey)
		if err != nil {
			return nil, fmt.Errorf("load tls client certificate: %w", err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	return cfg, nil
}

// NewHTTPClient builds the HTTP client used for all control-plane traffic.
// It never follows redirects (a signed request must not be replayed to
// another origin) and honors HTTPS_PROXY / NO_PROXY.
func NewHTTPClient(tlsCfg *tls.Config) *http.Client {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsCfg,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   4,
		ExpectContinueTimeout: time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Client sends requests to the control plane, signing them per spec section 3.
type Client struct {
	base     *url.URL
	basePath string
	http     *http.Client
	priv     ed25519.PrivateKey // nil for unsigned (registration) use
	agentID  string
	protocol string
	ua       string
	now      func() time.Time
}

// NewClient builds a Client. priv may be nil for the unsigned registration
// call. now may be nil.
func NewClient(baseURL string, httpc *http.Client, priv ed25519.PrivateKey, agentID, protocolID, userAgent string, now func() time.Time) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	return &Client{
		base:     u,
		basePath: strings.TrimRight(u.EscapedPath(), "/"),
		http:     httpc,
		priv:     priv,
		agentID:  agentID,
		protocol: protocolID,
		ua:       userAgent,
		now:      now,
	}, nil
}

// Do sends one JSON request. reqBody may be nil; out may be nil. maxResp
// bounds the response body. The request is signed unless the client has no
// key.
func (c *Client) Do(ctx context.Context, method, path string, reqBody, out any, timeout time.Duration, maxResp int64) (int, error) {
	var body []byte
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return 0, fmt.Errorf("encode request: %w", err)
		}
		body = b
	}
	u := *c.base
	u.Path = c.basePath + path
	u.RawPath = ""
	u.RawQuery = ""
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rdr)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.ua)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.priv != nil {
		signed, err := protocol.SignRequest(c.priv, c.agentID, c.protocol, method, req.URL.RequestURI(), body, c.now(), nil)
		if err != nil {
			return 0, err
		}
		signed.Apply(req.Header)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("request failed: %w", sanitizeNetErr(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResp+1))
	if err != nil {
		return resp.StatusCode, fmt.Errorf("read response: %w", sanitizeNetErr(err))
	}
	if int64(len(data)) > maxResp {
		return resp.StatusCode, fmt.Errorf("response exceeds %d bytes", maxResp)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		he := &HTTPError{Status: resp.StatusCode}
		he.Code, he.Message = errorFields(data)
		switch {
		case resp.StatusCode == http.StatusUnauthorized && he.Code == "agent_revoked":
			return resp.StatusCode, ErrRevoked
		case resp.StatusCode == http.StatusUpgradeRequired:
			return resp.StatusCode, ErrUpgradeRequired
		}
		return resp.StatusCode, he
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("decode response: %w", err)
		}
	}
	return resp.StatusCode, nil
}

// sanitizeNetErr drops the URL from *url.Error so query strings or tokens
// never reach logs (there are none today; this keeps it that way).
func sanitizeNetErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// errorFields extracts {code, message} from common JSON error shapes:
// {"error":"code"}, {"error":{"code":"..","message":".."}}, {"code":"..","message":".."}.
func errorFields(body []byte) (code, msg string) {
	var v struct {
		Error   json.RawMessage `json:"error"`
		Code    string          `json:"code"`
		Message string          `json:"message"`
	}
	if json.Unmarshal(body, &v) != nil {
		return "", ""
	}
	code, msg = v.Code, v.Message
	if len(v.Error) > 0 {
		var s string
		if json.Unmarshal(v.Error, &s) == nil {
			code = s
		} else {
			var o struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if json.Unmarshal(v.Error, &o) == nil {
				if o.Code != "" {
					code = o.Code
				}
				if o.Message != "" {
					msg = o.Message
				}
			}
		}
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return code, msg
}
