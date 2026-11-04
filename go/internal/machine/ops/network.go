package ops

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/netguard"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

func init() {
	register(Operation{Name: OpPortCheck, Prepare: preparePortCheck})
	register(Operation{Name: OpDNSCheck, Prepare: prepareDNSCheck})
}

// networkGuard: from a VM's own vantage point, loopback is a legitimate
// target ("is my app listening on 127.0.0.1:8080?"), so loopback is allowed
// here; metadata and link-local addresses never are.
func (e *Env) networkGuard() *netguard.Guard {
	return &netguard.Guard{Resolver: e.Resolver, AllowLoopback: true}
}

func validHostArg(h string) error {
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

func literalGuard(g *netguard.Guard, host string) error {
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

type portArgs struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	TimeoutSec int    `json:"timeoutSec"`
}

func preparePortCheck(e *Env, req *Request) (Runnable, error) {
	var a portArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := validHostArg(a.Host); err != nil {
		return nil, err
	}
	if a.Port < 1 || a.Port > 65535 {
		return nil, invalid("port must be between 1 and 65535")
	}
	if a.TimeoutSec < 0 || a.TimeoutSec > 30 {
		return nil, invalid("timeoutSec must be at most 30")
	}
	g := e.networkGuard()
	if err := literalGuard(g, a.Host); err != nil {
		return nil, err
	}
	timeout := netTimeout(a.TimeoutSec*1000, req.Timeout)
	return func(ctx context.Context) (Result, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		start := e.now()
		data := map[string]any{"host": a.Host, "port": a.Port}
		addrs, err := g.Resolve(ctx, a.Host)
		if err != nil {
			if netguard.IsBlocked(err) {
				return Result{}, protocol.Errorf(protocol.CodeGuardDenied, "%v", err)
			}
			data["open"], data["reason"] = false, classify(ctx, err)
			return Result{OK: true, Data: data}, nil
		}
		var last error
		for _, ad := range addrs {
			c, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(ad.String(), fmt.Sprint(a.Port)))
			if err == nil {
				_ = c.Close()
				data["open"], data["latencyMs"] = true, e.now().Sub(start).Milliseconds()
				return Result{OK: true, Data: data}, nil
			}
			last = err
			if ctx.Err() != nil {
				break
			}
		}
		data["open"], data["reason"], data["latencyMs"] = false, classify(ctx, last), e.now().Sub(start).Milliseconds()
		return Result{OK: true, Data: data}, nil
	}, nil
}

type dnsArgs struct {
	Name       string `json:"name"`
	RecordType string `json:"recordType"`
}

func prepareDNSCheck(e *Env, req *Request) (Runnable, error) {
	var a dnsArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := validHostArg(a.Name); err != nil {
		return nil, err
	}
	typ := strings.ToUpper(a.RecordType)
	if typ == "" {
		typ = "A"
	}
	switch typ {
	case "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV":
	default:
		return nil, invalid("recordType must be one of A, AAAA, CNAME, TXT, MX, NS, SRV")
	}
	g := e.networkGuard()
	if err := literalGuard(g, a.Name); err != nil {
		return nil, err
	}
	timeout := netTimeout(0, req.Timeout)
	var res netguard.Resolver = net.DefaultResolver
	if e.Resolver != nil {
		res = e.Resolver
	}
	return func(ctx context.Context) (Result, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		name := netguard.NormalizeHost(a.Name)
		answers := []string{}
		var err error
		switch typ {
		case "A", "AAAA":
			network := map[string]string{"A": "ip4", "AAAA": "ip6"}[typ]
			var addrs []netip.Addr
			addrs, err = res.LookupNetIP(ctx, network, name)
			for _, ad := range addrs {
				if cerr := g.CheckAddr(ad); cerr != nil {
					return Result{}, protocol.Errorf(protocol.CodeGuardDenied, "%v", cerr)
				}
				answers = append(answers, ad.Unmap().String())
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
				answers[i] = clip(answers[i], 512)
			}
		case "MX":
			var mx []*net.MX
			mx, err = net.DefaultResolver.LookupMX(ctx, name)
			for _, m := range mx {
				answers = append(answers, fmt.Sprintf("%d %s", m.Pref, strings.TrimSuffix(m.Host, ".")))
			}
		case "SRV":
			var records []*net.SRV
			_, records, err = net.DefaultResolver.LookupSRV(ctx, "", "", name)
			for _, r := range records {
				answers = append(answers, fmt.Sprintf("%d %d %d %s", r.Priority, r.Weight, r.Port, strings.TrimSuffix(r.Target, ".")))
			}
		case "NS":
			var ns []*net.NS
			ns, err = net.DefaultResolver.LookupNS(ctx, name)
			for _, n := range ns {
				answers = append(answers, strings.TrimSuffix(n.Host, "."))
			}
		}
		sort.Strings(answers)
		if answers == nil {
			answers = []string{}
		}
		if len(answers) > 64 {
			answers = answers[:64]
		}
		data := map[string]any{"name": a.Name, "recordType": typ, "answers": answers}
		if err != nil {
			data["resolved"] = false
			return Result{OK: true, Data: data}, nil
		}
		data["resolved"], data["answers"] = len(answers) > 0, answers
		return Result{OK: true, Data: data}, nil
	}, nil
}

func netTimeout(ms int, job time.Duration) time.Duration {
	d := time.Duration(ms) * time.Millisecond
	if d <= 0 {
		d = 5 * time.Second
	}
	if job > 0 && d > job {
		d = job
	}
	return d
}

func classify(ctx context.Context, err error) string {
	var dns *net.DNSError
	switch {
	case err == nil:
		return "unknown"
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.Errno(10061)):
		return "connection_refused"
	case errors.As(err, &dns) && dns.IsNotFound:
		return "dns_not_found"
	case errors.As(err, &dns):
		return "dns_error"
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "refused"):
		return "connection_refused"
	case strings.Contains(msg, "unreachable"), strings.Contains(msg, "no route"):
		return "unreachable"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "timed out"):
		return "timeout"
	}
	return "network_error"
}
