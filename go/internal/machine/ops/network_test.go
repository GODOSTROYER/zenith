package ops_test

import (
	"context"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

type fakeResolver map[string][]netip.Addr

func (f fakeResolver) LookupNetIP(_ context.Context, network, host string) ([]netip.Addr, error) {
	addrs, ok := f[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	var out []netip.Addr
	for _, a := range addrs {
		if (network == "ip4" && !a.Is4()) || (network == "ip6" && !a.Is6()) {
			continue
		}
		out = append(out, a)
	}
	if len(out) == 0 {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return out, nil
}

func TestPortCheckOpenClosedAndMetadataDenial(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	e := &ops.Env{Resolver: fakeResolver{
		"rebind.example.com": {netip.MustParseAddr("169.254.169.254")},
		"app.internal":       {netip.MustParseAddr("127.0.0.1")},
	}}
	res := runOp(t, e, ops.OpPortCheck, map[string]any{"host": "127.0.0.1", "port": port})
	if res.Data["open"] != true {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpPortCheck, map[string]any{"host": "app.internal", "port": port})
	if res.Data["open"] != true {
		t.Fatalf("loopback targets are legitimate on the host itself: %v", res.Data)
	}
	l.Close()
	res = runOp(t, e, ops.OpPortCheck, map[string]any{"host": "127.0.0.1", "port": port, "timeoutSec": 1})
	if res.Data["open"] != false || res.Data["reason"] != "connection_refused" {
		t.Fatalf("%v", res.Data)
	}

	for _, host := range []string{"169.254.169.254", "169.254.170.2", "fd00:ec2::254", "fe80::1", "metadata.google.internal", "instance-data", "::ffff:169.254.169.254"} {
		_, err := prep(t, e, ops.OpPortCheck, map[string]any{"host": host, "port": 80})
		wantCode(t, err, protocol.CodeGuardDenied)
	}
	// rebinding: the name resolves to the metadata address, caught after resolution
	run, err := prep(t, e, ops.OpPortCheck, map[string]any{"host": "rebind.example.com", "port": 80})
	if err != nil {
		t.Fatal(err)
	}
	_, err = run(context.Background())
	wantCode(t, err, protocol.CodeGuardDenied)

	for _, args := range []map[string]any{{"host": "x", "port": 0}, {"host": "x", "port": 70000}, {"host": "a b", "port": 1}, {"host": "", "port": 1}, {"host": "x", "port": 1, "proto": "udp"}} {
		if _, err := prep(t, e, ops.OpPortCheck, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
}

func TestDNSCheck(t *testing.T) {
	e := &ops.Env{Resolver: fakeResolver{
		"api.example.com":    {netip.MustParseAddr("10.0.1.5"), netip.MustParseAddr("10.0.1.4"), netip.MustParseAddr("2001:db8::1")},
		"rebind.example.com": {netip.MustParseAddr("169.254.169.254")},
	}}
	res := runOp(t, e, ops.OpDNSCheck, map[string]any{"name": "api.example.com"})
	answers := res.Data["answers"].([]string)
	if res.Data["resolved"] != true || len(answers) != 2 || answers[0] != "10.0.1.4" {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpDNSCheck, map[string]any{"name": "api.example.com", "recordType": "AAAA"})
	if a := res.Data["answers"].([]string); len(a) != 1 || a[0] != "2001:db8::1" {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpDNSCheck, map[string]any{"name": "missing.example.com"})
	if res.Data["resolved"] != false || len(res.Data["answers"].([]string)) != 0 || len(res.Data) != 4 {
		t.Fatalf("%v", res.Data)
	}
	run, _ := prep(t, e, ops.OpDNSCheck, map[string]any{"name": "rebind.example.com"})
	_, err := run(context.Background())
	wantCode(t, err, protocol.CodeGuardDenied)
	_, err = prep(t, e, ops.OpDNSCheck, map[string]any{"name": "metadata.google.internal"})
	wantCode(t, err, protocol.CodeGuardDenied)
	for _, args := range []map[string]any{{"name": "x.example.com", "recordType": "BAD"}, {"name": "bad name"}, {"name": "x.example.com", "server": "8.8.8.8"}} {
		if _, err := prep(t, e, ops.OpDNSCheck, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
}

// Real systemd and journald, gated: they exist on most Linux hosts and in WSL
// with systemd, but not in CI containers. Set ZENITH_TEST_SYSTEMD=1.
func TestRealSystemctlAndJournalctl(t *testing.T) {
	if os.Getenv("ZENITH_TEST_SYSTEMD") != "1" {
		t.Skip("set ZENITH_TEST_SYSTEMD=1 on a host running systemd to run against real systemctl/journalctl")
	}
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Skip("no systemctl")
	}
	e := &ops.Env{}
	res := runOp(t, e, ops.OpServiceStatus, map[string]any{"unit": "systemd-journald.service"})
	if res.Data["loadState"] != "loaded" || res.Data["activeState"] != "active" {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpServiceStatus, map[string]any{"unit": "zenith-no-such-unit-xyz.service"})
	if res.Data["loadState"] != "not-found" {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpLogs, map[string]any{"lines": 5, "since": "1d"})
	if res.Data["lines"].(int) < 1 && !strings.Contains(res.Data["content"].(string), "No entries") {
		t.Fatalf("%v", res.Data)
	}
	res = runOp(t, e, ops.OpLogs, map[string]any{"unit": "systemd-journald.service", "lines": 3})
	if res.Data["unit"] != "systemd-journald.service" {
		t.Fatalf("%v", res.Data)
	}
}
