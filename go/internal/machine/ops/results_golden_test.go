package ops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These are results produced by the operation code over fixtures, not hand-written
// TS data or live-host claims. Set ZENITH_UPDATE_MACHINE_GOLDENS=1 to regenerate.
// TS parses the same files and checks equality after parsing (no stripped fields).
type goldenRunner struct{ exitCode int }

func (r goldenRunner) Run(_ context.Context, s CmdSpec) (CmdResult, error) {
	if len(s.Args) > 0 && s.Args[0] == "show" {
		return CmdResult{Stdout: []byte("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\nNRestarts=2\nExecMainStatus=0\nResult=success\nActiveEnterTimestamp=Wed 2026-09-30 10:00:00 UTC\n")}, nil
	}
	if len(s.Args) > 0 && s.Args[0] == "restart" {
		return CmdResult{}, nil
	}
	return CmdResult{Stdout: []byte("fixture output\n"), ExitCode: r.exitCode}, nil
}

type goldenResolver struct{}

func (goldenResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if host == "missing.example" {
		return nil, &net.DNSError{IsNotFound: true}
	}
	return []netip.Addr{netip.MustParseAddr("10.0.0.4")}, nil
}

type goldenHTTP func(*http.Request) (*http.Response, error)

func (f goldenHTTP) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func goldenDocker() *Docker {
	d := &Docker{hc: &http.Client{Transport: goldenHTTP(func(r *http.Request) (*http.Response, error) {
		body := `{}`
		status := 200
		switch r.URL.Path {
		case "/containers/json":
			body = `[{"Id":"0123456789abcdef","Names":["/web"],"Image":"nginx:1.27","Created":1790762400,"State":"running","Status":"Up 2 hours"}]`
		case "/containers/web/json":
			body = `{"Id":"0123456789abcdef","Name":"/web","Config":{"Image":"nginx:1.27","Tty":true},"State":{"Status":"running","Running":true,"ExitCode":0,"StartedAt":"2026-09-30T10:00:00Z","FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy"}},"RestartCount":2}`
		case "/containers/web/logs":
			body = "fixture log\n"
		case "/containers/web/exec":
			body = `{"Id":"abcdef0123456789"}`
			status = 201
		case "/exec/abcdef0123456789/json":
			body = `{"Running":false,"ExitCode":0}`
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(bytes.NewBufferString(body))}, nil
	})}}
	d.dialContext = func(context.Context, string, string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			req, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				return
			}
			io.Copy(io.Discard, req.Body)
			req.Body.Close()
			io.WriteString(server, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
			content := []byte("fixture exec\n")
			frame := make([]byte, 8)
			frame[0] = 1
			binary.BigEndian.PutUint32(frame[4:], uint32(len(content)))
			server.Write(append(frame, content...))
		}()
		return client, nil
	}
	return d
}

func TestResultGoldens(t *testing.T) {
	root := t.TempDir()
	write := func(rel, text string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("meminfo", "MemTotal: 8192 kB\nMemAvailable: 4096 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n")
	write("uptime", "12345.67 0\n")
	write("loadavg", "0.5 0.2 0.1 1/2 1\n")
	write("sys/kernel/osrelease", "6.8.0-fixture\n")
	write("sys/fs/file-nr", "100 10 1000\n")
	write("net/dev", "eth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0\n")
	write("mounts", "/dev/test / ext4 rw 0 0\n")
	write("1/stat", "1 (fixture) S 0 1 1 0 0 0 0 0 0 0 20 10 0 0 0 0 1 0 100 0 0\n")
	write("1/status", "Uid: 1000\nVmRSS: 128 kB\n")
	write("os-release", "ID=fixture\nVERSION_ID=1\nPRETTY_NAME=Fixture Linux\n")
	e := &Env{ProcRoot: root, OSRelease: filepath.Join(root, "os-release"), Runner: goldenRunner{}, Resolver: goldenResolver{}, Docker: goldenDocker(),
		Now: func() time.Time { return time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC) }, hostname: func() (string, error) { return "fixture-host", nil }, cpuCount: func() int { return 2 }, arch: "amd64", statfs: func(string) (uint64, uint64, uint64, bool) { return 8192 * 1024, 4096 * 1024, 4096 * 1024, true },
		Cfg: Config{Containers: ContainersConfig{Enabled: true}, Exec: ExecConfig{Enabled: true}, Services: ServicesConfig{RestartAllow: []string{"nginx.service"}}},
	}
	cases := []struct {
		op   string
		args map[string]any
	}{
		{OpInspect, map[string]any{}}, {OpProcessList, map[string]any{"limit": 50, "sortBy": "cpu"}},
		{OpServiceStatus, map[string]any{"unit": "nginx.service"}}, {OpServiceRestart, map[string]any{"unit": "nginx.service"}},
		{OpContainerList, map[string]any{"all": false, "limit": 100}}, {OpContainerInspect, map[string]any{"container": "web"}},
		{OpContainerLogs, map[string]any{"container": "web", "lines": 200, "timestamps": false, "since": "15m"}},
		{OpContainerExec, map[string]any{"container": "web", "argv": []string{"/bin/echo", "hello"}, "timeoutSec": 5}},
		{OpFileRead, map[string]any{"path": "/srv/fixture.conf", "maxBytes": 65536}},
		{OpPortCheck, map[string]any{"host": "missing.example", "port": 443, "timeoutSec": 5}},
		{OpDNSCheck, map[string]any{"name": "app.example", "recordType": "A"}},
		{OpMetrics, map[string]any{}}, {OpLogs, map[string]any{"unit": "nginx.service", "since": "2d", "lines": 200}},
		{OpExec, map[string]any{"argv": []string{"/bin/echo", "hello"}, "timeoutSec": 5}},
	}
	for _, c := range cases {
		t.Run(c.op, func(t *testing.T) {
			var res Result
			if c.op == OpFileRead {
				res = fileReadResult("/srv/fixture.conf", 8, []byte("fixture\n"), false)
			} else {
				raw, _ := json.Marshal(c.args)
				run, err := e.Prepare(c.op, &Request{Args: raw, Timeout: 30 * time.Second, MaxOutputBytes: 65536})
				if err != nil {
					t.Fatal(err)
				}
				res, err = run(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				if !res.OK {
					t.Fatalf("%+v", res)
				}
			}
			compareGolden(t, c.op, map[string]any{"operation": c.op, "args": c.args, "result": res})
		})
	}
	t.Run("failure", func(t *testing.T) {
		compareGolden(t, "failure", map[string]any{"operation": OpServiceStatus, "args": map[string]any{"unit": "nginx.service"}, "result": Failure("command_failed", "fixture command failed")})
	})
	t.Run("binary", func(t *testing.T) {
		compareGolden(t, "file.read-binary", map[string]any{"operation": OpFileRead, "args": map[string]any{"path": "/srv/fixture.bin", "maxBytes": 65536}, "result": fileReadResult("/srv/fixture.bin", 3, []byte{0, 255, 1}, false)})
	})
	t.Run("dns-unresolved", func(t *testing.T) {
		args := map[string]any{"name": "missing.example", "recordType": "A"}
		raw, _ := json.Marshal(args)
		run, err := e.Prepare(OpDNSCheck, &Request{Args: raw, Timeout: 30 * time.Second, MaxOutputBytes: 65536})
		if err != nil {
			t.Fatal(err)
		}
		res, err := run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		compareGolden(t, "network.dnsCheck-unresolved", map[string]any{"operation": OpDNSCheck, "args": args, "result": res})
	})
	t.Run("exec-failed", func(t *testing.T) {
		copyEnv := *e
		copyEnv.Runner = goldenRunner{exitCode: 3}
		args := cases[len(cases)-1].args
		raw, _ := json.Marshal(args)
		run, err := copyEnv.Prepare(OpExec, &Request{Args: raw, Timeout: 30 * time.Second, MaxOutputBytes: 65536})
		if err != nil {
			t.Fatal(err)
		}
		res, err := run(context.Background())
		if err != nil || res.OK {
			t.Fatalf("expected a failed command result, error %v", err)
		}
		compareGolden(t, "machine.exec-failed", map[string]any{"operation": OpExec, "args": args, "result": res})
	})
	t.Run("package.install", func(t *testing.T) {
		// The mutation itself runs only in the native package helper (package machine); this pins the
		// result contract that helper emits for a first verified install, bound to the real profile digest.
		p := packageModelProfile(t)
		args := PackageInstallArgs{ProfileRef: p.ProfileRef, ProfileVersion: p.ProfileVersion}
		res := Result{OK: true, Data: map[string]any{"profileRef": p.ProfileRef, "profileVersion": p.ProfileVersion, "package": p.Package, "version": p.Version,
			"changed": true, "phase": "verified", "effect": "committed", "postcondition": "verified", "transactionRef": "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
		compareGolden(t, OpPackageInstall, map[string]any{"operation": OpPackageInstall, "args": args, "result": res})
	})
	t.Run("file.write-filesystem", compareFileWriteGoldens)
	t.Run("service.configure-filesystem", compareServiceConfigureGolden)
}

// File writes must come from actual Linux filesystem execution. Opaque
// transaction IDs are normalized only after checking retained custody files.
type fileWriteGoldenFixture struct {
	name   string
	args   fileWriteArgs
	result Result
}

func compareFileWriteGoldens(t *testing.T) {
	if !fileWritePlatform() && os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1" {
		t.Fatal("successful file.write golden generation requires actual unprivileged Linux; non-Linux refusal is not mutation mapper proof")
	}
	for _, fixture := range fileWriteGoldenFixtures(t) {
		compareGolden(t, fixture.name, map[string]any{"operation": OpFileWrite, "args": fixture.args, "result": fixture.result})
	}
}

func compareGolden(t *testing.T, name string, v any) {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := filepath.Join("..", "testdata", "results", name+".json")
	if os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, b) {
		t.Fatalf("%s differs; regenerate with ZENITH_UPDATE_MACHINE_GOLDENS=1\n%s", path, b)
	}
}
