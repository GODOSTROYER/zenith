// Package netguard refuses connections to cloud instance-metadata services
// and other link-local targets. Both agents use it for every outbound probe
// (runner probe.http/tcp/dns, zenithd network.portCheck/dnsCheck).
//
// The check is applied to the RESOLVED addresses and the connection is made
// to the exact address that was checked, so a hostname that resolves to
// 169.254.169.254 (or that flips between a public and a metadata address, the
// DNS-rebinding pattern) cannot slip through: there is no second resolution
// between check and dial.
//
// The credential fetchers (ECS/EKS container endpoints, IMDSv2) do NOT use
// this package: they deliberately talk to link-local addresses and are a
// separate, fixed-destination code path.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"
)

// Resolver is the subset of *net.Resolver the guard needs; tests inject a
// fake to simulate DNS rebinding.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// BlockedError is returned when a target is refused by policy.
type BlockedError struct{ Reason string }

func (e *BlockedError) Error() string { return "blocked: " + e.Reason }

// IsBlocked reports whether err is (or wraps) a BlockedError.
func IsBlocked(err error) bool {
	var b *BlockedError
	return errors.As(err, &b)
}

var deniedPrefixes = mustPrefixes(
	"169.254.0.0/16",     // IPv4 link-local, includes 169.254.169.254 (AWS/GCP/Azure/OCI IMDS) and 169.254.170.2 (ECS)
	"fe80::/10",          // IPv6 link-local
	"fd00:ec2::254/128",  // AWS IMDS over IPv6
	"168.63.129.16/32",   // Azure wire server
	"100.100.100.200/32", // Alibaba Cloud metadata
	"0.0.0.0/8",          // "this network"
	"224.0.0.0/4",        // IPv4 multicast
	"ff00::/8",           // IPv6 multicast
	"255.255.255.255/32",
)

var loopbackPrefixes = mustPrefixes("127.0.0.0/8", "::1/128")

// nat64 is the well-known NAT64 prefix; an address inside it embeds an IPv4
// address in its last 32 bits.
var nat64 = netip.MustParsePrefix("64:ff9b::/96")

// deniedHosts are hostnames that name a metadata service. A name matches if
// it equals an entry or is a subdomain of an entry that contains a dot.
var deniedHosts = []string{
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"metadata.azure",
	"metadata.azure.com",
	"metadata.azure.internal",
	"metadata.tencentyun.com",
	"instance-data",
	"instance-data.ec2.internal",
}

func mustPrefixes(ss ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// Guard applies the deny rules and dials verified addresses.
type Guard struct {
	// Resolver defaults to net.DefaultResolver.
	Resolver Resolver
	// AllowLoopback permits 127.0.0.0/8 and ::1 (off by default: a probe
	// should not be able to poke the agent host's own localhost services).
	AllowLoopback bool
	// Dialer defaults to a 5 s-timeout net.Dialer.
	Dialer *net.Dialer
}

func (g *Guard) resolver() Resolver {
	if g.Resolver != nil {
		return g.Resolver
	}
	return net.DefaultResolver
}

// NormalizeHost lower-cases, strips brackets and a trailing dot.
func NormalizeHost(h string) string {
	h = strings.TrimSpace(h)
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	h = strings.TrimSuffix(h, ".")
	return strings.ToLower(h)
}

// CheckHostname refuses names that denote a metadata service.
func CheckHostname(host string) error {
	h := NormalizeHost(host)
	for _, d := range deniedHosts {
		if h == d || (strings.Contains(d, ".") && strings.HasSuffix(h, "."+d)) {
			return &BlockedError{Reason: "hostname " + d + " is a cloud metadata endpoint"}
		}
	}
	return nil
}

// CheckAddr refuses metadata / link-local / multicast / unspecified
// addresses (and loopback unless allowed). IPv4-mapped and NAT64-embedded
// IPv4 addresses are unwrapped first.
func (g *Guard) CheckAddr(a netip.Addr) error {
	a = a.Unmap()
	if a.Is6() && nat64.Contains(a) {
		b := a.As16()
		a = netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
	}
	if a.IsUnspecified() {
		return &BlockedError{Reason: "unspecified address"}
	}
	for _, p := range deniedPrefixes {
		if p.Contains(a) {
			return &BlockedError{Reason: fmt.Sprintf("address %s is in denied range %s", a, p)}
		}
	}
	if !g.AllowLoopback {
		for _, p := range loopbackPrefixes {
			if p.Contains(a) {
				return &BlockedError{Reason: "loopback addresses are not allowed"}
			}
		}
	}
	return nil
}

// Resolve returns the addresses of host, refusing the whole name if the
// hostname is denied or ANY resolved address is denied. IP literals are
// checked directly.
func (g *Guard) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	h := NormalizeHost(host)
	if h == "" {
		return nil, &BlockedError{Reason: "empty host"}
	}
	if err := CheckHostname(h); err != nil {
		return nil, err
	}
	if a, err := netip.ParseAddr(h); err == nil {
		// Strip an IPv6 zone: a zone can smuggle a scope but not change the address.
		a = a.WithZone("")
		if err := g.CheckAddr(a); err != nil {
			return nil, err
		}
		return []netip.Addr{a}, nil
	}
	addrs, err := g.resolver().LookupNetIP(ctx, "ip", h)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, &net.DNSError{Err: "no such host", Name: h, IsNotFound: true}
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		a = a.WithZone("")
		if err := g.CheckAddr(a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// DialContext resolves addr ("host:port"), checks every address, and dials
// one of the verified addresses directly. It has the signature of
// http.Transport.DialContext.
func (g *Guard) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	addrs, err := g.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	d := g.Dialer
	if d == nil {
		d = &net.Dialer{Timeout: 5 * time.Second}
	}
	var lastErr error
	for _, a := range addrs {
		if network == "tcp4" && !a.Is4() && !a.Is4In6() {
			continue
		}
		if network == "tcp6" && !a.Is6() {
			continue
		}
		c, err := d.DialContext(ctx, network, net.JoinHostPort(a.String(), port))
		if err == nil {
			return c, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no usable address")
	}
	return nil, lastErr
}
