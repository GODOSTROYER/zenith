package kinds

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// Toggle enables or disables one job kind. A kind block that is present is
// enabled unless `"enabled": false`; an absent block means disabled.
type Toggle struct {
	Enabled *bool `json:"enabled"`
}

// IsOn reports whether the kind is enabled.
func (t *Toggle) IsOn() bool { return t != nil && (t.Enabled == nil || *t.Enabled) }

// ProbeConfig holds settings shared by probe.http, probe.tcp and probe.dns.
type ProbeConfig struct {
	// AllowLoopback lets probes reach 127.0.0.0/8 and ::1 (default false).
	AllowLoopback bool `json:"allowLoopback"`
	// CAFile adds a CA bundle for probe.http TLS verification (private PKI).
	// Verification is never disabled.
	CAFile string `json:"caFile"`
}

// Probes builds the three probe kinds. The guard is shared so tests can
// inject a fake resolver (DNS rebinding simulation).
type Probes struct {
	guard *netguard.Guard
	res   netguard.Resolver
	caPEM *x509.CertPool
}

// NewProbes builds probe support. resolver may be nil (system resolver).
func NewProbes(cfg ProbeConfig, resolver netguard.Resolver) (*Probes, error) {
	p := &Probes{guard: &netguard.Guard{Resolver: resolver, AllowLoopback: cfg.AllowLoopback}, res: resolver}
	if p.res == nil {
		p.res = net.DefaultResolver
	}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("probe.http caFile: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("probe.http caFile contains no PEM certificates")
		}
		p.caPEM = pool
	}
	return p, nil
}

const (
	defaultProbeTimeoutMs = 10_000
	maxProbeBodyBytes     = 1 << 20
	maxProbePreviewBytes  = 64 << 10
)

/* -------------------------------- probe.tcp -------------------------------- */

type tcpPayload struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	TimeoutMs int    `json:"timeoutMs"`
}

// TCP returns the probe.tcp kind.
func (p *Probes) TCP() Kind { return tcpKind{p} }

type tcpKind struct{ p *Probes }

func (tcpKind) Name() string { return KindProbeTCP }

func (k tcpKind) Prepare(req *Request) (Runnable, error) {
	var pl tcpPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	if err := validateHost(pl.Host); err != nil {
		return nil, err
	}
	if pl.Port < 1 || pl.Port > 65535 {
		return nil, invalid("port must be between 1 and 65535")
	}
	timeout := probeTimeout(pl.TimeoutMs, req.Timeout)
	if err := literalCheck(k.p.guard, pl.Host); err != nil {
		return nil, err
	}
	return func(ctx context.Context, _ agent.LogSink) Outcome {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		start := time.Now()
		addrs, err := k.p.guard.Resolve(ctx, pl.Host)
		if err != nil {
			return probeError(ctx, err, map[string]any{"host": pl.Host, "port": pl.Port})
		}
		var lastErr error
		for _, a := range addrs {
			d := net.Dialer{}
			c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), fmt.Sprint(pl.Port)))
			if err == nil {
				_ = c.Close()
				return Outcome{Status: agent.StatusSucceeded, Result: map[string]any{
					"ok": true, "host": pl.Host, "port": pl.Port, "remoteAddr": a.String(), "latencyMs": time.Since(start).Milliseconds(),
				}}
			}
			lastErr = err
			if ctx.Err() != nil {
				break
			}
		}
		return probeError(ctx, lastErr, map[string]any{"host": pl.Host, "port": pl.Port, "latencyMs": time.Since(start).Milliseconds()})
	}, nil
}

/* -------------------------------- probe.dns -------------------------------- */

type dnsPayload struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	TimeoutMs int    `json:"timeoutMs"`
}

// DNS returns the probe.dns kind.
func (p *Probes) DNS() Kind { return dnsKind{p} }

type dnsKind struct{ p *Probes }

func (dnsKind) Name() string { return KindProbeDNS }

func (k dnsKind) Prepare(req *Request) (Runnable, error) {
	var pl dnsPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	if err := validateHost(pl.Name); err != nil {
		return nil, err
	}
	typ := strings.ToUpper(pl.Type)
	if typ == "" {
		typ = "A"
	}
	switch typ {
	case "A", "AAAA", "CNAME", "TXT", "MX", "NS":
	default:
		return nil, invalid("type must be one of A, AAAA, CNAME, TXT, MX, NS")
	}
	if err := literalCheck(k.p.guard, pl.Name); err != nil {
		return nil, err
	}
	timeout := probeTimeout(pl.TimeoutMs, req.Timeout)
	return func(ctx context.Context, _ agent.LogSink) Outcome {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		start := time.Now()
		name := netguard.NormalizeHost(pl.Name)
		var answers []string
		var err error
		switch typ {
		case "A", "AAAA":
			var addrs []netip.Addr
			network := "ip4"
			if typ == "AAAA" {
				network = "ip6"
			}
			addrs, err = k.p.res.LookupNetIP(ctx, network, name)
			for _, a := range addrs {
				if cerr := k.p.guard.CheckAddr(a); cerr != nil {
					return Outcome{Status: agent.StatusRejected, Error: protocol.CodeGuardDenied + ": " + cerr.Error(), Result: map[string]any{"reason": protocol.CodeGuardDenied}}
				}
				answers = append(answers, a.Unmap().String())
			}
		case "CNAME":
			var c string
			c, err = net.DefaultResolver.LookupCNAME(ctx, name)
			if err == nil {
				answers = []string{strings.TrimSuffix(c, ".")}
			}
		case "TXT":
			answers, err = net.DefaultResolver.LookupTXT(ctx, name)
			for i := range answers {
				answers[i] = redact.String(clipStr(answers[i], 512))
			}
		case "MX":
			var mx []*net.MX
			mx, err = net.DefaultResolver.LookupMX(ctx, name)
			for _, m := range mx {
				answers = append(answers, fmt.Sprintf("%d %s", m.Pref, strings.TrimSuffix(m.Host, ".")))
			}
		case "NS":
			var ns []*net.NS
			ns, err = net.DefaultResolver.LookupNS(ctx, name)
			for _, n := range ns {
				answers = append(answers, strings.TrimSuffix(n.Host, "."))
			}
		}
		sort.Strings(answers)
		res := map[string]any{"name": pl.Name, "type": typ, "latencyMs": time.Since(start).Milliseconds()}
		if err != nil {
			return probeError(ctx, err, res)
		}
		res["ok"] = len(answers) > 0
		res["answers"] = answers
		if len(answers) > 64 {
			res["answers"] = answers[:64]
			res["truncated"] = true
		}
		return Outcome{Status: agent.StatusSucceeded, Result: res}
	}, nil
}

/* -------------------------------- probe.http ------------------------------- */

type httpPayload struct {
	URL             string            `json:"url"`
	Method          string            `json:"method"`
	Headers         map[string]string `json:"headers"`
	TimeoutMs       int               `json:"timeoutMs"`
	FollowRedirects bool              `json:"followRedirects"`
	MaxRedirects    int               `json:"maxRedirects"`
	ExpectStatus    []int             `json:"expectStatus"`
	IncludeBody     bool              `json:"includeBody"`
	MaxBodyBytes    int               `json:"maxBodyBytes"`
}

// HTTP returns the probe.http kind.
func (p *Probes) HTTP() Kind { return httpKind{p} }

type httpKind struct{ p *Probes }

func (httpKind) Name() string { return KindProbeHTTP }

var forbiddenProbeHeaders = map[string]bool{
	"host": true, "content-length": true, "connection": true, "transfer-encoding": true, "upgrade": true,
	"te": true, "proxy-authorization": true, "proxy-connection": true, "expect": true,
}

func (k httpKind) Prepare(req *Request) (Runnable, error) {
	var pl httpPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	if len(pl.URL) == 0 || len(pl.URL) > 2048 {
		return nil, invalid("url is missing or too long")
	}
	u, err := url.Parse(pl.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, invalid("url must be an absolute http(s) URL")
	}
	if u.User != nil {
		return nil, invalid("url must not contain credentials")
	}
	if err := validateHost(u.Hostname()); err != nil {
		return nil, err
	}
	if err := literalCheck(k.p.guard, u.Hostname()); err != nil {
		return nil, err
	}
	method := strings.ToUpper(pl.Method)
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodHead {
		return nil, invalid("method must be GET or HEAD")
	}
	if len(pl.Headers) > 32 {
		return nil, invalid("at most 32 headers are allowed")
	}
	for name, v := range pl.Headers {
		if !validHeaderName(name) || forbiddenProbeHeaders[strings.ToLower(name)] || strings.ContainsAny(v, "\r\n\x00") || len(v) > 4096 {
			return nil, invalid("header %q is not allowed", clipStr(name, 40))
		}
	}
	if pl.MaxRedirects < 0 || pl.MaxRedirects > 5 {
		return nil, invalid("maxRedirects must be between 0 and 5")
	}
	if pl.MaxRedirects == 0 {
		pl.MaxRedirects = 5
	}
	for _, s := range pl.ExpectStatus {
		if s < 100 || s > 599 {
			return nil, invalid("expectStatus entries must be HTTP status codes")
		}
	}
	bodyCap := int64(pl.MaxBodyBytes)
	if bodyCap <= 0 || bodyCap > maxProbePreviewBytes {
		bodyCap = maxProbePreviewBytes
	}
	timeout := probeTimeout(pl.TimeoutMs, req.Timeout)

	return func(ctx context.Context, _ agent.LogSink) Outcome {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: k.p.caPEM}
		tr := &http.Transport{
			Proxy:                 nil, // a proxy would defeat resolve-then-dial address checking
			DialContext:           k.p.guard.DialContext,
			TLSClientConfig:       tlsCfg,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: timeout,
			DisableKeepAlives:     true,
			DisableCompression:    true,
		}
		defer tr.CloseIdleConnections()
		var redirects []string
		client := &http.Client{
			Transport: tr,
			CheckRedirect: func(r *http.Request, via []*http.Request) error {
				if !pl.FollowRedirects {
					return http.ErrUseLastResponse
				}
				if len(via) > pl.MaxRedirects {
					return errors.New("too many redirects")
				}
				if err := netguard.CheckHostname(r.URL.Hostname()); err != nil {
					return err
				}
				redirects = append(redirects, r.URL.Redacted())
				return nil
			},
		}
		hreq, err := http.NewRequestWithContext(ctx, method, pl.URL, nil)
		if err != nil {
			return failed("could not build the request")
		}
		hreq.Header.Set("User-Agent", "zenith-runner-probe/1")
		for name, v := range pl.Headers {
			hreq.Header.Set(name, v)
		}
		start := time.Now()
		resp, err := client.Do(hreq)
		if err != nil {
			return probeError(ctx, unwrapURLError(err), map[string]any{"url": redactURL(u), "latencyMs": time.Since(start).Milliseconds()})
		}
		defer resp.Body.Close()
		h := sha256.New()
		var body io.Reader = io.LimitReader(resp.Body, maxProbeBodyBytes+1)
		previewBuf := &previewWriter{limit: int(bodyCap)}
		if pl.IncludeBody && method == http.MethodGet {
			body = io.TeeReader(body, previewBuf)
		}
		n, _ := io.Copy(h, body)
		truncated := n > maxProbeBodyBytes
		res := map[string]any{
			"ok":         statusOK(resp.StatusCode, pl.ExpectStatus),
			"url":        redactURL(u),
			"status":     resp.StatusCode,
			"latencyMs":  time.Since(start).Milliseconds(),
			"headers":    probeHeaders(resp.Header),
			"bodyBytes":  min(n, maxProbeBodyBytes),
			"bodySha256": hex.EncodeToString(h.Sum(nil)),
		}
		if truncated {
			res["bodyTruncated"] = true
		}
		if len(redirects) > 0 {
			res["redirects"] = redirects
		}
		if pl.IncludeBody {
			res["bodyPreview"] = redact.String(strings.ToValidUTF8(previewBuf.String(), "?"))
		}
		if resp.TLS != nil {
			res["tlsVersion"] = tlsVersionName(resp.TLS.Version)
			if len(resp.TLS.PeerCertificates) > 0 {
				res["tlsNotAfter"] = resp.TLS.PeerCertificates[0].NotAfter.UTC().Format(time.RFC3339)
			}
		}
		return Outcome{Status: agent.StatusSucceeded, Result: res}
	}, nil
}

type previewWriter struct {
	buf   []byte
	limit int
}

func (w *previewWriter) Write(p []byte) (int, error) {
	if room := w.limit - len(w.buf); room > 0 {
		w.buf = append(w.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (w *previewWriter) String() string { return string(w.buf) }

func statusOK(status int, expect []int) bool {
	if len(expect) == 0 {
		return status < 400
	}
	for _, e := range expect {
		if e == status {
			return true
		}
	}
	return false
}

var probeHeaderAllow = map[string]bool{
	"content-type": true, "content-length": true, "server": true, "date": true, "location": true,
	"cache-control": true, "etag": true, "last-modified": true, "retry-after": true, "www-authenticate": true,
}

func probeHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for name, vs := range h {
		if probeHeaderAllow[strings.ToLower(name)] && len(vs) > 0 {
			out[strings.ToLower(name)] = clipStr(vs[0], 512)
		}
	}
	return out
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS12:
		return "1.2"
	case tls.VersionTLS13:
		return "1.3"
	}
	return "other"
}

/* --------------------------------- helpers --------------------------------- */

// probeTimeout picks the probe deadline: the payload value (default 10 s),
// never above the job timeout.
func probeTimeout(ms int, jobTimeout time.Duration) time.Duration {
	d := time.Duration(ms) * time.Millisecond
	if d <= 0 {
		d = defaultProbeTimeoutMs * time.Millisecond
	}
	if jobTimeout > 0 && d > jobTimeout {
		d = jobTimeout
	}
	return d
}

func validateHost(h string) error {
	h = netguard.NormalizeHost(h)
	if h == "" || len(h) > 253 {
		return invalid("host is missing or too long")
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '.', c == '_', c == ':', c == '%':
		default:
			return invalid("host contains characters that are not allowed")
		}
	}
	return nil
}

// literalCheck rejects, before anything runs, hostnames and IP literals that
// are denied. Names that merely RESOLVE to a denied address are caught at run
// time by the guard.
func literalCheck(g *netguard.Guard, host string) error {
	h := netguard.NormalizeHost(host)
	if err := netguard.CheckHostname(h); err != nil {
		return protocol.Errorf(protocol.CodeGuardDenied, "%v", err)
	}
	if a, err := netip.ParseAddr(h); err == nil {
		if err := g.CheckAddr(a.WithZone("")); err != nil {
			return protocol.Errorf(protocol.CodeGuardDenied, "%v", err)
		}
	}
	return nil
}

func validHeaderName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// probeError converts a network error into an observation. A guard denial is
// reported as a rejection; everything else is a *successful* probe whose
// result says the target is not reachable (an observation, not a job failure).
func probeError(ctx context.Context, err error, res map[string]any) Outcome {
	if netguard.IsBlocked(err) {
		return Outcome{Status: agent.StatusRejected, Error: protocol.CodeGuardDenied + ": " + err.Error(), Result: map[string]any{"reason": protocol.CodeGuardDenied}}
	}
	if o, done := ctxOutcomeForProbe(ctx); done {
		res["ok"] = false
		res["errorCode"] = o
		return Outcome{Status: agent.StatusSucceeded, Result: res}
	}
	res["ok"] = false
	res["errorCode"] = classifyNetError(err)
	return Outcome{Status: agent.StatusSucceeded, Result: res}
}

// ctxOutcomeForProbe distinguishes the probe's own timeout (an observation)
// from agent shutdown (which propagates as a failure through the executor).
func ctxOutcomeForProbe(ctx context.Context) (string, bool) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "timeout", true
	}
	return "", false
}

func classifyNetError(err error) string {
	var dns *net.DNSError
	switch {
	case err == nil:
		return "unknown"
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.Errno(10061)):
		return "connection_refused"
	case errors.As(err, &dns):
		if dns.IsNotFound {
			return "dns_not_found"
		}
		if dns.IsTimeout {
			return "dns_timeout"
		}
		return "dns_error"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "connection refused"):
		return "connection_refused"
	case strings.Contains(msg, "no route to host"), strings.Contains(msg, "network is unreachable"):
		return "unreachable"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "timed out"):
		return "timeout"
	case strings.Contains(msg, "certificate"), strings.Contains(msg, "x509"), strings.Contains(msg, "tls:"):
		return "tls_error"
	case strings.Contains(msg, "connection reset"), strings.Contains(msg, "eof"):
		return "connection_reset"
	}
	return "network_error"
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

func redactURL(u *url.URL) string {
	c := *u
	c.User = nil
	c.RawQuery = "" // queries can carry tokens; never echoed
	c.Fragment = ""
	return c.String()
}

func clipStr(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
