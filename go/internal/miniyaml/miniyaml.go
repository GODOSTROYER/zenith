// Package miniyaml parses the small, safe subset of YAML used by Zenith agent
// config files, without a third-party dependency. It exists so operators can
// write config.yaml (and Helm can render it) while the agents stay
// stdlib-only.
//
// Supported: comments; block mappings; block sequences (including a sequence
// at the same indent as its key, and `- key: value` maps); plain, single- and
// double-quoted scalars; null/bool/int/float plain scalars; one-line flow
// sequences and flow mappings; an optional leading `---`.
//
// Deliberately rejected with an error: anchors, aliases, tags, merge keys,
// block scalars (`|`, `>`), multi-line flow collections, multiple documents,
// duplicate keys, tab indentation, non-string keys. A config that needs
// these features should be written as JSON (every JSON document is also
// valid input here).
package miniyaml

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

type line struct {
	num    int
	indent int
	text   string
}

// Parse parses one YAML document into nil, bool, int64, float64, string,
// []any or map[string]any.
func Parse(src []byte) (any, error) {
	if !utf8.Valid(src) {
		return nil, fmt.Errorf("input is not valid UTF-8")
	}
	var lines []line
	seenDoc := false
	for i, raw := range strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n") {
		num := i + 1
		trimmedRight := strings.TrimRight(raw, " \t")
		if strings.TrimSpace(trimmedRight) == "" {
			continue
		}
		indent := 0
		for indent < len(trimmedRight) && trimmedRight[indent] == ' ' {
			indent++
		}
		if indent < len(trimmedRight) && trimmedRight[indent] == '\t' {
			return nil, fmt.Errorf("line %d: tab characters are not allowed for indentation", num)
		}
		body := stripComment(trimmedRight[indent:])
		body = strings.TrimRight(body, " \t")
		if body == "" {
			continue
		}
		if indent == 0 && (body == "---" || strings.HasPrefix(body, "--- ")) {
			if seenDoc || len(lines) > 0 {
				return nil, fmt.Errorf("line %d: multiple YAML documents are not supported", num)
			}
			seenDoc = true
			body = strings.TrimSpace(strings.TrimPrefix(body, "---"))
			if body == "" {
				continue
			}
		}
		if indent == 0 && body == "..." {
			continue
		}
		lines = append(lines, line{num: num, indent: indent, text: body})
	}
	if len(lines) == 0 {
		return nil, fmt.Errorf("document is empty")
	}
	p := &parser{lines: lines}
	v, err := p.block(lines[0].indent)
	if err != nil {
		return nil, err
	}
	if p.i < len(p.lines) {
		return nil, fmt.Errorf("line %d: unexpected content (bad indentation?)", p.lines[p.i].num)
	}
	return v, nil
}

// stripComment removes a trailing `# comment` that is outside quotes and
// preceded by whitespace (or at the start).
func stripComment(s string) string {
	inS, inD := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inD:
			if c == '\\' {
				i++
			} else if c == '"' {
				inD = false
			}
		case inS:
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					i++
				} else {
					inS = false
				}
			}
		case c == '"' && startsToken(s, i):
			inD = true
		case c == '\'' && startsToken(s, i):
			inS = true
		case c == '#' && (i == 0 || s[i-1] == ' ' || s[i-1] == '\t'):
			return s[:i]
		}
	}
	return s
}

// startsToken reports whether a quote at i begins a quoted scalar (start of
// text, or preceded by space, `[`, `{`, `,`, `:` or `-`), rather than being an
// apostrophe inside a plain scalar such as `don't`.
func startsToken(s string, i int) bool {
	if i == 0 {
		return true
	}
	switch s[i-1] {
	case ' ', '\t', '[', '{', ',', ':', '-':
		return true
	}
	return false
}

type parser struct {
	lines []line
	i     int
}

func (p *parser) block(indent int) (any, error) {
	if p.i >= len(p.lines) {
		return nil, nil
	}
	l := p.lines[p.i]
	if l.indent != indent {
		return nil, fmt.Errorf("line %d: unexpected indentation", l.num)
	}
	if isSeqItem(l.text) {
		return p.sequence(indent)
	}
	return p.mapping(indent)
}

func isSeqItem(t string) bool { return t == "-" || strings.HasPrefix(t, "- ") }

func (p *parser) mapping(indent int) (any, error) {
	m := map[string]any{}
	for p.i < len(p.lines) {
		l := p.lines[p.i]
		if l.indent < indent {
			break
		}
		if l.indent > indent {
			return nil, fmt.Errorf("line %d: unexpected indentation", l.num)
		}
		if isSeqItem(l.text) {
			return nil, fmt.Errorf("line %d: sequence item where a mapping key was expected", l.num)
		}
		key, rest, err := splitKey(l)
		if err != nil {
			return nil, err
		}
		if _, dup := m[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate key %q", l.num, key)
		}
		p.i++
		if rest == "" {
			// nested block, same-indent sequence, or null
			if p.i < len(p.lines) {
				n := p.lines[p.i]
				switch {
				case n.indent > indent:
					v, err := p.block(n.indent)
					if err != nil {
						return nil, err
					}
					m[key] = v
					continue
				case n.indent == indent && isSeqItem(n.text):
					v, err := p.sequence(indent)
					if err != nil {
						return nil, err
					}
					m[key] = v
					continue
				}
			}
			m[key] = nil
			continue
		}
		v, err := parseInline(rest, l.num)
		if err != nil {
			return nil, err
		}
		m[key] = v
	}
	return m, nil
}

func (p *parser) sequence(indent int) (any, error) {
	out := []any{}
	for p.i < len(p.lines) {
		l := p.lines[p.i]
		if l.indent != indent || !isSeqItem(l.text) {
			break
		}
		content := strings.TrimLeft(strings.TrimPrefix(l.text, "-"), " ")
		offset := len(l.text) - len(content) // dash + spaces
		if content == "" {
			p.i++
			if p.i < len(p.lines) && p.lines[p.i].indent > indent {
				v, err := p.block(p.lines[p.i].indent)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			} else {
				out = append(out, nil)
			}
			continue
		}
		if isSeqItem(content) || looksLikeMapEntry(content) {
			// treat "- key: v" as a block starting at a virtual deeper indent
			p.lines[p.i] = line{num: l.num, indent: indent + offset, text: content}
			v, err := p.block(indent + offset)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
			continue
		}
		v, err := parseInline(content, l.num)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		p.i++
	}
	return out, nil
}

// looksLikeMapEntry: an unquoted-or-quoted key followed by ':' + space/end.
func looksLikeMapEntry(s string) bool {
	if s == "" {
		return false
	}
	switch s[0] {
	case '[', '{':
		return false
	}
	_, _, ok := scanKey(s)
	return ok
}

// scanKey returns the key text (dequoted) and the remainder after the colon.
func scanKey(s string) (key, rest string, ok bool) {
	if s[0] == '"' || s[0] == '\'' {
		end, val, err := readQuoted(s)
		if err != nil {
			return "", "", false
		}
		r := strings.TrimLeft(s[end:], " ")
		if strings.HasPrefix(r, ":") && (len(r) == 1 || r[1] == ' ') {
			return val, strings.TrimSpace(r[1:]), true
		}
		return "", "", false
	}
	for i := 0; i < len(s); i++ {
		if s[i] == ':' && (i+1 == len(s) || s[i+1] == ' ') {
			return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:]), i > 0
		}
	}
	return "", "", false
}

func splitKey(l line) (key, rest string, err error) {
	k, r, ok := scanKey(l.text)
	if !ok {
		return "", "", fmt.Errorf("line %d: expected `key: value`", l.num)
	}
	if k == "<<" {
		return "", "", fmt.Errorf("line %d: merge keys are not supported", l.num)
	}
	if strings.ContainsAny(k[:min(1, len(k))], "&*!") && (l.text[0] != '"' && l.text[0] != '\'') {
		return "", "", fmt.Errorf("line %d: anchors, aliases and tags are not supported", l.num)
	}
	return k, r, nil
}

// readQuoted reads a quoted scalar at the start of s. It returns the index
// just past the closing quote and the decoded value.
func readQuoted(s string) (end int, val string, err error) {
	q := s[0]
	var b strings.Builder
	i := 1
	for i < len(s) {
		c := s[i]
		if q == '\'' {
			if c == '\'' {
				if i+1 < len(s) && s[i+1] == '\'' {
					b.WriteByte('\'')
					i += 2
					continue
				}
				return i + 1, b.String(), nil
			}
			b.WriteByte(c)
			i++
			continue
		}
		// double-quoted
		switch c {
		case '"':
			return i + 1, b.String(), nil
		case '\\':
			if i+1 >= len(s) {
				return 0, "", fmt.Errorf("dangling escape")
			}
			i++
			switch s[i] {
			case '"', '\\', '/':
				b.WriteByte(s[i])
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			case 'r':
				b.WriteByte('\r')
			case '0':
				b.WriteByte(0)
			case 'u':
				if i+4 >= len(s) {
					return 0, "", fmt.Errorf("short \\u escape")
				}
				n, err := strconv.ParseUint(s[i+1:i+5], 16, 32)
				if err != nil {
					return 0, "", fmt.Errorf("bad \\u escape")
				}
				b.WriteRune(rune(n))
				i += 4
			default:
				return 0, "", fmt.Errorf("unsupported escape \\%c", s[i])
			}
			i++
		default:
			b.WriteByte(c)
			i++
		}
	}
	return 0, "", fmt.Errorf("unterminated quoted string")
}

// parseInline parses a scalar or one-line flow collection.
func parseInline(s string, num int) (any, error) {
	s = strings.TrimSpace(s)
	switch s[0] {
	case '|', '>':
		return nil, fmt.Errorf("line %d: block scalars are not supported (use a quoted string)", num)
	case '&', '*', '!':
		return nil, fmt.Errorf("line %d: anchors, aliases and tags are not supported (quote the value if it is a literal)", num)
	case '@', '`', '%':
		return nil, fmt.Errorf("line %d: a plain scalar cannot start with %q (quote it)", num, s[0])
	}
	f := &flow{s: s, num: num}
	v, err := f.value(false)
	if err != nil {
		return nil, err
	}
	f.skip()
	if f.i != len(f.s) {
		return nil, fmt.Errorf("line %d: unexpected text after value", num)
	}
	return v, nil
}

type flow struct {
	s   string
	i   int
	num int
}

func (f *flow) skip() {
	for f.i < len(f.s) && (f.s[f.i] == ' ' || f.s[f.i] == '\t') {
		f.i++
	}
}

func (f *flow) value(inFlow bool) (any, error) {
	f.skip()
	if f.i >= len(f.s) {
		return nil, nil
	}
	switch f.s[f.i] {
	case '[':
		return f.seq()
	case '{':
		return f.mapp()
	case '"', '\'':
		end, v, err := readQuoted(f.s[f.i:])
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", f.num, err)
		}
		f.i += end
		return v, nil
	}
	// plain scalar
	start := f.i
	for f.i < len(f.s) {
		c := f.s[f.i]
		if inFlow && (c == ',' || c == ']' || c == '}') {
			break
		}
		if inFlow && c == ':' && (f.i+1 == len(f.s) || f.s[f.i+1] == ' ') {
			break
		}
		f.i++
	}
	return resolvePlain(strings.TrimSpace(f.s[start:f.i])), nil
}

func (f *flow) seq() (any, error) {
	f.i++ // [
	out := []any{}
	for {
		f.skip()
		if f.i >= len(f.s) {
			return nil, fmt.Errorf("line %d: unterminated flow sequence (multi-line flow collections are not supported)", f.num)
		}
		if f.s[f.i] == ']' {
			f.i++
			return out, nil
		}
		v, err := f.value(true)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		f.skip()
		if f.i < len(f.s) && f.s[f.i] == ',' {
			f.i++
		}
	}
}

func (f *flow) mapp() (any, error) {
	f.i++ // {
	out := map[string]any{}
	for {
		f.skip()
		if f.i >= len(f.s) {
			return nil, fmt.Errorf("line %d: unterminated flow mapping (multi-line flow collections are not supported)", f.num)
		}
		if f.s[f.i] == '}' {
			f.i++
			return out, nil
		}
		kv, err := f.value(true)
		if err != nil {
			return nil, err
		}
		key, ok := kv.(string)
		if !ok {
			key = fmt.Sprint(kv)
		}
		f.skip()
		if f.i >= len(f.s) || f.s[f.i] != ':' {
			return nil, fmt.Errorf("line %d: expected `:` in flow mapping", f.num)
		}
		f.i++
		v, err := f.value(true)
		if err != nil {
			return nil, err
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate key %q", f.num, key)
		}
		out[key] = v
		f.skip()
		if f.i < len(f.s) && f.s[f.i] == ',' {
			f.i++
		}
	}
}

func resolvePlain(s string) any {
	switch s {
	case "", "~", "null", "Null", "NULL":
		return nil
	case "true", "True", "TRUE":
		return true
	case "false", "False", "FALSE":
		return false
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil && !strings.HasPrefix(s, "+") && !(len(s) > 1 && s[0] == '0') {
		return n
	}
	if len(s) > 0 && (s[0] == '-' || (s[0] >= '0' && s[0] <= '9') || s[0] == '.') && strings.ContainsAny(s, ".eE") {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f
		}
	}
	return s
}
