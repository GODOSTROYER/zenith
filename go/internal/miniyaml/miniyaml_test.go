package miniyaml

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func parse(t *testing.T, src string) any {
	t.Helper()
	v, err := Parse([]byte(src))
	if err != nil {
		t.Fatalf("%v\n---\n%s", err, src)
	}
	return v
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestParseSupportedSubset(t *testing.T) {
	cases := []struct{ name, src, want string }{
		{"scalars", "a: 1\nb: 1.5\nc: true\nd: false\ne: null\nf: ~\ng: hello world\nh: \"quoted: text # not a comment\"\ni: 'it''s'\nj:\n", `{"a":1,"b":1.5,"c":true,"d":false,"e":null,"f":null,"g":"hello world","h":"quoted: text # not a comment","i":"it's","j":null}`},
		{"comments and blank lines", "# top\n\na: 1 # trailing\n\n# middle\nb: 'x # y'\n", `{"a":1,"b":"x # y"}`},
		{"nested maps", "a:\n  b:\n    c: 1\n  d: 2\ne: 3\n", `{"a":{"b":{"c":1},"d":2},"e":3}`},
		{"block sequence of scalars", "items:\n  - a\n  - 2\n  - \"three\"\n", `{"items":["a",2,"three"]}`},
		{"sequence at key indent", "items:\n- a\n- b\nnext: 1\n", `{"items":["a","b"],"next":1}`},
		{"sequence of maps", "rules:\n  - name: one\n    port: 80\n  - name: two\n    port: 443\n    tls: true\n", `{"rules":[{"name":"one","port":80},{"name":"two","port":443,"tls":true}]}`},
		{"nested sequence in map in sequence", "a:\n  - k:\n      - x\n      - y\n    n: 1\n", `{"a":[{"k":["x","y"],"n":1}]}`},
		{"flow collections", "a: [1, two, \"three, 3\"]\nb: {x: 1, y: [true, null]}\nc: []\nd: {}\n", `{"a":[1,"two","three, 3"],"b":{"x":1,"y":[true,null]},"c":[],"d":{}}`},
		{"keys that look like other things", "\"quoted key\": 1\n'single': 2\nplain key: 3\nurl: http://example.com:8080/x\n", `{"quoted key":1,"single":2,"plain key":3,"url":"http://example.com:8080/x"}`},
		{"dotted keys and values with colons", "tofu.run:\n  binary: /usr/local/bin/tofu\naws.http:\n  allow:\n    infrastructure.observe:\n      - \"ec2:Describe*\"\n      - 's3:GET /bucket/**'\n", `{"aws.http":{"allow":{"infrastructure.observe":["ec2:Describe*","s3:GET /bucket/**"]}},"tofu.run":{"binary":"/usr/local/bin/tofu"}}`},
		{"leading document marker", "---\na: 1\n", `{"a":1}`},
		{"CRLF", "a: 1\r\nb:\r\n  - x\r\n", `{"a":1,"b":["x"]}`},
		{"numbers that stay strings", "a: 0644\nb: 1.12.5\nc: +5\nd: 1e3x\n", `{"a":"0644","b":"1.12.5","c":"+5","d":"1e3x"}`},
		{"negative and zero", "a: -5\nb: 0\nc: -1.5\n", `{"a":-5,"b":0,"c":-1.5}`},
		{"escapes", `a: "line\nbreak\ttab \"q\" \u00e9"` + "\n", `{"a":"line\nbreak\ttab \"q\" é"}`},
		{"apostrophe inside plain scalar", "a: don't panic\n", `{"a":"don't panic"}`},
		{"top-level sequence", "- a\n- b\n", `["a","b"]`},
		{"key with no value then sibling", "a:\nb: 1\n", `{"a":null,"b":1}`},
		{"one-line flow document", `{"a": [1, 2, {"b": "c"}], "d": null}`, `{"a":[1,2,{"b":"c"}],"d":null}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := asJSON(t, parse(t, tc.src))
			var g, w any
			_ = json.Unmarshal([]byte(got), &g)
			_ = json.Unmarshal([]byte(tc.want), &w)
			if !reflect.DeepEqual(g, w) {
				t.Fatalf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}

func TestParseRejectsUnsupportedOrUnsafeConstructs(t *testing.T) {
	bad := map[string]string{
		"anchor":                 "a: &x 1\n",
		"alias":                  "a: *x\n",
		"tag":                    "a: !!str 1\n",
		"merge key":              "<<: *base\n",
		"block scalar literal":   "a: |\n  text\n",
		"block scalar folded":    "a: >\n  text\n",
		"tab indentation":        "a:\n\tb: 1\n",
		"duplicate key":          "a: 1\na: 2\n",
		"duplicate nested key":   "a:\n  b: 1\n  b: 2\n",
		"duplicate in flow map":  "a: {x: 1, x: 2}\n",
		"second document":        "a: 1\n---\nb: 2\n",
		"unterminated quote":     "a: \"oops\n",
		"unterminated flow":      "a: [1, 2\n",
		"multi-line flow":        "a: [1,\n  2]\n",
		"bad indentation":        "a:\n    b: 1\n  c: 2\n",
		"missing colon":          "just text\n",
		"sequence among keys":    "a: 1\n- b\n",
		"stray text after quote": "a: \"x\" y\n",
		"bad escape":             `a: "\q"` + "\n",
		"short unicode escape":   `a: "\u12"` + "\n",
		"at sign scalar":         "a: @foo\n",
		"percent scalar":         "a: %foo\n",
		"empty":                  "",
		"only comments":          "# nothing\n\n",
		"invalid utf8":           "a: \xff\n",
		"mapping in flow seq":    "a: [x: 1]\n",
		"key without value flow": "a: {x}\n",
	}
	for name, src := range bad {
		t.Run(name, func(t *testing.T) {
			if v, err := Parse([]byte(src)); err == nil {
				t.Fatalf("expected an error, got %s", asJSON(t, v))
			}
		})
	}
}

func TestErrorsNameTheLine(t *testing.T) {
	_, err := Parse([]byte("a: 1\nb: &x 2\n"))
	if err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("%v", err)
	}
}

func TestParseIsLinearOnAdversarialInput(t *testing.T) {
	// deeply nested flow sequences and long quoted strings must not blow up
	src := "a: " + strings.Repeat("[", 5000) + strings.Repeat("]", 5000) + "\n"
	if _, err := Parse([]byte(src)); err == nil || !strings.Contains(err.Error(), "nested deeper") {
		t.Fatalf("pathological nesting must be refused cleanly: %v", err)
	}
	long := "a: \"" + strings.Repeat("x", 1<<20) + "\"\n"
	v, err := Parse([]byte(long))
	if err != nil || len(v.(map[string]any)["a"].(string)) != 1<<20 {
		t.Fatal("long strings must parse")
	}
}
