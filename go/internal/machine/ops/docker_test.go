package ops_test

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

func frame(stream byte, payload string) []byte {
	h := make([]byte, 8)
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

// fakeDaemon is a tiny Docker Engine API over a unix socket, exercising the
// real HTTP-over-unix-socket code path including the hijacked exec stream.
type fakeDaemon struct {
	t        *testing.T
	sock     string
	mu       sync.Mutex
	requests []string
	execBody map[string]any
	logsQ    string
	listQ    string
}

func newFakeDaemon(t *testing.T) *fakeDaemon {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("unix sockets")
	}
	dir, err := os.MkdirTemp("", "zd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	d := &fakeDaemon{t: t, sock: filepath.Join(dir, "d.sock")}
	l, err := net.Listen("unix", d.sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(d.handle)}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	return d
}

func (d *fakeDaemon) handle(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	d.requests = append(d.requests, r.Method+" "+r.URL.Path)
	d.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/containers/json":
		d.mu.Lock()
		d.listQ = r.URL.RawQuery
		d.mu.Unlock()
		_, _ = w.Write([]byte(`[
		 {"Id":"0123456789abcdef0123456789abcdef","Names":["/web"],"Image":"nginx:1.27","ImageID":"sha256:feedfacefeedface1234","Command":"nginx -g 'daemon off;' --password=hunter2","Created":1790000000,"State":"running","Status":"Up 2 hours","Ports":[{"IP":"0.0.0.0","PrivatePort":80,"PublicPort":8080,"Type":"tcp"}],"Labels":{"com.docker.compose.service":"web","secret.label":"token=abcdef1234567890SECRET"}},
		 {"Id":"fedcba9876543210fedcba9876543210","Names":["/db"],"Image":"postgres:17","ImageID":"sha256:0123","Command":"postgres","Created":1790000100,"State":"exited","Status":"Exited (0) 1 hour ago","Ports":[],"Labels":{}}
		]`))
	case r.URL.Path == "/containers/web/json" || r.URL.Path == "/containers/tty/json":
		tty := r.URL.Path == "/containers/tty/json"
		b, _ := json.Marshal(map[string]any{
			"Id": "0123456789abcdef0123456789abcdef", "Name": "/web", "Created": "2026-09-30T10:00:00Z", "Image": "sha256:feedfacefeedface1234", "RestartCount": 3,
			"State":      map[string]any{"Status": "running", "Running": true, "Pid": 4321, "ExitCode": 0, "StartedAt": "2026-09-30T10:00:01Z", "FinishedAt": "0001-01-01T00:00:00Z", "Error": "", "Health": map[string]any{"Status": "healthy"}},
			"HostConfig": map[string]any{"RestartPolicy": map[string]any{"Name": "always", "MaximumRetryCount": 0}, "Memory": 536870912, "Privileged": false, "NetworkMode": "bridge"},
			"Config": map[string]any{
				"Image": "nginx:1.27", "Tty": tty, "Labels": map[string]string{"app": "web"},
				"Env": []string{"DATABASE_URL=postgres://user:SUPERSECRETPW@db/app", "API_KEY=sk_live_abcdef"}, "Cmd": []string{"nginx", "--password=hunter2"}, "Entrypoint": []string{"/docker-entrypoint.sh"},
			},
			"Mounts":          []map[string]any{{"Type": "bind", "Source": "/srv/web", "Destination": "/usr/share/nginx/html", "Mode": "ro", "RW": false}},
			"NetworkSettings": map[string]any{"Networks": map[string]any{"bridge": map[string]any{"IPAddress": "172.17.0.2"}}},
		})
		_, _ = w.Write(b)
	case r.URL.Path == "/containers/web/logs":
		d.mu.Lock()
		d.logsQ = r.URL.RawQuery
		d.mu.Unlock()
		w.Header().Set("Content-Type", "application/vnd.docker.raw-stream")
		_, _ = w.Write(frame(1, "2026-09-30T10:00:02Z GET / 200\n2026-09-30T10:00:03Z GET /h"))
		_, _ = w.Write(frame(1, "ealth 200\n"))
		_, _ = w.Write(frame(2, "2026-09-30T10:00:04Z error: upstream token=abcdef1234567890SECRET timed out\n"))
	case r.URL.Path == "/containers/tty/logs":
		w.Header().Set("Content-Type", "application/vnd.docker.raw-stream")
		_, _ = w.Write([]byte("raw tty line 1\nraw tty line 2\n"))
	case r.URL.Path == "/containers/web/exec" && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		d.mu.Lock()
		d.execBody = body
		d.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"Id":"abcdef0123456789"}`))
	case r.URL.Path == "/exec/abcdef0123456789/start" && r.Method == http.MethodPost:
		hj, ok := w.(http.Hijacker)
		if !ok {
			w.WriteHeader(500)
			return
		}
		conn, buf, _ := hj.Hijack()
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_, _ = buf.Write(frame(1, "hello from the container\n"))
		_, _ = buf.Write(frame(2, "warning: password=hunter2abcdef\n"))
		_ = buf.Flush()
	case r.URL.Path == "/exec/abcdef0123456789/json":
		_, _ = w.Write([]byte(`{"ExitCode":3,"Running":false}`))
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"message":"No such container"}`))
	}
}

func (d *fakeDaemon) env() *ops.Env {
	return &ops.Env{
		Docker: ops.NewDocker(d.sock),
		Cfg:    ops.Config{Containers: ops.ContainersConfig{Enabled: true, Socket: d.sock}},
	}
}

func TestContainerListSanitizesAndPaginates(t *testing.T) {
	d := newFakeDaemon(t)
	res := runOp(t, d.env(), ops.OpContainerList, map[string]any{"all": true, "limit": 1})
	if d.listQ != "all=1&limit=2" {
		t.Fatalf("query %q (limit+1 is requested to detect truncation)", d.listQ)
	}
	cs := res.Data["containers"].([]map[string]any)
	if len(cs) != 1 || res.Data["truncated"] != true || cs[0]["id"] != "0123456789abcdef0123456789abcdef" || cs[0]["name"] != "web" || cs[0]["image"] != "nginx:1.27" {
		t.Fatalf("%v", res.Data)
	}
	raw, _ := json.Marshal(res.Data)
	if strings.Contains(string(raw), "hunter2") || strings.Contains(string(raw), "abcdef1234567890SECRET") {
		t.Fatalf("command lines and secret-looking label values must not be returned: %s", raw)
	}
	res = runOp(t, d.env(), ops.OpContainerList, map[string]any{})
	if len(res.Data["containers"].([]map[string]any)) != 2 || res.Data["truncated"] != false {
		t.Fatalf("%v", res.Data)
	}
	for _, args := range []map[string]any{{"limit": 0, "all": "yes"}, {"limit": 9999}} {
		if _, err := prep(t, d.env(), ops.OpContainerList, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
}

func TestContainerInspectNeverReturnsEnvironmentOrCommand(t *testing.T) {
	d := newFakeDaemon(t)
	res := runOp(t, d.env(), ops.OpContainerInspect, map[string]any{"container": "web"})
	raw, _ := json.Marshal(res.Data)
	for _, secret := range []string{"SUPERSECRETPW", "sk_live_abcdef", "DATABASE_URL", "hunter2", "docker-entrypoint"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("%q leaked: %s", secret, raw)
		}
	}
	dd := res.Data
	if dd["name"] != "web" || dd["restartCount"] != 3 || dd["state"] != "running" || dd["running"] != true || dd["health"] != "healthy" {
		t.Fatalf("%v", dd)
	}
	for _, key := range []string{"env", "command", "mounts", "networks", "memoryLimitBytes", "labels", "envOmitted"} {
		if _, ok := dd[key]; ok {
			t.Fatalf("non-contract field %s", key)
		}
	}
	// unknown container: a failed result
	run, _ := prep(t, d.env(), ops.OpContainerInspect, map[string]any{"container": "ghost"})
	if _, err := run(context.Background()); err == nil || !strings.Contains(err.Error(), "container_not_found") {
		t.Fatalf("%v", err)
	}
}

func TestContainerNamesAreValidatedBeforeTouchingTheSocket(t *testing.T) {
	d := newFakeDaemon(t)
	for _, name := range []string{"../etc/passwd", "a b", "web;id", "-x", "", "a/b", "web\n", strings.Repeat("a", 200), "$(id)", "web?all=1", "web#frag"} {
		for _, op := range []string{ops.OpContainerInspect, ops.OpContainerLogs} {
			if _, err := prep(t, d.env(), op, map[string]any{"container": name}); err == nil {
				t.Errorf("%s %q must be rejected", op, name)
			}
		}
	}
	if len(d.requests) != 0 {
		t.Fatalf("the daemon must not have been contacted: %v", d.requests)
	}
}

func TestContainerLogsDemuxRedactAndTailLimit(t *testing.T) {
	d := newFakeDaemon(t)
	res := runOp(t, d.env(), ops.OpContainerLogs, map[string]any{"container": "web", "lines": 50, "since": "1h", "timestamps": true})
	text := res.Data["content"].(string)
	if !strings.Contains(text, "GET /health 200") || !strings.Contains(text, "upstream") || strings.Contains(text, "abcdef1234567890SECRET") || !strings.Contains(text, "REDACTED") {
		t.Fatalf("frames must be reassembled across chunk boundaries and redacted: %q", text)
	}
	if res.Data["lines"] != 3 {
		t.Fatalf("%v", res.Data)
	}
	if !strings.Contains(d.logsQ, "tail=50") || !strings.Contains(d.logsQ, "stdout=1") || !strings.Contains(d.logsQ, "stderr=1") || !strings.Contains(d.logsQ, "timestamps=1") || !strings.Contains(d.logsQ, "since=") {
		t.Fatalf("query %q", d.logsQ)
	}
	// Stream selectors are outside the normalized TS schema and must fail closed.
	if _, err := prep(t, d.env(), ops.OpContainerLogs, map[string]any{"container": "web", "stdout": false}); err == nil {
		t.Fatal("legacy stdout selector must be rejected")
	}
	// TTY containers stream raw bytes
	res = runOp(t, d.env(), ops.OpContainerLogs, map[string]any{"container": "tty"})
	if !strings.Contains(res.Data["content"].(string), "raw tty line 2") {
		t.Fatalf("%v", res.Data)
	}
	for _, args := range []map[string]any{{"container": "web", "tail": 0, "stdout": false, "stderr": false}, {"container": "web", "lines": 99999}, {"container": "web", "since": "soon"}} {
		if _, err := prep(t, d.env(), ops.OpContainerLogs, args); err == nil {
			t.Errorf("%v must be rejected", args)
		}
	}
	// the output budget keeps the newest lines
	run, _ := d.env().Prepare(ops.OpContainerLogs, &ops.Request{Args: []byte(`{"container":"web"}`), MaxOutputBytes: 60})
	r, err := run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Data["content"].(string)) > 60 || r.Data["truncated"] != true {
		t.Fatalf("%v", r.Data)
	}
}

func TestContainerOperationsAreDisabledByDefault(t *testing.T) {
	d := newFakeDaemon(t)
	e := d.env()
	e.Cfg.Containers.Enabled = false
	for _, op := range []string{ops.OpContainerList, ops.OpContainerInspect, ops.OpContainerLogs} {
		_, err := prep(t, e, op, map[string]any{"container": "web"})
		wantCode(t, err, protocol.CodeDisabledByConfig)
	}
	if len(d.requests) != 0 {
		t.Fatal("the socket must not be touched when containers are disabled")
	}
}

func TestContainerExecOverHijackedStream(t *testing.T) {
	d := newFakeDaemon(t)
	e := d.env()
	e.Cfg.Exec.Enabled = true
	res := runOp(t, e, ops.OpContainerExec, map[string]any{"container": "web", "argv": []string{"ls", "-la", "$(id)", "; reboot"}, "timeoutSec": 5})
	if res.OK || *res.Output.ExitCode != 3 {
		t.Fatalf("%+v", res)
	}
	if res.Output.Stdout != "hello from the container\n" || strings.Contains(res.Output.Stderr, "hunter2abcdef") || !strings.Contains(res.Output.Stderr, "REDACTED") {
		t.Fatalf("stdout/stderr must be demultiplexed and redacted: %+v", res.Output)
	}
	cmd := d.execBody["Cmd"].([]any)
	if len(cmd) != 4 || cmd[2] != "$(id)" || cmd[3] != "; reboot" || d.execBody["User"] != nil || d.execBody["WorkingDir"] != nil || d.execBody["Tty"] != false {
		t.Fatalf("argv must be forwarded as an array, never a string: %v", d.execBody)
	}
	bad := []map[string]any{
		{"container": "web", "argv": []string{}},
		{"container": "web", "argv": []string{"ls"}, "user": "root; id"},
		{"container": "web", "argv": []string{"ls"}, "workdir": "rel"},
		{"container": "../web", "argv": []string{"ls"}},
		{"container": "web", "argv": []string{"a\x00b"}},
		{"container": "web", "cmd": "ls"},
	}
	for _, a := range bad {
		if _, err := prep(t, e, ops.OpContainerExec, a); err == nil {
			t.Errorf("%v must be rejected", a)
		}
	}
}

func TestDockerUnavailableIsAFailedResult(t *testing.T) {
	e := &ops.Env{Cfg: ops.Config{Containers: ops.ContainersConfig{Enabled: true, Socket: filepath.Join(t.TempDir(), "nope.sock")}}}
	run, err := prep(t, e, ops.OpContainerList, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run(context.Background()); err == nil || !strings.HasPrefix(err.Error(), "docker_unavailable") {
		t.Fatalf("%v", err)
	}
}
