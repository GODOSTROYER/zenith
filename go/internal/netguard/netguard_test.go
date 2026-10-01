package netguard

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

type fake map[string][]netip.Addr

func (f fake) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	a, ok := f[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return a, nil
}

func TestCheckAddr(t *testing.T) {
	g := &Guard{}
	denied := []string{
		"169.254.169.254", "169.254.170.2", "169.254.0.1", "169.254.255.255", "fe80::1", "fe80::abcd:1234", "febf::1", "fd00:ec2::254",
		"::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "168.63.129.16", "100.100.100.200", "0.0.0.0", "::", "224.0.0.1", "ff02::1", "255.255.255.255",
		"127.0.0.1", "127.255.255.254", "::1", "::ffff:127.0.0.1",
	}
	for _, s := range denied {
		if err := g.CheckAddr(netip.MustParseAddr(s)); err == nil {
			t.Errorf("%s must be denied", s)
		} else if !IsBlocked(err) {
			t.Errorf("%s: error is not a BlockedError: %v", s, err)
		}
	}
	allowed := []string{"10.0.0.5", "172.16.3.4", "192.168.1.1", "8.8.8.8", "93.184.216.34", "2001:db8::1", "fd12:3456::1", "169.253.255.255", "169.255.0.0", "100.64.0.1", "fdff::1", "fec0::1"}
	for _, s := range allowed {
		if err := g.CheckAddr(netip.MustParseAddr(s)); err != nil {
			t.Errorf("%s must be allowed: %v", s, err)
		}
	}
	lo := &Guard{AllowLoopback: true}
	for _, s := range []string{"127.0.0.1", "::1"} {
		if err := lo.CheckAddr(netip.MustParseAddr(s)); err != nil {
			t.Errorf("%s is allowed with AllowLoopback: %v", s, err)
		}
	}
	for _, s := range []string{"169.254.169.254", "fe80::1"} {
		if err := lo.CheckAddr(netip.MustParseAddr(s)); err == nil {
			t.Errorf("%s stays denied with AllowLoopback", s)
		}
	}
}

func TestCheckHostname(t *testing.T) {
	denied := []string{
		"metadata.google.internal", "METADATA.GOOGLE.INTERNAL", "metadata.google.internal.", "a.metadata.google.internal", "metadata", "instance-data", "instance-data.ec2.internal",
		"metadata.azure", "metadata.azure.com", "x.metadata.azure.com", "metadata.goog", "metadata.tencentyun.com", "[metadata.google.internal]", " metadata ",
	}
	for _, h := range denied {
		if err := CheckHostname(h); err == nil {
			t.Errorf("%q must be denied", h)
		}
	}
	allowed := []string{"example.com", "my-metadata.example.com", "metadata.example.com", "notmetadata", "instance-data-x.example.com", "google.internal", "azure.com", "api.amazonaws.com"}
	for _, h := range allowed {
		if err := CheckHostname(h); err != nil {
			t.Errorf("%q should be allowed: %v", h, err)
		}
	}
}

func TestResolveChecksEveryAddress(t *testing.T) {
	g := &Guard{Resolver: fake{
		"ok.example.com":       {netip.MustParseAddr("10.0.0.5"), netip.MustParseAddr("2001:db8::5")},
		"rebind.example.com":   {netip.MustParseAddr("169.254.169.254")},
		"mixed.example.com":    {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("169.254.169.254")},
		"mapped.example.com":   {netip.MustParseAddr("::ffff:169.254.169.254")},
		"zoned.example.com":    {netip.MustParseAddr("fe80::1%eth0")},
		"loopback.example.com": {netip.MustParseAddr("127.0.0.1")},
		"empty.example.com":    {},
	}}
	ctx := context.Background()
	if addrs, err := g.Resolve(ctx, "ok.example.com"); err != nil || len(addrs) != 2 {
		t.Fatalf("%v %v", addrs, err)
	}
	for _, h := range []string{"rebind.example.com", "mixed.example.com", "mapped.example.com", "zoned.example.com", "loopback.example.com", "metadata.google.internal", "169.254.169.254", "[fd00:ec2::254]", "fe80::1%eth0", ""} {
		if _, err := g.Resolve(ctx, h); err == nil || !IsBlocked(err) {
			t.Errorf("%q must be blocked, got %v", h, err)
		}
	}
	if _, err := g.Resolve(ctx, "empty.example.com"); err == nil {
		t.Error("an empty answer is an error")
	}
	if _, err := g.Resolve(ctx, "nxdomain.example.com"); err == nil || IsBlocked(err) {
		t.Errorf("NXDOMAIN is a DNS error, not a policy block: %v", err)
	}
	if a, err := g.Resolve(ctx, "10.1.2.3"); err != nil || len(a) != 1 {
		t.Fatalf("IP literals are checked directly: %v %v", a, err)
	}
}

// DialContext must connect to the address it checked, never re-resolving.
func TestDialConnectsToTheVerifiedAddressOnly(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	accepted := make(chan struct{}, 4)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			c.Close()
		}
	}()
	port := l.Addr().(*net.TCPAddr).Port
	lookups := 0
	res := resolverFunc(func(host string) []netip.Addr {
		lookups++
		// a rebinding resolver: the first answer is fine, later answers are the metadata address
		if lookups == 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}
		}
		return []netip.Addr{netip.MustParseAddr("169.254.169.254")}
	})
	g := &Guard{Resolver: res, AllowLoopback: true, Dialer: &net.Dialer{Timeout: 2 * time.Second}}
	c, err := g.DialContext(context.Background(), "tcp", net.JoinHostPort("flip.example.com", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("did not connect to the verified address")
	}
	if lookups != 1 {
		t.Fatalf("the name must be resolved exactly once per dial, got %d lookups", lookups)
	}
	// second dial sees the metadata answer and is refused without any connection
	if _, err := g.DialContext(context.Background(), "tcp", net.JoinHostPort("flip.example.com", strconv.Itoa(port))); err == nil || !IsBlocked(err) {
		t.Fatalf("the rebound answer must be blocked: %v", err)
	}
	if _, err := g.DialContext(context.Background(), "tcp", "no-port"); err == nil {
		t.Fatal("a malformed address is an error")
	}
}

type resolverFunc func(host string) []netip.Addr

func (f resolverFunc) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return f(host), nil
}

func TestNormalizeHost(t *testing.T) {
	cases := map[string]string{"Example.COM.": "example.com", "[::1]": "::1", "  host  ": "host", "a.b": "a.b", "": ""}
	for in, want := range cases {
		if got := NormalizeHost(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}
