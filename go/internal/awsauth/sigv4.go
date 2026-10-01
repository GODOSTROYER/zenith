// Package awsauth implements AWS Signature Version 4 request signing and the
// local credential chain the runner's aws.http kind uses. It depends only on
// the standard library; the signer is verified against the official AWS
// Signature V4 test suite (see testdata/aws4_testsuite).
//
// Credentials handled here exist only in the runner's memory and are never
// logged, returned or put in any result: Credentials redacts itself when
// formatted.
package awsauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"
)

// Credentials are AWS credentials. String/GoString redact everything.
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	// Expires is zero for credentials that do not expire (static keys).
	Expires time.Time
	// Source names the provider that produced them ("env", "web_identity", ...).
	Source string
}

// String implements fmt.Stringer without revealing any secret.
func (c Credentials) String() string { return "awsauth.Credentials{redacted source=" + c.Source + "}" }

// GoString implements fmt.GoStringer without revealing any secret.
func (c Credentials) GoString() string { return c.String() }

// Valid reports whether the credentials carry a key pair.
func (c Credentials) Valid() bool { return c.AccessKeyID != "" && c.SecretAccessKey != "" }

// Request is an unsigned HTTP request. Path is the path exactly as it is (or
// will be) sent on the wire, i.e. already percent-encoded; Query likewise.
type Request struct {
	Method string
	Host   string // authority, e.g. "sts.us-east-1.amazonaws.com"
	Path   string // wire path, "" means "/"
	Query  string // wire query without the leading "?"
	Header http.Header
	Body   []byte
}

// Options select the signing scope and the service quirks.
type Options struct {
	Service string
	Region  string
	Time    time.Time
	// S3Style disables path normalization and double URI-encoding and adds the
	// x-amz-content-sha256 header, as Amazon S3 requires.
	S3Style bool
	// UnsignedPayload signs the literal UNSIGNED-PAYLOAD instead of the body hash.
	UnsignedPayload bool
}

// Result carries the signature and the intermediates (tests compare them
// against the AWS test suite's .creq / .sts / .authz files).
type Result struct {
	CanonicalRequest string
	StringToSign     string
	SignedHeaders    string
	Signature        string
	Authorization    string
}

const (
	algorithm  = "AWS4-HMAC-SHA256"
	dateFormat = "20060102T150405Z"
	dayFormat  = "20060102"
)

// headers never signed: they are added or rewritten by intermediaries and the
// HTTP stack, or are hop-by-hop.
var unsignedHeaders = map[string]bool{
	"authorization":     true,
	"user-agent":        true,
	"x-amzn-trace-id":   true,
	"expect":            true,
	"connection":        true,
	"transfer-encoding": true,
	"content-length":    true,
	"accept-encoding":   true,
	"te":                true,
	"upgrade":           true,
	"keep-alive":        true,
}

// Sign signs req in place: it sets X-Amz-Date, X-Amz-Security-Token (when the
// credentials have a session token), x-amz-content-sha256 (S3Style) and
// Authorization, replacing any existing values of those headers.
func Sign(req *Request, creds Credentials, opts Options) (*Result, error) {
	if !creds.Valid() {
		return nil, fmt.Errorf("awsauth: credentials are incomplete")
	}
	if opts.Service == "" || opts.Region == "" {
		return nil, fmt.Errorf("awsauth: service and region are required")
	}
	if req.Host == "" {
		return nil, fmt.Errorf("awsauth: host is required")
	}
	if req.Header == nil {
		req.Header = http.Header{}
	}
	t := opts.Time.UTC()
	amzDate := t.Format(dateFormat)
	day := t.Format(dayFormat)

	req.Header.Del("Authorization")
	req.Header.Set("X-Amz-Date", amzDate)
	if creds.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", creds.SessionToken)
	} else {
		req.Header.Del("X-Amz-Security-Token")
	}
	payloadHash := hashHex(req.Body)
	if opts.UnsignedPayload {
		payloadHash = "UNSIGNED-PAYLOAD"
	}
	if opts.S3Style {
		req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	}

	signedNames, canonHeaders := canonicalHeaders(req)
	canonical := strings.Join([]string{
		strings.ToUpper(req.Method),
		canonicalURI(req.Path, opts.S3Style),
		canonicalQuery(req.Query),
		canonHeaders,
		signedNames,
		payloadHash,
	}, "\n")

	scope := day + "/" + opts.Region + "/" + opts.Service + "/aws4_request"
	toSign := strings.Join([]string{algorithm, amzDate, scope, hashHex([]byte(canonical))}, "\n")

	key := hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), []byte(day))
	key = hmacSHA256(key, []byte(opts.Region))
	key = hmacSHA256(key, []byte(opts.Service))
	key = hmacSHA256(key, []byte("aws4_request"))
	sig := hex.EncodeToString(hmacSHA256(key, []byte(toSign)))

	auth := fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s", algorithm, creds.AccessKeyID, scope, signedNames, sig)
	req.Header.Set("Authorization", auth)
	return &Result{CanonicalRequest: canonical, StringToSign: toSign, SignedHeaders: signedNames, Signature: sig, Authorization: auth}, nil
}

func hashHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

// canonicalHeaders returns the signed-header list and the canonical header
// block (each "name:value\n"), including the implicit host header.
func canonicalHeaders(req *Request) (signed, block string) {
	vals := map[string]string{"host": req.Host}
	for name, vs := range req.Header {
		ln := strings.ToLower(name)
		if unsignedHeaders[ln] || ln == "host" {
			continue
		}
		parts := make([]string, len(vs))
		for i, v := range vs {
			parts[i] = strings.Join(strings.Fields(v), " ")
		}
		if prev, ok := vals[ln]; ok {
			vals[ln] = prev + "," + strings.Join(parts, ",")
		} else {
			vals[ln] = strings.Join(parts, ",")
		}
	}
	names := make([]string, 0, len(vals))
	for n := range vals {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, n := range names {
		b.WriteString(n)
		b.WriteByte(':')
		b.WriteString(vals[n])
		b.WriteByte('\n')
	}
	return strings.Join(names, ";"), b.String()
}

// canonicalURI builds the canonical URI from the wire path: non-S3 services
// normalize dot segments and repeated slashes and URI-encode the (already
// encoded) path once more; S3 uses the wire path as is.
func canonicalURI(wirePath string, s3 bool) string {
	if wirePath == "" {
		return "/"
	}
	if s3 {
		return wirePath
	}
	return escapePath(normalizePath(wirePath))
}

func normalizePath(p string) string {
	trailing := strings.HasSuffix(p, "/")
	c := path.Clean(p)
	if c != "/" && trailing {
		c += "/"
	}
	if !strings.HasPrefix(c, "/") {
		c = "/" + c
	}
	return c
}

// escapePath percent-encodes every byte except unreserved characters and '/'.
func escapePath(p string) string { return escape(p, true) }

func escape(s string, keepSlash bool) string {
	const hexUpper = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexUpper[c>>4])
			b.WriteByte(hexUpper[c&15])
		}
	}
	return b.String()
}

// canonicalQuery decodes each parameter, re-encodes with the SigV4 rules and
// sorts by encoded name then encoded value.
func canonicalQuery(raw string) string {
	if raw == "" {
		return ""
	}
	type kv struct{ k, v string }
	var pairs []kv
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		pairs = append(pairs, kv{escape(queryUnescape(k), false), escape(queryUnescape(v), false)})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.k + "=" + p.v
	}
	return strings.Join(out, "&")
}

// queryUnescape decodes %XX and '+' (as space); malformed escapes are kept
// literally rather than failing (the wire form is what AWS will parse).
func queryUnescape(s string) string {
	if !strings.ContainsAny(s, "%+") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '+':
			b.WriteByte(' ')
		case c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]):
			b.WriteByte(unhex(s[i+1])<<4 | unhex(s[i+2]))
			i += 2
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	}
	return c - 'A' + 10
}
