package oci

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const MaxRequestBytes = 1 << 20

var ErrInvalidRequest = errors.New("OCI request does not match the unsigned request schema")
var regionID = regexp.MustCompile(`^[a-z]{2}-[a-z0-9-]{3,30}-\d$`)
var oracleHost = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+oraclecloud\.com$`)
var ocid = regexp.MustCompile(`^ocid1\.[a-z0-9_]+\.[a-z0-9]+\.[a-z0-9-]*\.[A-Za-z0-9]{6,120}$`)

func RegionID(s string) bool   { return regionID.MatchString(s) }
func OracleHost(s string) bool { return len(s) <= 253 && oracleHost.MatchString(s) }
func OCID(s string) bool       { return len(s) <= 300 && ocid.MatchString(s) }

type Request struct {
	Service      string            `json:"service"`
	Region       string            `json:"region"`
	Method       string            `json:"method"`
	Path         string            `json:"path"`
	Query        [][2]string       `json:"query"`
	Headers      map[string]string `json:"headers"`
	BodyB64      *string           `json:"bodyB64,omitempty"`
	EndpointHost string            `json:"endpointHost,omitempty"`
}

func control(s string) bool {
	for _, r := range s {
		if r < 32 || r == 127 {
			return true
		}
	}
	return !utf8.ValidString(s)
}

// PlainPath checks decoded segments too, preventing traversal and URL ambiguity.
func PlainPath(path string) bool {
	if len(path) > 2048 || !strings.HasPrefix(path, "/") || control(path) || strings.ContainsAny(path, `\?#`) {
		return false
	}
	for _, segment := range strings.Split(path[1:], "/") {
		decoded, err := url.PathUnescape(segment)
		if err != nil || decoded == "" || strings.Trim(decoded, ".") == "" || control(decoded) || strings.ContainsAny(decoded, `/\`) {
			return false
		}
		// Require the percent-encoded ASCII wire form. A literal space cannot survive
		// URL construction unchanged. encodeURIComponent's unescaped punctuation is OK.
		for _, r := range segment {
			if r <= 32 || r >= 127 {
				return false
			}
		}
	}
	return true
}

// DecodeJSON rejects duplicate members at every level and trailing documents.
// Ordinary encoding/json decoding would lose conflicting compartment bindings.
func DecodeJSON(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	value, err := jsonValue(d, 0)
	if err != nil {
		return nil, ErrInvalidRequest
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, ErrInvalidRequest
	}
	return value, nil
}

func jsonValue(d *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, ErrInvalidRequest
	}
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); ok {
		switch delim {
		case '{':
			out := map[string]any{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				name, ok := key.(string)
				if !ok {
					return nil, ErrInvalidRequest
				}
				if _, exists := out[name]; exists {
					return nil, ErrInvalidRequest
				}
				val, err := jsonValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				out[name] = val
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return nil, ErrInvalidRequest
			}
			return out, nil
		case '[':
			out := []any{}
			for d.More() {
				val, err := jsonValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, val)
			}
			if end, err := d.Token(); err != nil || end != json.Delim(']') {
				return nil, ErrInvalidRequest
			}
			return out, nil
		default:
			return nil, ErrInvalidRequest
		}
	}
	return token, nil
}

// ParseRequest validates everything before a provider or HTTP client is called.
// Errors deliberately contain no payload members or decoder messages.
func ParseRequest(raw []byte, limit int64) (Request, []byte, error) {
	var r Request
	if limit <= 0 || limit > MaxRequestBytes {
		limit = MaxRequestBytes
	}
	if len(raw) > 2*MaxRequestBytes || !utf8.Valid(raw) {
		return r, nil, ErrInvalidRequest
	}
	val, err := DecodeJSON(raw)
	obj, ok := val.(map[string]any)
	if err != nil || !ok {
		return r, nil, ErrInvalidRequest
	}
	for _, value := range obj {
		if value == nil {
			return r, nil, ErrInvalidRequest
		}
	}
	if q, exists := obj["query"]; exists {
		pairs, ok := q.([]any)
		if !ok || len(pairs) > 128 {
			return r, nil, ErrInvalidRequest
		}
		for _, pair := range pairs {
			p, ok := pair.([]any)
			if !ok || len(p) != 2 {
				return r, nil, ErrInvalidRequest
			}
		}
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&r) != nil {
		return r, nil, ErrInvalidRequest
	}
	if _, err := ResolveHost(r.Service, r.Region, r.EndpointHost); err != nil || !PlainPath(r.Path) {
		return r, nil, ErrInvalidRequest
	}
	if _, exists := obj["endpointHost"]; exists && r.Service != "queue-data" {
		return r, nil, ErrInvalidRequest
	}
	switch r.Method {
	case "GET", "HEAD", "POST", "PUT":
	default:
		return r, nil, ErrInvalidRequest
	}
	seen := map[string]bool{}
	for name, value := range r.Headers {
		lower := strings.ToLower(name)
		switch lower {
		case "opc-retry-token", "if-match", "if-none-match", "opc-request-id":
		default:
			return r, nil, ErrInvalidRequest
		}
		if seen[lower] || len(value) > 256 || control(value) {
			return r, nil, ErrInvalidRequest
		}
		seen[lower] = true
	}
	last := ""
	for _, pair := range r.Query {
		if pair[0] == "" || len(pair[0]) > 128 || len(pair[1]) > 2048 || control(pair[0]) || control(pair[1]) || pair[0] < last {
			return r, nil, ErrInvalidRequest
		}
		last = pair[0]
	}
	if r.BodyB64 == nil {
		return r, nil, nil
	}
	if r.Method == "GET" || r.Method == "HEAD" || int64(len(*r.BodyB64)) > ((limit+2)/3)*4 {
		return r, nil, ErrInvalidRequest
	}
	body, err := base64.StdEncoding.Strict().DecodeString(*r.BodyB64)
	if err != nil || int64(len(body)) > limit || base64.StdEncoding.EncodeToString(body) != *r.BodyB64 {
		return r, nil, ErrInvalidRequest
	}
	if _, err := DecodeJSON(body); err != nil || !utf8.Valid(body) {
		return r, nil, ErrInvalidRequest
	}
	return r, body, nil
}

// QueryString preserves pair order and duplicates; it is the exact signed wire
// query. RFC 3986 escapes spaces as %20, not form-encoding's +.
func QueryString(pairs [][2]string) string {
	out := make([]string, 0, len(pairs))
	escape := func(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }
	for _, pair := range pairs {
		out = append(out, escape(pair[0])+"="+escape(pair[1]))
	}
	return strings.Join(out, "&")
}
