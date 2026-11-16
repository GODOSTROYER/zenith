package awsauth

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	suiteAccessKey = "AKIDEXAMPLE"
	suiteSecretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
)

var suiteTime = time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)

// parseReq parses the AWS test-suite .req format.
func parseReq(t *testing.T, raw string) (*Request, string) {
	t.Helper()
	head, body, _ := strings.Cut(raw, "\n\n")
	lines := strings.Split(head, "\n")
	first := lines[0]
	method, rest, _ := strings.Cut(first, " ")
	target := strings.TrimSuffix(rest, " HTTP/1.1")
	p, q, _ := strings.Cut(target, "?")
	req := &Request{Method: method, Path: p, Query: q, Header: http.Header{}, Body: []byte(body)}
	var lastName string
	token := ""
	for _, l := range lines[1:] {
		if l == "" {
			continue
		}
		if l[0] == ' ' || l[0] == '\t' { // obsolete line folding
			vals := req.Header[lastName]
			vals[len(vals)-1] += "\n" + l
			continue
		}
		name, val, _ := strings.Cut(l, ":")
		lastName = http.CanonicalHeaderKey(name)
		switch strings.ToLower(name) {
		case "host":
			req.Host = val
		case "x-amz-date":
			// set by Sign
		case "x-amz-security-token":
			token = val
		default:
			req.Header[lastName] = append(req.Header[lastName], val)
		}
	}
	return req, token
}

func TestAWSSigV4TestSuite(t *testing.T) {
	root := filepath.Join("testdata", "aws4_testsuite")
	var cases []string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".req") {
			cases = append(cases, strings.TrimSuffix(p, ".req"))
		}
		return nil
	})
	if len(cases) < 20 {
		t.Fatalf("expected the AWS suite cases, found %d", len(cases))
	}
	for _, base := range cases {
		t.Run(filepath.Base(base), func(t *testing.T) {
			read := func(ext string) string {
				b, err := os.ReadFile(base + ext)
				if err != nil {
					t.Fatal(err)
				}
				return strings.TrimRight(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
			}
			req, token := parseReq(t, read(".req"))
			if token == "" { // one case carries the token only in the canonical request
				for _, l := range strings.Split(read(".creq"), "\n") {
					if v, ok := strings.CutPrefix(l, "x-amz-security-token:"); ok {
						token = v
					}
				}
			}
			res, err := Sign(req, Credentials{AccessKeyID: suiteAccessKey, SecretAccessKey: suiteSecretKey, SessionToken: token}, Options{Service: "service", Region: "us-east-1", Time: suiteTime})
			if err != nil {
				t.Fatal(err)
			}
			if got, want := res.CanonicalRequest, read(".creq"); got != want {
				t.Errorf("canonical request mismatch\n got: %q\nwant: %q", got, want)
			}
			if got, want := res.StringToSign, read(".sts"); got != want {
				t.Errorf("string to sign mismatch\n got: %q\nwant: %q", got, want)
			}
			if got, want := res.Authorization, read(".authz"); got != want {
				t.Errorf("authorization mismatch\n got: %q\nwant: %q", got, want)
			}
		})
	}
}

// The worked example from the AWS documentation ("Signature Version 4 signing
// process" - IAM ListUsers): a GET with a query string, the case the task asks
// to be reproduced by hand.
func TestAWSDocsIAMListUsersExample(t *testing.T) {
	req := &Request{
		Method: "GET", Host: "iam.amazonaws.com", Path: "/", Query: "Action=ListUsers&Version=2010-05-08",
		Header: http.Header{"Content-Type": {"application/x-www-form-urlencoded; charset=utf-8"}},
	}
	res, err := Sign(req, Credentials{AccessKeyID: suiteAccessKey, SecretAccessKey: suiteSecretKey}, Options{Service: "iam", Region: "us-east-1", Time: suiteTime})
	if err != nil {
		t.Fatal(err)
	}
	if res.Signature != "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7" {
		t.Fatalf("signature %s does not match the documented example", res.Signature)
	}
	if !strings.HasPrefix(req.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=") {
		t.Fatalf("authorization: %s", req.Header.Get("Authorization"))
	}
}

type independentCase struct {
	Name          string            `json:"name"`
	Method        string            `json:"method"`
	Host          string            `json:"host"`
	Path          string            `json:"path"`
	Query         string            `json:"query"`
	Headers       map[string]string `json:"headers"`
	Body          string            `json:"body"`
	Service       string            `json:"service"`
	Region        string            `json:"region"`
	Time          string            `json:"time"`
	S3            bool              `json:"s3"`
	SessionToken  string            `json:"sessionToken"`
	Canonical     string            `json:"canonicalRequest"`
	StringToSign  string            `json:"stringToSign"`
	Signature     string            `json:"signature"`
	Authorization string            `json:"authorization"`
}

// Cases the public suite does not cover (JSON protocol POST, query protocol
// POST with a session token, REST GET with an encoded path, S3), with expected
// values computed by an independent Python implementation (sigv4_reference.py).
func TestIndependentReferenceVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "independent-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []independentCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 5 {
		t.Fatalf("expected at least 5 cases, got %d", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			ts, err := time.Parse("20060102T150405Z", c.Time)
			if err != nil {
				t.Fatal(err)
			}
			h := http.Header{}
			for k, v := range c.Headers {
				h.Set(k, v)
			}
			req := &Request{Method: c.Method, Host: c.Host, Path: c.Path, Query: c.Query, Header: h, Body: []byte(c.Body)}
			res, err := Sign(req, Credentials{AccessKeyID: suiteAccessKey, SecretAccessKey: suiteSecretKey, SessionToken: c.SessionToken}, Options{Service: c.Service, Region: c.Region, Time: ts, S3Style: c.S3})
			if err != nil {
				t.Fatal(err)
			}
			if res.CanonicalRequest != c.Canonical {
				t.Errorf("canonical request mismatch\n got: %q\nwant: %q", res.CanonicalRequest, c.Canonical)
			}
			if res.StringToSign != c.StringToSign {
				t.Errorf("string to sign mismatch\n got: %q\nwant: %q", res.StringToSign, c.StringToSign)
			}
			if res.Signature != c.Signature || res.Authorization != c.Authorization {
				t.Errorf("signature mismatch\n got: %s\nwant: %s", res.Authorization, c.Authorization)
			}
		})
	}
}

func TestSignReplacesCallerSuppliedAuthHeaders(t *testing.T) {
	req := &Request{
		Method: "GET", Host: "sts.amazonaws.com", Path: "/", Query: "Action=GetCallerIdentity&Version=2011-06-15",
		Header: http.Header{
			"Authorization":        {"AWS4-HMAC-SHA256 Credential=EVIL/..."},
			"X-Amz-Security-Token": {"evil-token"},
			"X-Amz-Date":           {"19700101T000000Z"},
		},
	}
	res, err := Sign(req, Credentials{AccessKeyID: "AKIALOCAL", SecretAccessKey: "secret"}, Options{Service: "sts", Region: "us-east-1", Time: suiteTime})
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("Authorization"); !strings.Contains(got, "Credential=AKIALOCAL/") || strings.Contains(got, "EVIL") {
		t.Fatalf("authorization was not replaced: %s", got)
	}
	if req.Header.Get("X-Amz-Security-Token") != "" {
		t.Fatal("a caller-supplied session token must not survive when the local credentials have none")
	}
	if req.Header.Get("X-Amz-Date") != "20150830T123600Z" {
		t.Fatal("X-Amz-Date must be the signing time")
	}
	if strings.Contains(res.SignedHeaders, "authorization") {
		t.Fatal("authorization must never be a signed header")
	}
}

func TestCredentialsNeverFormat(t *testing.T) {
	c := Credentials{AccessKeyID: "AKIAEXAMPLE1234567890", SecretAccessKey: "topsecret/value", SessionToken: "tok", Source: "env"}
	for _, s := range []string{c.String(), c.GoString()} {
		if strings.Contains(s, "AKIA") || strings.Contains(s, "topsecret") || strings.Contains(s, "tok") && !strings.Contains(s, "redacted") {
			t.Fatalf("credentials leaked through formatting: %s", s)
		}
	}
}

func TestSignRequiresScopeAndCredentials(t *testing.T) {
	req := &Request{Method: "GET", Host: "x.amazonaws.com"}
	if _, err := Sign(req, Credentials{}, Options{Service: "s", Region: "r", Time: suiteTime}); err == nil {
		t.Fatal("incomplete credentials must fail")
	}
	if _, err := Sign(req, Credentials{AccessKeyID: "a", SecretAccessKey: "b"}, Options{Time: suiteTime}); err == nil {
		t.Fatal("missing service/region must fail")
	}
}
