// Package redact masks credential-shaped strings in text that leaves the
// agent (job logs, tofu output, journal lines, container logs, file
// contents). It is defense in depth: the primary control is that secrets are
// never placed in job payloads or results in the first place, and that the
// agent's own credentials are never printed. Every pattern is RE2 (linear
// time), so hostile input cannot cause catastrophic backtracking.
//
// Honest limit: pattern redaction cannot recognize an arbitrary secret with
// no recognizable shape (a random password on its own line). Treat redaction
// as best-effort.
package redact

import (
	"regexp"
	"strings"
)

const mask = "[REDACTED]"

var rules = []struct {
	re   *regexp.Regexp
	repl string
}{
	// PEM private keys (whole block, or from BEGIN to end of input if the END
	// line is missing, e.g. truncated output).
	{regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`), "[REDACTED:private-key]"},
	// AWS access key ids (long-term and temporary).
	{regexp.MustCompile(`\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b`), "[REDACTED:aws-key-id]"},
	// JWTs (three base64url segments, the first beginning eyJ).
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`), "[REDACTED:jwt]"},
	// Zenith registration / API tokens and common vendor token shapes.
	{regexp.MustCompile(`\bzrt_[A-Za-z0-9_-]{8,}`), "[REDACTED:zenith-token]"},
	{regexp.MustCompile(`\bza_[A-Za-z0-9_-]{16,}`), "[REDACTED:zenith-token]"},
	{regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{30,}`), "[REDACTED:github-token]"},
	{regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), "[REDACTED:slack-token]"},
	// Authorization-style values.
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}`), "$1 " + mask},
}

// key[:=]value pairs whose key names a secret. The value forms handled are
// double-quoted, single-quoted and bare (up to whitespace, comma, semicolon,
// or a closing bracket/brace). Group 1 = key (kept), group 2 = separator.
var kvRe = regexp.MustCompile(`(?i)(["']?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*["']?)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\])]+)`)

// Innocuous values that share a key name with secrets (do not mask).
var benignValues = map[string]bool{
	"": true, "null": true, "true": true, "false": true, "none": true,
	`""`: true, `''`: true, "(sensitive)": true, "<sensitive>": true, "bearer": true,
}

// String redacts credential-shaped substrings.
func String(s string) string {
	if s == "" {
		return s
	}
	for _, r := range rules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return kvRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := kvRe.FindStringSubmatch(m)
		if len(sub) != 4 {
			return m
		}
		v := strings.TrimSpace(sub[3])
		// Placeholders such as "(sensitive value)" and "(known after apply)" that
		// OpenTofu prints in place of a value are not secrets.
		if benignValues[strings.ToLower(v)] || strings.HasPrefix(v, "(") || strings.Contains(v, "[REDACTED") {
			return m
		}
		q := ""
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
			q = string(v[0])
		}
		return sub[1] + sub[2] + q + mask + q
	})
}

// Lines is a stateful redactor for a stream of lines. It additionally
// suppresses the body of a multi-line PEM private key, which a per-line
// regexp cannot see as a unit.
type Lines struct {
	inKey bool
}

var (
	pemBegin = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	pemEnd   = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
)

// Line redacts one line of a stream.
func (l *Lines) Line(s string) string {
	if l.inKey {
		if pemEnd.MatchString(s) {
			l.inKey = false
		}
		return "[REDACTED:private-key]"
	}
	if pemBegin.MatchString(s) && !pemEnd.MatchString(s) {
		l.inKey = true
		return "[REDACTED:private-key]"
	}
	return String(s)
}
