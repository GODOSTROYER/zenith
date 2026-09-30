package kinds

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/awsauth"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

const (
	testAKID   = "AKIDLOCALRUNNER0001"
	testSecret = "localRunnerSecretAccessKey/0123456789abcdef"
	testToken  = "local-session-token-value"
)

type staticCreds struct {
	c   awsauth.Credentials
	err error
}

func (s staticCreds) Retrieve(context.Context) (awsauth.Credentials, error) { return s.c, s.err }

// received is what the fake AWS endpoint saw.
type received struct {
	mu   sync.Mutex
	reqs []*capturedReq
}

type capturedReq struct {
	Method, Host, Path, Query string
	Header                    http.Header
	Body                      []byte
}

func (r *received) last() *capturedReq {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.reqs) == 0 {
		return nil
	}
	return r.reqs[len(r.reqs)-1]
}

func (r *received) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.reqs)
}

// verifySigV4 recomputes the signature of a received request with the local
// credentials and compares it to the Authorization header: an independent
// check that the runner signed exactly the request it sent.
func verifySigV4(t *testing.T, c *capturedReq, creds awsauth.Credentials, s3 bool) {
	t.Helper()
	auth := c.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 ") {
		t.Errorf("request is not SigV4 signed: %q", auth)
		return
	}
	var credential, signedHeaders string
	for _, part := range strings.Split(strings.TrimPrefix(auth, "AWS4-HMAC-SHA256 "), ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "Credential="); ok {
			credential = v
		}
		if v, ok := strings.CutPrefix(part, "SignedHeaders="); ok {
			signedHeaders = v
		}
	}
	scope := strings.Split(credential, "/")
	if len(scope) != 5 || scope[0] != creds.AccessKeyID {
		t.Errorf("credential scope %q does not use the local access key", credential)
		return
	}
	region, service := scope[2], scope[3]
	when, err := time.Parse("20060102T150405Z", c.Header.Get("X-Amz-Date"))
	if err != nil {
		t.Errorf("X-Amz-Date: %v", err)
		return
	}
	h := http.Header{}
	for _, name := range strings.Split(signedHeaders, ";") {
		if name == "host" {
			continue
		}
		h[http.CanonicalHeaderKey(name)] = c.Header.Values(name)
	}
	req := &awsauth.Request{Method: c.Method, Host: c.Host, Path: c.Path, Query: c.Query, Header: h, Body: c.Body}
	res, err := awsauth.Sign(req, creds, awsauth.Options{Service: service, Region: region, Time: when, S3Style: s3})
	if err != nil {
		t.Errorf("re-sign: %v", err)
		return
	}
	if req.Header.Get("Authorization") != auth {
		t.Errorf("the signature does not verify\n sent: %s\n want: %s", auth, res.Authorization)
	}
}

type awsHarness struct {
	t     *testing.T
	kind  *AWS
	seen  *received
	srv   *httptest.Server
	creds awsauth.Credentials
}

func newAWSHarness(t *testing.T, cfg AWSConfig, handler func(w http.ResponseWriter, r *http.Request)) *awsHarness {
	t.Helper()
	h := &awsHarness{t: t, seen: &received{}, creds: awsauth.Credentials{AccessKeyID: testAKID, SecretAccessKey: testSecret, SessionToken: testToken}}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		h.seen.mu.Lock()
		h.seen.reqs = append(h.seen.reqs, &capturedReq{Method: r.Method, Host: r.Host, Path: r.URL.EscapedPath(), Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: body})
		h.seen.mu.Unlock()
		if handler != nil {
			handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/x-amz-json-1.0")
		w.Header().Set("x-amzn-RequestId", "req-123")
		w.Header().Set("Set-Cookie", "session=leak")
		w.Header().Set("X-Internal-Debug", "leak")
		_, _ = w.Write([]byte(`{"TableNames":["a","b"]}`))
	}))
	t.Cleanup(h.srv.Close)
	cfg.EndpointOverride = h.srv.URL
	k, err := NewAWS(cfg, AWSDeps{Creds: staticCreds{c: h.creds}, Now: func() time.Time { return time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC) }})
	if err != nil {
		t.Fatal(err)
	}
	h.kind = k
	return h
}

var defaultAWSAllow = map[string][]string{
	"infrastructure.observe": {"dynamodb:ListTables", "dynamodb:Describe*", "ec2:Describe*", "s3:GET /bucket/**", "s3:HEAD /bucket/**", "lambda:GET /2015-03-31/functions/*/configuration"},
	"deployment.deploy":      {"ec2:RunInstances", "s3:PUT /bucket/*"},
}

func (h *awsHarness) prepare(capability string, pl map[string]any, maxOut int64) (Runnable, error) {
	raw, _ := json.Marshal(pl)
	if maxOut == 0 {
		maxOut = 1 << 20
	}
	return h.kind.Prepare(&Request{JTI: "job_a", Capability: capability, Payload: raw, Timeout: 10 * time.Second, MaxOutputBytes: maxOut})
}

func (h *awsHarness) run(capability string, pl map[string]any) Outcome {
	h.t.Helper()
	run, err := h.prepare(capability, pl, 0)
	if err != nil {
		h.t.Fatalf("prepare: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return run(ctx, agent.DiscardSink{})
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func ddbListTables() map[string]any {
	return map[string]any{
		"service": "dynamodb", "region": "us-west-2", "method": "POST", "url": "https://dynamodb.us-west-2.amazonaws.com/",
		"headers": map[string]any{"Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": "DynamoDB_20120810.ListTables"},
		"bodyB64": b64("{}"),
	}
}

func TestAWSSignsWithLocalCredentialsAndReturnsAllowlistedResponse(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	o := h.run("infrastructure.observe", ddbListTables())
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	res := resultMap(t, o)
	if res["status"].(float64) != 200 {
		t.Fatalf("%v", res)
	}
	body, _ := base64.StdEncoding.DecodeString(res["bodyB64"].(string))
	if string(body) != `{"TableNames":["a","b"]}` {
		t.Fatalf("body: %s", body)
	}
	hdrs := res["headers"].(map[string]any)
	if hdrs["x-amzn-requestid"] != "req-123" || hdrs["content-type"] != "application/x-amz-json-1.0" {
		t.Fatalf("headers: %v", hdrs)
	}
	if _, leaked := hdrs["set-cookie"]; leaked {
		t.Fatal("set-cookie must not be returned")
	}
	if _, leaked := hdrs["x-internal-debug"]; leaked {
		t.Fatal("only allowlisted response headers are returned")
	}
	raw, _ := json.Marshal(o)
	for _, secret := range []string{testAKID, testSecret, testToken} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("credentials leaked into the result: %s", raw)
		}
	}
	seen := h.seen.last()
	if seen.Header.Get("X-Amz-Security-Token") != testToken {
		t.Fatal("the local session token must be sent")
	}
	if seen.Host != "dynamodb.us-west-2.amazonaws.com" {
		t.Fatalf("the signed Host must be the AWS host even when the connection goes elsewhere, got %q", seen.Host)
	}
	verifySigV4(t, seen, h.creds, false)
}

func TestAWSStripsCallerSuppliedAuthenticationHeaders(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	pl := ddbListTables()
	hdrs := pl["headers"].(map[string]any)
	hdrs["Authorization"] = "AWS4-HMAC-SHA256 Credential=AKIAEVIL0000000000/20260930/us-west-2/dynamodb/aws4_request, SignedHeaders=host, Signature=00"
	hdrs["X-Amz-Security-Token"] = "evil-token"
	hdrs["X-Amz-Date"] = "19700101T000000Z"
	hdrs["Cookie"] = "steal=1"
	hdrs["Host"] = "evil.example.com"
	hdrs["X-Amz-Content-Sha256"] = "deadbeef"
	hdrs["User-Agent"] = "attacker"
	o := h.run("infrastructure.observe", pl)
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	seen := h.seen.last()
	if strings.Contains(seen.Header.Get("Authorization"), "EVIL") {
		t.Fatal("a caller-supplied Authorization must be replaced")
	}
	if seen.Header.Get("X-Amz-Security-Token") != testToken {
		t.Fatal("a caller-supplied session token must be replaced by the local one")
	}
	if seen.Header.Get("X-Amz-Date") != "20260930T120000Z" {
		t.Fatalf("X-Amz-Date must be the signing time, got %q", seen.Header.Get("X-Amz-Date"))
	}
	if seen.Header.Get("Cookie") != "" || seen.Host != "dynamodb.us-west-2.amazonaws.com" || seen.Header.Get("User-Agent") == "attacker" {
		t.Fatalf("cookie, host and user-agent overrides must be dropped: %v host=%s", seen.Header, seen.Host)
	}
	verifySigV4(t, seen, h.creds, false)
}

func TestAWSQueryProtocolActionAllowlist(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	form := func(action string) map[string]any {
		return map[string]any{
			"service": "ec2", "region": "eu-west-1", "method": "POST", "url": "https://ec2.eu-west-1.amazonaws.com/",
			"headers": map[string]any{"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
			"bodyB64": b64("Action=" + action + "&Version=2016-11-15"),
		}
	}
	if o := h.run("infrastructure.observe", form("DescribeInstances")); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	verifySigV4(t, h.seen.last(), h.creds, false)
	_, err := h.prepare("infrastructure.observe", form("TerminateInstances"), 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
	_, err = h.prepare("deployment.deploy", form("DescribeInstances"), 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed) // wildcard belongs to the observe capability only
	if o := h.run("deployment.deploy", form("RunInstances")); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	// GET-style query protocol: Action in the URL
	get := map[string]any{"service": "ec2", "region": "eu-west-1", "method": "GET", "url": "https://ec2.eu-west-1.amazonaws.com/?Action=DescribeVpcs&Version=2016-11-15"}
	if o := h.run("infrastructure.observe", get); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	verifySigV4(t, h.seen.last(), h.creds, false)
	get["url"] = "https://ec2.eu-west-1.amazonaws.com/?Action=DeleteVpc&Version=2016-11-15"
	_, err = h.prepare("infrastructure.observe", get, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
}

func TestAWSActionSmugglingIsRefused(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	base := func() map[string]any {
		return map[string]any{"service": "ec2", "region": "eu-west-1", "method": "POST", "url": "https://ec2.eu-west-1.amazonaws.com/",
			"headers": map[string]any{"Content-Type": "application/x-www-form-urlencoded"}, "bodyB64": b64("Action=DescribeInstances")}
	}
	mut := map[string]func(p map[string]any){
		"target plus Action": func(p map[string]any) { p["headers"].(map[string]any)["X-Amz-Target"] = "Foo_1.DescribeInstances" },
		"two Action params in the body": func(p map[string]any) {
			p["bodyB64"] = b64("Action=DescribeInstances&Action=TerminateInstances")
		},
		"Action in query and body": func(p map[string]any) {
			p["url"] = "https://ec2.eu-west-1.amazonaws.com/?Action=TerminateInstances"
		},
		"lower-case action": func(p map[string]any) { p["bodyB64"] = b64("action=TerminateInstances&Action=DescribeInstances") },
		"malformed action":  func(p map[string]any) { p["bodyB64"] = b64("Action=Describe%0AInstances") },
	}
	for name, f := range mut {
		t.Run(name, func(t *testing.T) {
			p := base()
			f(p)
			_, err := h.prepare("infrastructure.observe", p, 0)
			expectPrepareCode(t, err, protocol.CodeNotAllowed)
		})
	}
	if h.seen.count() != 0 {
		t.Fatal("nothing may be sent when validation fails")
	}
}

func TestAWSRESTMethodAndPathAllowlist(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	s3 := func(method, path string) map[string]any {
		return map[string]any{"service": "s3", "region": "us-east-1", "method": method, "url": "https://bucket.s3.amazonaws.com" + path}
	}
	if o := h.run("infrastructure.observe", s3("GET", "/bucket/dir/my%20key.txt?versionId=1")); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	seen := h.seen.last()
	if seen.Header.Get("X-Amz-Content-Sha256") == "" {
		t.Fatal("S3 requests carry x-amz-content-sha256")
	}
	verifySigV4(t, seen, h.creds, true)

	for name, req := range map[string]map[string]any{
		"another bucket":       s3("GET", "/other/key"),
		"write with read cap":  s3("PUT", "/bucket/key"),
		"delete":               s3("DELETE", "/bucket/key"),
		"dot segments":         s3("GET", "/bucket/../other/key"),
		"encoded dot segments": s3("GET", "/bucket/%2e%2e/other"),
		"listing all buckets":  s3("GET", "/"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := h.prepare("infrastructure.observe", req, 0)
			expectPrepareCode(t, err, protocol.CodeNotAllowed)
		})
	}
	// deploy capability may PUT exactly one segment under /bucket/
	if _, err := h.prepare("deployment.deploy", s3("PUT", "/bucket/key"), 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.prepare("deployment.deploy", s3("PUT", "/bucket/dir/key"), 0); err == nil {
		t.Fatal("'*' matches one segment only")
	}
	// segment wildcard in the middle
	lam := map[string]any{"service": "lambda", "region": "us-east-1", "method": "GET", "url": "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/my-fn/configuration"}
	if o := h.run("infrastructure.observe", lam); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	verifySigV4(t, h.seen.last(), h.creds, false)
	lam["url"] = "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/my-fn/invocations"
	_, err := h.prepare("infrastructure.observe", lam, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
}

func TestAWSDefaultDeny(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	_, err := h.prepare("logs.read", ddbListTables(), 0) // capability with no entry
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
	empty := newAWSHarness(t, AWSConfig{}, nil)
	_, err = empty.prepare("infrastructure.observe", ddbListTables(), 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
}

func TestAWSHostAllowlist(t *testing.T) {
	ok := []string{
		"sts.amazonaws.com", "s3.us-east-1.amazonaws.com", "bucket.s3.amazonaws.com", "a.b.c.amazonaws.com",
		"ec2.cn-north-1.amazonaws.com.cn", "sts.cn-north-1.amazonaws.com.cn", "bedrock-runtime.us-east-1.api.aws", "x.api.aws", "s3-fips.us-gov-west-1.amazonaws.com",
	}
	bad := []string{
		"evil.amazonaws.com.attacker.com", "amazonaws.com", "api.aws", "s3.amazonaws.com.evil.com", "attacker.com", "evil-amazonaws.com",
		"xamazonaws.com", "amazonaws.com.evil.com", "sts.amazonaws.com.", "sts.amazonaws.co", "sts.amazonaws.com.cn.evil.com", "127.0.0.1",
		"localhost", "sts_amazonaws.com", "-x.amazonaws.com", "xn--mazonaws-w5b.com", "аmazonaws.com", "sts.amazonaws.com%2eevil.com", "sts.amazonaws.com\\.evil.com",
		"", "*.amazonaws.com", "sts.amazonaws.com:443", "metadata.google.internal", "169.254.169.254",
	}
	for _, host := range ok {
		if !AWSHostAllowed(host) {
			t.Errorf("%q should be allowed", host)
		}
	}
	for _, host := range bad {
		if AWSHostAllowed(host) {
			t.Errorf("%q must be rejected", host)
		}
	}
}

func TestAWSURLValidation(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: map[string][]string{"infrastructure.observe": {"sts:GetCallerIdentity", "s3:GET /**"}}}, nil)
	mk := func(u string) map[string]any {
		return map[string]any{"service": "sts", "region": "us-east-1", "method": "GET", "url": u}
	}
	good := "https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
	if _, err := h.prepare("infrastructure.observe", mk(good), 0); err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{
		"https://sts.amazonaws.com:443/?Action=GetCallerIdentity", // explicit default port is fine
		"https://STS.AMAZONAWS.COM/?Action=GetCallerIdentity",
	} {
		if _, err := h.prepare("infrastructure.observe", mk(u), 0); err != nil {
			t.Errorf("%s should be accepted: %v", u, err)
		}
	}
	bad := map[string]string{
		"plain http":               "http://sts.amazonaws.com/?Action=GetCallerIdentity",
		"look-alike suffix":        "https://sts.amazonaws.com.attacker.com/?Action=GetCallerIdentity",
		"userinfo trick":           "https://sts.amazonaws.com@evil.example.com/?Action=GetCallerIdentity",
		"userinfo on aws host":     "https://user:pw@sts.amazonaws.com/?Action=GetCallerIdentity",
		"backslash":                "https://evil.example.com\\.amazonaws.com/?Action=GetCallerIdentity",
		"fragment host trick":      "https://evil.example.com#.amazonaws.com/?Action=GetCallerIdentity",
		"query host trick":         "https://evil.example.com?.amazonaws.com/Action=GetCallerIdentity",
		"non-443 port":             "https://sts.amazonaws.com:8443/?Action=GetCallerIdentity",
		"ip literal":               "https://169.254.169.254/?Action=GetCallerIdentity",
		"metadata host":            "https://metadata.google.internal/?Action=GetCallerIdentity",
		"presigned signature":      "https://sts.amazonaws.com/?Action=GetCallerIdentity&X-Amz-Signature=abc",
		"presigned credential":     "https://sts.amazonaws.com/?Action=GetCallerIdentity&X-Amz-Credential=abc",
		"presigned token (case)":   "https://sts.amazonaws.com/?Action=GetCallerIdentity&x-amz-security-token=abc",
		"fragment":                 "https://sts.amazonaws.com/?Action=GetCallerIdentity#frag",
		"relative":                 "/?Action=GetCallerIdentity",
		"empty":                    "",
		"non-ascii host":           "https://sts.amazоnaws.com/?Action=GetCallerIdentity",
		"opaque":                   "https:sts.amazonaws.com",
		"wildcard host":            "https://*.amazonaws.com/?Action=GetCallerIdentity",
		"host with trailing dot":   "https://sts.amazonaws.com./?Action=GetCallerIdentity",
		"scheme-relative":          "//sts.amazonaws.com/?Action=GetCallerIdentity",
		"javascript scheme":        "javascript://sts.amazonaws.com/%0aalert(1)",
		"file scheme":              "file:///etc/passwd",
		"ftp":                      "ftp://sts.amazonaws.com/",
		"double slash host escape": "https://sts.amazonaws.com//evil.com/",
	}
	for name, u := range bad {
		t.Run(name, func(t *testing.T) {
			_, err := h.prepare("infrastructure.observe", mk(u), 0)
			if err == nil {
				t.Fatalf("%q must be rejected", u)
			}
		})
	}
	if h.seen.count() != 0 {
		t.Fatal("no request may be sent")
	}
}

func TestAWSPayloadValidation(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	mut := map[string]func(p map[string]any){
		"unknown field":         func(p map[string]any) { p["proxy"] = "http://evil" },
		"bad service":           func(p map[string]any) { p["service"] = "Dynamo DB" },
		"bad region":            func(p map[string]any) { p["region"] = "us west" },
		"bad method":            func(p map[string]any) { p["method"] = "TRACE" },
		"bad base64":            func(p map[string]any) { p["bodyB64"] = "!!!" },
		"CRLF in header":        func(p map[string]any) { p["headers"].(map[string]any)["X-Foo"] = "a\r\nInjected: 1" },
		"bad header name":       func(p map[string]any) { p["headers"].(map[string]any)["X Foo"] = "a" },
		"non-string header":     func(p map[string]any) { p["headers"].(map[string]any)["X-Foo"] = 5 },
		"missing service":       func(p map[string]any) { delete(p, "service") },
		"target without dot":    func(p map[string]any) { p["headers"].(map[string]any)["X-Amz-Target"] = "ListTables" },
		"target bad action":     func(p map[string]any) { p["headers"].(map[string]any)["X-Amz-Target"] = "P.List Tables" },
		"target trailing dot":   func(p map[string]any) { p["headers"].(map[string]any)["X-Amz-Target"] = "P." },
		"target leading dot":    func(p map[string]any) { p["headers"].(map[string]any)["X-Amz-Target"] = ".ListTables" },
		"oversized body":        func(p map[string]any) { p["bodyB64"] = strings.Repeat("A", 12<<20) },
		"payload not an object": nil,
	}
	for name, f := range mut {
		t.Run(name, func(t *testing.T) {
			if f == nil {
				_, err := h.kind.Prepare(&Request{Capability: "infrastructure.observe", Payload: json.RawMessage(`[1,2]`), MaxOutputBytes: 1 << 20})
				expectPrepareCode(t, err, protocol.CodeInvalidPayload)
				return
			}
			p := ddbListTables()
			f(p)
			if _, err := h.prepare("infrastructure.observe", p, 0); err == nil {
				t.Fatal("expected a rejection")
			}
		})
	}
	// header value arrays are accepted and joined
	p := ddbListTables()
	p["headers"].(map[string]any)["X-Multi"] = []string{"a", "b"}
	if o := h.run("infrastructure.observe", p); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	verifySigV4(t, h.seen.last(), h.creds, false)
	if got := h.seen.last().Header.Values("X-Multi"); len(got) != 2 {
		t.Fatalf("multi-value header lost: %v", got)
	}
}

func TestAWSErrorResponsesAreObservationsNotJobFailures(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-amzn-ErrorType", "AccessDeniedException")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"__type":"AccessDeniedException","message":"denied"}`))
	})
	o := h.run("infrastructure.observe", ddbListTables())
	if o.Status != agent.StatusSucceeded || resultMap(t, o)["status"].(float64) != 400 {
		t.Fatalf("%+v", o)
	}
}

func TestAWSResponseTooLargeIsFailedNotTruncated(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 5000)))
	})
	run, err := h.prepare("infrastructure.observe", ddbListTables(), 1000)
	if err != nil {
		t.Fatal(err)
	}
	o := run(context.Background(), agent.DiscardSink{})
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "response_too_large") {
		t.Fatalf("%+v", o)
	}
	res := resultMap(t, o)
	if res["truncated"] != true || res["bodyB64"] != nil {
		t.Fatalf("a too-large response must not return a partial body: %v", res)
	}
}

func TestAWSCredentialFailureAndTimeout(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, nil)
	h.kind.creds = staticCreds{err: errors.New("STS said no; token=zrt_supersecret12345")}
	run, _ := h.prepare("infrastructure.observe", ddbListTables(), 0)
	o := run(context.Background(), agent.DiscardSink{})
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "aws_credentials_unavailable") {
		t.Fatalf("%+v", o)
	}
	if strings.Contains(o.Error, "zrt_supersecret12345") {
		t.Fatal("error text must be redacted")
	}

	slow := newAWSHarness(t, AWSConfig{Allow: defaultAWSAllow}, func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	})
	run, _ = slow.prepare("infrastructure.observe", ddbListTables(), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	o = run(ctx, agent.DiscardSink{})
	if o.Status != agent.StatusTimedOut {
		t.Fatalf("%+v", o)
	}
}

func TestAWSAllowlistParsing(t *testing.T) {
	good := [][]string{
		{"ec2:Describe*"}, {"ec2:*"}, {"dynamodb:ListTables"}, {"s3:GET /bucket/**"}, {"s3:GET /*/x/*"}, {"execute-api:POST /prod/pets"}, {"s3:GET /"}, {"sts:GetCallerIdentity"},
	}
	for _, g := range good {
		if _, err := ParseRules(g); err != nil {
			t.Errorf("%v should parse: %v", g, err)
		}
	}
	bad := [][]string{
		{"*:*"}, {"*:Describe*"}, {"ec2:Desc*ribe"}, {"ec2:*Instances"}, {"ec2:"}, {":Describe"}, {"Describe*"}, {"ec2 Describe*"}, {"EC2:Describe*"},
		{"s3:FETCH /x"}, {"s3:GET x"}, {"s3:GET /a/**/b"}, {"s3:GET /a*/b"}, {"s3:GET /a/../b"}, {"s3:GET /a/./b"}, {"s3:get /x"}, {"ec2:Describe Instances"},
		{"ec2:Describe.*"}, {""},
	}
	for _, b := range bad {
		if _, err := ParseRules(b); err == nil {
			t.Errorf("%v must be rejected", b)
		}
	}
	if _, err := NewAWS(AWSConfig{Allow: map[string][]string{"infrastructure.observe": {"ec2:*:*"}}}, AWSDeps{Creds: staticCreds{}}); err == nil {
		t.Fatal("a bad allowlist must fail at startup")
	}
}

func TestExtractActionTable(t *testing.T) {
	mk := func(method, rawurl, ct, target, body string) (Action, error) {
		u, _ := url.Parse(rawurl)
		h := http.Header{}
		if ct != "" {
			h.Set("Content-Type", ct)
		}
		if target != "" {
			h.Set("X-Amz-Target", target)
		}
		return ExtractAction("svc", method, u, h, []byte(body))
	}
	form := "application/x-www-form-urlencoded"
	cases := []struct {
		name         string
		got          func() (Action, error)
		proto, wants string
		fail         bool
	}{
		{"json", func() (Action, error) {
			return mk("POST", "https://x/", "application/x-amz-json-1.1", "AmazonSSM.GetParameter", "{}")
		}, "json", "GetParameter", false},
		{"json with version prefix", func() (Action, error) { return mk("POST", "https://x/", "", "Logs_20140328.FilterLogEvents", "{}") }, "json", "FilterLogEvents", false},
		{"query in body", func() (Action, error) {
			return mk("POST", "https://x/", form, "", "Action=DescribeInstances&Version=1")
		}, "query", "DescribeInstances", false},
		{"query in url", func() (Action, error) { return mk("GET", "https://x/?Version=1&Action=ListUsers", "", "", "") }, "query", "ListUsers", false},
		{"rest", func() (Action, error) { return mk("GET", "https://x/a/b%20c", "", "", "") }, "rest", "GET /a/b c", false},
		{"json body mentioning Action= is not a form", func() (Action, error) {
			return mk("PUT", "https://x/things", "application/json", "", "Action=Delete")
		}, "rest", "PUT /things", false},
		{"body Action ignored without form content type stays REST", func() (Action, error) { return mk("POST", "https://x/", "", "", "Action=Evil") }, "rest", "POST /", false},
		{"both", func() (Action, error) { return mk("POST", "https://x/?Action=A", form, "P.B", "") }, "", "", true},
		{"duplicate", func() (Action, error) { return mk("POST", "https://x/?Action=A&Action=A", "", "", "") }, "", "", true},
		{"case variant", func() (Action, error) { return mk("GET", "https://x/?ACTION=A", "", "", "") }, "", "", true},
		{"dot segment", func() (Action, error) { return mk("GET", "https://x/a/../b", "", "", "") }, "", "", true},
		{"malformed form", func() (Action, error) { return mk("POST", "https://x/", form, "", "Action=%zz") }, "", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, err := c.got()
			if c.fail {
				if err == nil {
					t.Fatalf("expected an error, got %+v", a)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if a.Protocol != c.proto || a.Name != c.wants {
				t.Fatalf("got %s %q, want %s %q", a.Protocol, a.Name, c.proto, c.wants)
			}
		})
	}
}

// A REST service routes on method and path and ignores unknown parameters. If
// the runner believed an Action parameter there, a caller could be authorized
// for ListHostedZones while Route 53 executes the POST to /hostedzone
// (CreateHostedZone). RPC-style claims are only believed on RPC-shaped requests.
func TestExtractActionDoesNotBelieveRPCClaimsOnRESTShapedRequests(t *testing.T) {
	mk := func(service, method, rawurl, ct, target, body string) error {
		u, _ := url.Parse(rawurl)
		h := http.Header{}
		if ct != "" {
			h.Set("Content-Type", ct)
		}
		if target != "" {
			h.Add("X-Amz-Target", target)
		}
		_, err := ExtractAction(service, method, u, h, []byte(body))
		return err
	}
	form := "application/x-www-form-urlencoded"
	rejected := map[string]error{
		"route53 create with a fake Action":      mk("route53", "POST", "https://route53.amazonaws.com/2013-04-01/hostedzone", form, "", "Action=ListHostedZones"),
		"route53 at root with a fake Action":     mk("route53", "POST", "https://route53.amazonaws.com/", form, "", "Action=ListHostedZones"),
		"s3 bucket delete with a fake Action":    mk("s3", "GET", "https://b.s3.amazonaws.com/?Action=ListThings", "", "", ""),
		"lambda with a fake target":              mk("lambda", "POST", "https://lambda.us-east-1.amazonaws.com/", "", "Foo_1.ListFunctions", "{}"),
		"unknown service, resource path, Action": mk("quux", "POST", "https://quux.amazonaws.com/things/123", form, "", "Action=Describe"),
		"JSON claim over GET":                    mk("dynamodb", "GET", "https://dynamodb.us-east-1.amazonaws.com/", "", "DynamoDB_20120810.ListTables", ""),
		"JSON claim over DELETE":                 mk("dynamodb", "DELETE", "https://dynamodb.us-east-1.amazonaws.com/", "", "DynamoDB_20120810.ListTables", ""),
		"JSON claim on a resource path":          mk("dynamodb", "POST", "https://dynamodb.us-east-1.amazonaws.com/tables/x", "", "DynamoDB_20120810.ListTables", "{}"),
		"query claim over PUT":                   mk("ec2", "PUT", "https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs", "", "", ""),
		"query claim over DELETE":                mk("ec2", "DELETE", "https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs", "", "", ""),
		"query claim on a resource path":         mk("ec2", "GET", "https://ec2.us-east-1.amazonaws.com/vpcs?Action=DescribeVpcs", "", "", ""),
		"sqs-shaped path on another service":     mk("sns", "POST", "https://sns.us-east-1.amazonaws.com/123456789012/queue", form, "", "Action=Publish"),
		"sqs path with a bad account":            mk("sqs", "POST", "https://sqs.us-east-1.amazonaws.com/12345/queue", form, "", "Action=SendMessage"),
		"two X-Amz-Target headers": func() error {
			u, _ := url.Parse("https://x.amazonaws.com/")
			h := http.Header{}
			h.Add("X-Amz-Target", "A_1.Read")
			h.Add("X-Amz-Target", "A_1.Delete")
			_, err := ExtractAction("x", "POST", u, h, nil)
			return err
		}(),
	}
	for name, err := range rejected {
		if err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
	accepted := map[string]error{
		"ec2 query over POST":            mk("ec2", "POST", "https://ec2.us-east-1.amazonaws.com/", form, "", "Action=DescribeVpcs"),
		"ec2 query over GET":             mk("ec2", "GET", "https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs", "", "", ""),
		"dynamodb JSON":                  mk("dynamodb", "POST", "https://dynamodb.us-east-1.amazonaws.com/", "", "DynamoDB_20120810.ListTables", "{}"),
		"dynamodb JSON with empty path":  mk("dynamodb", "POST", "https://dynamodb.us-east-1.amazonaws.com", "", "DynamoDB_20120810.ListTables", "{}"),
		"sqs queue operation":            mk("sqs", "POST", "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue", form, "", "Action=SendMessage"),
		"sqs fifo queue operation":       mk("sqs", "POST", "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue.fifo", form, "", "Action=SendMessage"),
		"s3 REST without any claim":      mk("s3", "GET", "https://b.s3.amazonaws.com/key", "", "", ""),
		"route53 REST without any claim": mk("route53", "GET", "https://route53.amazonaws.com/2013-04-01/hostedzone", "", "", ""),
	}
	for name, err := range accepted {
		if err != nil {
			t.Errorf("%s should be accepted: %v", name, err)
		}
	}
}

func TestAWSRoute53ConfusedDeputyIsRefusedEndToEnd(t *testing.T) {
	h := newAWSHarness(t, AWSConfig{Allow: map[string][]string{
		"infrastructure.observe": {"route53:ListHostedZones", "route53:GET /2013-04-01/hostedzone"},
	}}, nil)
	attack := map[string]any{
		"service": "route53", "region": "us-east-1", "method": "POST", "url": "https://route53.amazonaws.com/2013-04-01/hostedzone",
		"headers": map[string]any{"Content-Type": "application/x-www-form-urlencoded"}, "bodyB64": b64("Action=ListHostedZones"),
	}
	_, err := h.prepare("infrastructure.observe", attack, 0)
	expectPrepareCode(t, err, protocol.CodeNotAllowed)
	// the honest REST form of the read is what the allowlist authorizes
	good := map[string]any{"service": "route53", "region": "us-east-1", "method": "GET", "url": "https://route53.amazonaws.com/2013-04-01/hostedzone"}
	if o := h.run("infrastructure.observe", good); o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	if h.seen.count() != 1 {
		t.Fatalf("only the honest request may have been sent, saw %d", h.seen.count())
	}
}
