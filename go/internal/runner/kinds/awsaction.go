package kinds

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// Action is the AWS operation an unsigned request would perform, derived from
// the request itself (never from a caller-supplied label).
type Action struct {
	Service string
	// Protocol is "json" (X-Amz-Target), "query" (Action= parameter) or "rest".
	Protocol string
	// Name is the API action for json/query ("DescribeInstances"), and
	// "METHOD /decoded/path" for REST requests.
	Name string
	// Method and Path are set for REST actions.
	Method string
	Path   string
}

// String is the audit form: "ec2:DescribeInstances" or "s3:GET /bucket/key".
func (a Action) String() string { return a.Service + ":" + a.Name }

var (
	jsonActionRe  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,127}$`)
	queryActionRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,127}$`)
)

// ExtractAction derives the Action for a request.
//
//   - JSON protocol: the X-Amz-Target header ("DynamoDB_20120810.PutItem" ->
//     PutItem).
//   - Query protocol: the Action parameter of the URL query or, for a
//     form-encoded body, of the body.
//   - Otherwise REST: method + decoded path.
//
// Ambiguity is refused: a request carrying both an X-Amz-Target and an Action
// parameter, or more than one Action parameter, could be interpreted as a
// different operation by the AWS service than the one the runner authorized
// (parameter pollution), so it is rejected outright.
//
// An RPC-style claim (X-Amz-Target or Action) is only believed when the request
// has the SHAPE of an RPC call: the JSON protocol is POST to "/", the query
// protocol is GET or POST to "/" (SQS queue operations use /<account>/<queue>).
// Otherwise a REST service could be handed a fake "Action=ListThings" while it
// routes on method and path to a destructive operation; such a request is
// refused, never reinterpreted. Services that are REST-only (restOnlyServices)
// never accept an RPC-style claim at all.
func ExtractAction(service, method string, u *url.URL, h http.Header, body []byte) (Action, error) {
	act := Action{Service: strings.ToLower(service)}
	if len(h.Values("X-Amz-Target")) > 1 {
		return act, protocol.Errorf(protocol.CodeNotAllowed, "the request carries more than one X-Amz-Target header")
	}
	target := h.Get("X-Amz-Target")

	var actions []string
	q := u.Query()
	if err := rejectCaseVariants(q); err != nil {
		return act, err
	}
	actions = append(actions, q["Action"]...)
	if ct := strings.ToLower(h.Get("Content-Type")); strings.HasPrefix(ct, "application/x-www-form-urlencoded") && len(body) > 0 {
		vals, err := url.ParseQuery(string(body))
		if err != nil {
			return act, protocol.Errorf(protocol.CodeInvalidPayload, "the form-encoded body is malformed")
		}
		if err := rejectCaseVariants(vals); err != nil {
			return act, err
		}
		actions = append(actions, vals["Action"]...)
	}

	rpc := target != "" || len(actions) > 0
	if rpc {
		if restOnlyServices[act.Service] {
			return act, protocol.Errorf(protocol.CodeNotAllowed, "%s is a REST service: an X-Amz-Target or Action claim is not accepted; use a method+path rule", act.Service)
		}
		if err := rpcShapeOK(act.Service, strings.ToUpper(method), u.EscapedPath(), target != ""); err != nil {
			return act, err
		}
	}

	switch {
	case target != "" && len(actions) > 0:
		return act, protocol.Errorf(protocol.CodeNotAllowed, "the request mixes X-Amz-Target and an Action parameter; the operation would be ambiguous")
	case target != "":
		i := strings.LastIndexByte(target, '.')
		if i < 1 || i == len(target)-1 {
			return act, protocol.Errorf(protocol.CodeNotAllowed, "X-Amz-Target must look like Prefix.Action")
		}
		name := target[i+1:]
		if !jsonActionRe.MatchString(name) {
			return act, protocol.Errorf(protocol.CodeNotAllowed, "X-Amz-Target action is malformed")
		}
		act.Protocol, act.Name = "json", name
	case len(actions) > 1:
		return act, protocol.Errorf(protocol.CodeNotAllowed, "the request carries more than one Action parameter")
	case len(actions) == 1:
		if !queryActionRe.MatchString(actions[0]) {
			return act, protocol.Errorf(protocol.CodeNotAllowed, "the Action parameter is malformed")
		}
		act.Protocol, act.Name = "query", actions[0]
	default:
		p := u.Path // decoded
		if err := restPathOK(p); err != nil {
			return act, err
		}
		act.Protocol, act.Method, act.Path = "rest", strings.ToUpper(method), p
		act.Name = act.Method + " " + p
	}
	return act, nil
}

// restOnlyServices are SigV4 signing names of services whose API is REST
// (routed on method and path). They can never be authorized by an
// X-Amz-Target or Action claim, only by a "service:METHOD /path" rule.
var restOnlyServices = map[string]bool{
	"s3": true, "s3-outposts": true, "s3express": true, "s3-object-lambda": true, "lambda": true, "route53": true,
	"apigateway": true, "execute-api": true, "cloudfront": true, "elasticfilesystem": true, "eks": true, "glacier": true,
	"iot": true, "amplify": true, "appsync": true, "batch": true, "backup": true,
}

var sqsQueuePathRe = regexp.MustCompile(`^/[0-9]{12}/[A-Za-z0-9_-]{1,80}(\.fifo)?$`)

// rpcShapeOK checks that a request making an RPC-style claim is shaped like an
// RPC call.
func rpcShapeOK(service, method, escapedPath string, jsonStyle bool) error {
	path := escapedPath
	if path == "" {
		path = "/"
	}
	if jsonStyle {
		if method != "POST" || path != "/" {
			return protocol.Errorf(protocol.CodeNotAllowed, "an X-Amz-Target request must be POST to /")
		}
		return nil
	}
	if method != "POST" && method != "GET" {
		return protocol.Errorf(protocol.CodeNotAllowed, "an Action request must be GET or POST")
	}
	if path == "/" || (service == "sqs" && sqsQueuePathRe.MatchString(path)) {
		return nil
	}
	return protocol.Errorf(protocol.CodeNotAllowed, "an Action request must target /, not a resource path")
}

// rejectCaseVariants refuses parameters such as "action" or "ACTION": the
// canonical name is "Action", and a variant could be honored by a service that
// folds case while the runner authorized a different operation.
func rejectCaseVariants(v url.Values) error {
	for k := range v {
		if k != "Action" && strings.EqualFold(k, "Action") {
			return protocol.Errorf(protocol.CodeNotAllowed, "the request carries a case variant of the Action parameter")
		}
	}
	return nil
}

// restPathOK refuses dot segments in the decoded path: a path such as
// /allowed/../secret would match an allowed prefix while AWS resolves it
// elsewhere.
func restPathOK(p string) error {
	if !strings.HasPrefix(p, "/") {
		return protocol.Errorf(protocol.CodeNotAllowed, "the request path must be absolute")
	}
	if strings.ContainsRune(p, 0) {
		return protocol.Errorf(protocol.CodeNotAllowed, "the request path contains a NUL byte")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return protocol.Errorf(protocol.CodeNotAllowed, "the request path contains a dot segment")
		}
	}
	return nil
}

/* -------------------------------- allowlist -------------------------------- */

// Rule is one parsed allowlist entry.
type Rule struct {
	Service string
	// Action rules ("ec2:Describe*"): Prefix is the text before an optional
	// trailing '*'; Wildcard reports whether the '*' was present.
	Prefix   string
	Wildcard bool
	// REST rules ("s3:GET /bucket/*"): Method and path segments; a segment
	// "*" matches exactly one non-empty segment, a final "**" matches any
	// remainder (including nothing).
	REST     bool
	Method   string
	Segments []string
}

var (
	serviceRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	actionRuleRe = regexp.MustCompile(`^[A-Za-z0-9_]*\*?$`)
	restMethods  = map[string]bool{"GET": true, "HEAD": true, "POST": true, "PUT": true, "DELETE": true, "PATCH": true}
)

// ParseRules parses allowlist entries. Action wildcards are suffix-only
// ("Describe*", "*"); a '*' anywhere else is an error, as is "*:*".
func ParseRules(entries []string) ([]Rule, error) {
	out := make([]Rule, 0, len(entries))
	for _, e := range entries {
		e = strings.TrimSpace(e)
		svc, rest, ok := strings.Cut(e, ":")
		if !ok || !serviceRe.MatchString(svc) || rest == "" {
			return nil, fmt.Errorf("allowlist entry %q must look like service:Action or service:METHOD /path", e)
		}
		if m, p, isREST := strings.Cut(rest, " "); isREST {
			if !restMethods[m] {
				return nil, fmt.Errorf("allowlist entry %q: REST method must be one of GET HEAD POST PUT DELETE PATCH", e)
			}
			p = strings.TrimSpace(p)
			if !strings.HasPrefix(p, "/") {
				return nil, fmt.Errorf("allowlist entry %q: REST path must start with /", e)
			}
			segs := strings.Split(strings.TrimPrefix(p, "/"), "/")
			for i, s := range segs {
				if strings.Contains(s, "*") && s != "*" && s != "**" {
					return nil, fmt.Errorf("allowlist entry %q: '*' must be a whole path segment", e)
				}
				if s == "**" && i != len(segs)-1 {
					return nil, fmt.Errorf("allowlist entry %q: '**' is only allowed as the last segment", e)
				}
				if s == "." || s == ".." {
					return nil, fmt.Errorf("allowlist entry %q: dot segments are not allowed", e)
				}
			}
			out = append(out, Rule{Service: svc, REST: true, Method: m, Segments: segs})
			continue
		}
		if !actionRuleRe.MatchString(rest) {
			return nil, fmt.Errorf("allowlist entry %q: only a trailing '*' wildcard is allowed in an action", e)
		}
		wild := strings.HasSuffix(rest, "*")
		out = append(out, Rule{Service: svc, Prefix: strings.TrimSuffix(rest, "*"), Wildcard: wild})
	}
	return out, nil
}

// Match reports whether the rule authorizes the action.
func (r Rule) Match(a Action) bool {
	if r.Service != a.Service {
		return false
	}
	if r.REST {
		if a.Protocol != "rest" || r.Method != a.Method {
			return false
		}
		return matchSegments(r.Segments, strings.Split(strings.TrimPrefix(a.Path, "/"), "/"))
	}
	if a.Protocol == "rest" {
		return false
	}
	if r.Wildcard {
		return strings.HasPrefix(a.Name, r.Prefix)
	}
	return a.Name == r.Prefix
}

func matchSegments(pat, got []string) bool {
	for i, p := range pat {
		if p == "**" {
			return true
		}
		if i >= len(got) {
			return false
		}
		if p == "*" {
			if got[i] == "" {
				return false
			}
			continue
		}
		if p != got[i] {
			return false
		}
	}
	return len(pat) == len(got)
}

// Allowlist maps a capability name to its rules.
type Allowlist map[string][]Rule

// ParseAllowlist parses the config form (capability -> entries).
func ParseAllowlist(m map[string][]string) (Allowlist, error) {
	al := Allowlist{}
	for cap, entries := range m {
		if cap == "" {
			return nil, fmt.Errorf("allowlist has an empty capability name")
		}
		rules, err := ParseRules(entries)
		if err != nil {
			return nil, fmt.Errorf("capability %q: %w", cap, err)
		}
		al[cap] = rules
	}
	return al, nil
}

// Allows reports whether the capability may perform the action.
func (al Allowlist) Allows(capability string, a Action) bool {
	for _, r := range al[capability] {
		if r.Match(a) {
			return true
		}
	}
	return false
}
