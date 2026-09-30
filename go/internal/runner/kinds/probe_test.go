package kinds

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// fakeResolver simulates DNS, including a name that resolves to a metadata
// address (the DNS-rebinding shape).
type fakeResolver struct {
	m map[string][]netip.Addr
}

func (f fakeResolver) LookupNetIP(_ context.Context, network, host string) ([]netip.Addr, error) {
	addrs, ok := f.m[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	var out []netip.Addr
	for _, a := range addrs {
		switch network {
		case "ip4":
			if a.Is4() {
				out = append(out, a)
			}
		case "ip6":
			if a.Is6() {
				out = append(out, a)
			}
		default:
			out = append(out, a)
		}
	}
	if len(out) == 0 {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return out, nil
}

func ip(s string) netip.Addr { return netip.MustParseAddr(s) }

func newProbes(t *testing.T, allowLoopback bool, res map[string][]netip.Addr) *Probes {
	t.Helper()
	p, err := NewProbes(ProbeConfig{AllowLoopback: allowLoopback}, fakeResolver{m: res})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func prepareProbe(t *testing.T, k Kind, pl map[string]any) (Runnable, error) {
	t.Helper()
	raw, _ := json.Marshal(pl)
	return k.Prepare(&Request{JTI: "job_p", Capability: "network.portCheck", Payload: raw, Timeout: 10 * time.Second, MaxOutputBytes: 1 << 20})
}

func runProbe(t *testing.T, k Kind, pl map[string]any) Outcome {
	t.Helper()
	run, err := prepareProbe(t, k, pl)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return run(ctx, agent.DiscardSink{})
}

func listener(t *testing.T) (host string, port int, closeFn func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	a := l.Addr().(*net.TCPAddr)
	return "127.0.0.1", a.Port, func() { _ = l.Close() }
}

func TestProbeTCPOpenAndClosed(t *testing.T) {
	host, port, stop := listener(t)
	p := newProbes(t, true, nil)
	o := runProbe(t, p.TCP(), map[string]any{"host": host, "port": port, "timeoutMs": 2000})
	res := resultMap(t, o)
	if o.Status != agent.StatusSucceeded || res["ok"] != true || res["remoteAddr"] != "127.0.0.1" {
		t.Fatalf("%+v", o)
	}
	stop()
	o = runProbe(t, p.TCP(), map[string]any{"host": host, "port": port, "timeoutMs": 2000})
	res = resultMap(t, o)
	if o.Status != agent.StatusSucceeded || res["ok"] != false || res["errorCode"] != "connection_refused" {
		t.Fatalf("a closed port is an observation, not a job failure: %+v", o)
	}
}

func TestProbeLoopbackIsDeniedByDefault(t *testing.T) {
	host, port, stop := listener(t)
	defer stop()
	p := newProbes(t, false, nil)
	_, err := prepareProbe(t, p.TCP(), map[string]any{"host": host, "port": port})
	expectPrepareCode(t, err, protocol.CodeGuardDenied)
	// a name that resolves to loopback is caught at run time
	p2 := newProbes(t, false, map[string][]netip.Addr{"local.example.com": {ip("127.0.0.1")}})
	o := runProbe(t, p2.TCP(), map[string]any{"host": "local.example.com", "port": port})
	if o.Status != agent.StatusRejected || !strings.Contains(o.Error, protocol.CodeGuardDenied) {
		t.Fatalf("%+v", o)
	}
}

func TestProbeRefusesMetadataAndLinkLocalLiterals(t *testing.T) {
	p := newProbes(t, true, nil)
	for _, host := range []string{
		"169.254.169.254", "169.254.170.2", "169.254.0.1", "[169.254.169.254]", "fd00:ec2::254", "[fd00:ec2::254]", "fe80::1", "fe80::abcd%eth0",
		"::ffff:169.254.169.254", "0:0:0:0:0:ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "168.63.129.16", "100.100.100.200", "0.0.0.0", "224.0.0.1",
		"metadata.google.internal", "METADATA.GOOGLE.INTERNAL", "metadata.google.internal.", "foo.metadata.google.internal", "metadata", "instance-data",
		"instance-data.ec2.internal", "metadata.azure", "metadata.azure.com", "metadata.goog",
	} {
		for name, k := range map[string]Kind{"tcp": p.TCP(), "dns": p.DNS()} {
			pl := map[string]any{"host": host, "port": 80}
			if name == "dns" {
				pl = map[string]any{"name": host}
			}
			_, err := prepareProbe(t, k, pl)
			if err == nil {
				t.Errorf("%s %q must be refused", name, host)
				continue
			}
			if name == "tcp" && protocol.CodeOf(err) != protocol.CodeGuardDenied && protocol.CodeOf(err) != protocol.CodeInvalidPayload {
				t.Errorf("%q: unexpected code %s", host, protocol.CodeOf(err))
			}
		}
		_, err := prepareProbe(t, p.HTTP(), map[string]any{"url": "http://" + host + "/"})
		if err == nil {
			t.Errorf("http %q must be refused", host)
		}
	}
}

// The DNS-rebinding shape: an innocent-looking name whose A record is the
// metadata address must be refused after resolution, before any connection.
func TestProbeRefusesHostnameResolvingToMetadata(t *testing.T) {
	p := newProbes(t, true, map[string][]netip.Addr{
		"rebind.example.com": {ip("169.254.169.254")},
		"mixed.example.com":  {ip("93.184.216.34"), ip("169.254.169.254")},
		"v6.example.com":     {ip("fd00:ec2::254")},
		"mapped.example.com": {ip("::ffff:169.254.169.254")},
		"linklocal6.example": {ip("fe80::1")},
	})
	for _, host := range []string{"rebind.example.com", "mixed.example.com", "v6.example.com", "mapped.example.com", "linklocal6.example"} {
		t.Run(host, func(t *testing.T) {
			o := runProbe(t, p.TCP(), map[string]any{"host": host, "port": 80, "timeoutMs": 1000})
			if o.Status != agent.StatusRejected || !strings.Contains(o.Error, protocol.CodeGuardDenied) {
				t.Fatalf("tcp: %+v", o)
			}
			o = runProbe(t, p.HTTP(), map[string]any{"url": "http://" + host + "/latest/meta-data/iam/security-credentials/", "timeoutMs": 1000})
			if o.Status != agent.StatusRejected || !strings.Contains(o.Error, protocol.CodeGuardDenied) {
				t.Fatalf("http: %+v", o)
			}
		})
	}
	// the A-record probe refuses to report a metadata answer
	o := runProbe(t, p.DNS(), map[string]any{"name": "rebind.example.com", "type": "A"})
	if o.Status != agent.StatusRejected {
		t.Fatalf("dns: %+v", o)
	}
}

func TestProbeDNS(t *testing.T) {
	p := newProbes(t, false, map[string][]netip.Addr{
		"api.example.com": {ip("10.0.1.5"), ip("10.0.1.4"), ip("2001:db8::1")},
	})
	o := runProbe(t, p.DNS(), map[string]any{"name": "api.example.com", "type": "A"})
	res := resultMap(t, o)
	answers := res["answers"].([]any)
	if o.Status != agent.StatusSucceeded || res["ok"] != true || len(answers) != 2 || answers[0] != "10.0.1.4" {
		t.Fatalf("A answers should be sorted and IPv4 only: %+v", o)
	}
	o = runProbe(t, p.DNS(), map[string]any{"name": "api.example.com", "type": "AAAA"})
	if a := resultMap(t, o)["answers"].([]any); len(a) != 1 || a[0] != "2001:db8::1" {
		t.Fatalf("%+v", o)
	}
	o = runProbe(t, p.DNS(), map[string]any{"name": "nope.example.com"})
	res = resultMap(t, o)
	if o.Status != agent.StatusSucceeded || res["ok"] != false || res["errorCode"] != "dns_not_found" {
		t.Fatalf("NXDOMAIN is an observation: %+v", o)
	}
	_, err := prepareProbe(t, p.DNS(), map[string]any{"name": "x.example.com", "type": "SRV"})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	_, err = prepareProbe(t, p.DNS(), map[string]any{"name": "bad name", "type": "A"})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	_, err = prepareProbe(t, p.DNS(), map[string]any{"name": "x.example.com", "server": "8.8.8.8"})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload) // a custom resolver is not supported
}

func TestProbeHTTPObservesStatusAndBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Probe") != "yes" {
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Set-Cookie", "sid=leak")
		w.Header().Set("Server", "fake/1")
		_, _ = w.Write([]byte("hello AKIAIOSFODNN7EXAMPLE world"))
	}))
	defer srv.Close()
	p := newProbes(t, true, nil)
	o := runProbe(t, p.HTTP(), map[string]any{"url": srv.URL + "/health?token=secret", "headers": map[string]string{"X-Probe": "yes"}, "includeBody": true, "expectStatus": []int{200}})
	res := resultMap(t, o)
	if o.Status != agent.StatusSucceeded || res["ok"] != true || res["status"].(float64) != 200 {
		t.Fatalf("%+v", o)
	}
	sum := sha256.Sum256([]byte("hello AKIAIOSFODNN7EXAMPLE world"))
	if res["bodySha256"] != hex.EncodeToString(sum[:]) || res["bodyBytes"].(float64) != 32 {
		t.Fatalf("body digest/size: %v", res)
	}
	if strings.Contains(res["bodyPreview"].(string), "AKIAIOSFODNN7EXAMPLE") || !strings.Contains(res["bodyPreview"].(string), "REDACTED") {
		t.Fatalf("the preview must be redacted: %v", res["bodyPreview"])
	}
	if strings.Contains(res["url"].(string), "secret") || strings.Contains(res["url"].(string), "?") {
		t.Fatalf("the query string must not be echoed: %v", res["url"])
	}
	hdrs := res["headers"].(map[string]any)
	if _, ok := hdrs["set-cookie"]; ok || hdrs["server"] != "fake/1" {
		t.Fatalf("headers: %v", hdrs)
	}
	// expectStatus mismatch is an observation
	o = runProbe(t, p.HTTP(), map[string]any{"url": srv.URL, "expectStatus": []int{200}}) // no X-Probe => 400
	if r := resultMap(t, o); o.Status != agent.StatusSucceeded || r["ok"] != false || r["status"].(float64) != 400 {
		t.Fatalf("%+v", o)
	}
}

func TestProbeHTTPRedirectHandling(t *testing.T) {
	var target *httptest.Server
	target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("final")) }))
	defer target.Close()
	redirect := func(loc string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, loc, http.StatusFound) }))
	}
	p := newProbes(t, true, map[string][]netip.Addr{"rebind.example.com": {ip("169.254.169.254")}})

	toTarget := redirect(target.URL + "/x")
	defer toTarget.Close()
	o := runProbe(t, p.HTTP(), map[string]any{"url": toTarget.URL})
	if r := resultMap(t, o); r["status"].(float64) != 302 || r["headers"].(map[string]any)["location"] == nil {
		t.Fatalf("redirects are not followed unless asked: %+v", o)
	}
	o = runProbe(t, p.HTTP(), map[string]any{"url": toTarget.URL, "followRedirects": true})
	if r := resultMap(t, o); r["status"].(float64) != 200 || len(r["redirects"].([]any)) != 1 {
		t.Fatalf("%+v", o)
	}

	for _, loc := range []string{
		"http://169.254.169.254/latest/meta-data/", "http://metadata.google.internal/computeMetadata/v1/", "http://rebind.example.com/", "http://[fd00:ec2::254]/", "http://instance-data/latest",
	} {
		srv := redirect(loc)
		o := runProbe(t, p.HTTP(), map[string]any{"url": srv.URL, "followRedirects": true, "timeoutMs": 2000})
		srv.Close()
		if o.Status != agent.StatusRejected || !strings.Contains(o.Error, protocol.CodeGuardDenied) {
			t.Errorf("a redirect to %s must be refused: %+v", loc, o)
		}
	}

	loop := httptest.NewServer(nil)
	loop.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, loop.URL, http.StatusFound) })
	defer loop.Close()
	o = runProbe(t, p.HTTP(), map[string]any{"url": loop.URL, "followRedirects": true, "maxRedirects": 3, "timeoutMs": 3000})
	if r := resultMap(t, o); o.Status != agent.StatusSucceeded || r["ok"] != false {
		t.Fatalf("a redirect loop must terminate: %+v", o)
	}
}

func TestProbeHTTPTimeoutIsAnObservation(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-block }))
	defer srv.Close()
	defer close(block)
	p := newProbes(t, true, nil)
	start := time.Now()
	o := runProbe(t, p.HTTP(), map[string]any{"url": srv.URL, "timeoutMs": 300})
	if r := resultMap(t, o); o.Status != agent.StatusSucceeded || r["ok"] != false || r["errorCode"] != "timeout" {
		t.Fatalf("%+v", o)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the probe deadline was not honored")
	}
}

func TestProbeHTTPPayloadValidation(t *testing.T) {
	p := newProbes(t, true, nil)
	bad := map[string]map[string]any{
		"ftp scheme":       {"url": "ftp://example.com/"},
		"file scheme":      {"url": "file:///etc/passwd"},
		"userinfo":         {"url": "http://user:pw@example.com/"},
		"no host":          {"url": "http:///x"},
		"post method":      {"url": "http://example.com/", "method": "POST"},
		"host header":      {"url": "http://example.com/", "headers": map[string]string{"Host": "evil"}},
		"crlf header":      {"url": "http://example.com/", "headers": map[string]string{"X-A": "b\r\nX-B: c"}},
		"bad header name":  {"url": "http://example.com/", "headers": map[string]string{"X A": "b"}},
		"too many hops":    {"url": "http://example.com/", "maxRedirects": 9},
		"bad status":       {"url": "http://example.com/", "expectStatus": []int{99}},
		"unknown field":    {"url": "http://example.com/", "insecureSkipVerify": true},
		"missing url":      {},
		"host with spaces": {"url": "http://exa mple.com/"},
	}
	for name, pl := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := prepareProbe(t, p.HTTP(), pl); err == nil {
				t.Fatal("expected a rejection")
			}
		})
	}
	_, err := prepareProbe(t, p.TCP(), map[string]any{"host": "example.com", "port": 0})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	_, err = prepareProbe(t, p.TCP(), map[string]any{"host": "example.com", "port": 70000})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	_, err = prepareProbe(t, p.TCP(), map[string]any{"host": "example.com", "port": 80, "extra": 1})
	expectPrepareCode(t, err, protocol.CodeInvalidPayload)
}

func TestProbeTimeoutNeverExceedsJobTimeout(t *testing.T) {
	if got := probeTimeout(60_000, 2*time.Second); got != 2*time.Second {
		t.Fatal(got)
	}
	if got := probeTimeout(0, time.Minute); got != 10*time.Second {
		t.Fatal(got)
	}
}
