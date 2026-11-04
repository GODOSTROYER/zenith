package ops

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

func init() {
	register(Operation{Name: OpContainerList, Prepare: prepareContainerList})
	register(Operation{Name: OpContainerInspect, Prepare: prepareContainerInspect})
	register(Operation{Name: OpContainerLogs, Prepare: prepareContainerLogs})
	register(Operation{Name: OpContainerExec, Prepare: prepareContainerExec})
}

// DefaultDockerSocket is the Docker Engine unix socket.
const DefaultDockerSocket = "/var/run/docker.sock"

// Docker talks to the Docker Engine API over a unix socket (no client
// library). Only the read-only endpoints needed by the container operations
// plus exec are used; nothing here can create, start, stop or remove
// containers, or touch images, volumes or networks.
type Docker struct {
	socket      string
	hc          *http.Client
	dialContext func(context.Context, string, string) (net.Conn, error)
}

// NewDocker builds a client for the socket path.
func NewDocker(socket string) *Docker {
	if socket == "" {
		socket = DefaultDockerSocket
	}
	return &Docker{
		socket: socket,
		hc: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
				},
				DisableCompression: true,
				// One short request per operation: never keep sockets to the
				// daemon open between operations.
				DisableKeepAlives: true,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (d *Docker) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker_unavailable: %s", redact.String(clip(unwrapURL(err).Error(), 200)))
	}
	return resp, nil
}

func unwrapURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

func (d *Docker) getJSON(ctx context.Context, path string, out any) error {
	resp, err := d.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return errors.New("container_not_found")
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker_error: HTTP %d %s", resp.StatusCode, redact.String(dockerMessage(b)))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out)
}

func dockerMessage(b []byte) string {
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &m) == nil && m.Message != "" {
		return clip(m.Message, 200)
	}
	return clip(strings.TrimSpace(string(b)), 200)
}

var containerRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

func checkContainer(id string) error {
	if !containerRe.MatchString(id) {
		return invalid("container must be a container id or name ([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})")
	}
	return nil
}

func (e *Env) requireContainers() error {
	if !e.Cfg.Containers.Enabled {
		return disabled("container operations are disabled: set containers.enabled on this machine")
	}
	return nil
}

func (e *Env) docker() *Docker {
	if e.Docker != nil {
		return e.Docker
	}
	return NewDocker(e.Cfg.Containers.Socket)
}

/* ---------------------------------- list ----------------------------------- */

type listArgs struct {
	All           bool   `json:"all"`
	Limit         int    `json:"limit"`
	LabelSelector string `json:"labelSelector"`
}

func prepareContainerList(e *Env, req *Request) (Runnable, error) {
	if err := e.requireContainers(); err != nil {
		return nil, err
	}
	var a listArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if a.Limit == 0 {
		a.Limit = 100
	}
	if a.Limit < 1 || a.Limit > 200 {
		return nil, invalid("limit must be between 1 and 200")
	}
	if a.LabelSelector != "" {
		return nil, invalid("labelSelector is Kubernetes-only")
	}
	return func(ctx context.Context) (Result, error) {
		var cs []struct {
			ID      string   `json:"Id"`
			Names   []string `json:"Names"`
			Image   string   `json:"Image"`
			ImageID string   `json:"ImageID"`
			Created int64    `json:"Created"`
			State   string   `json:"State"`
			Status  string   `json:"Status"`
			Ports   []struct {
				IP          string `json:"IP"`
				PrivatePort int    `json:"PrivatePort"`
				PublicPort  int    `json:"PublicPort"`
				Type        string `json:"Type"`
			} `json:"Ports"`
			Labels map[string]string `json:"Labels"`
		}
		q := url.Values{"limit": {strconv.Itoa(a.Limit + 1)}}
		if a.All {
			q.Set("all", "1")
		}
		if err := e.docker().getJSON(ctx, "/containers/json?"+q.Encode(), &cs); err != nil {
			return Result{}, err
		}
		truncated := len(cs) > a.Limit
		if truncated {
			cs = cs[:a.Limit]
		}
		out := make([]map[string]any, 0, len(cs))
		for _, c := range cs {
			name := ""
			if len(c.Names) > 0 {
				name = strings.TrimPrefix(c.Names[0], "/")
			}
			out = append(out, map[string]any{"id": clip(c.ID, 300), "name": clip(name, 200), "image": clip(c.Image, 300), "createdAt": time.Unix(c.Created, 0).UTC().Format(time.RFC3339), "state": clip(c.State, 64), "status": clip(c.Status, 200)})
		}
		return Result{OK: true, Data: map[string]any{"truncated": truncated, "containers": out}}, nil
	}, nil
}

func short(id string) string { return clip(id, 12) }

/* --------------------------------- inspect --------------------------------- */

type inspectArgs struct {
	Container string `json:"container"`
}

type inspectDoc struct {
	ID           string `json:"Id"`
	Name         string `json:"Name"`
	Created      string `json:"Created"`
	Image        string `json:"Image"`
	RestartCount int    `json:"RestartCount"`
	State        struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
		OOMKilled  bool   `json:"OOMKilled"`
		Dead       bool   `json:"Dead"`
		Pid        int    `json:"Pid"`
		ExitCode   int    `json:"ExitCode"`
		Error      string `json:"Error"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		RestartPolicy struct {
			Name              string `json:"Name"`
			MaximumRetryCount int    `json:"MaximumRetryCount"`
		} `json:"RestartPolicy"`
		Memory      int64  `json:"Memory"`
		Privileged  bool   `json:"Privileged"`
		NetworkMode string `json:"NetworkMode"`
	} `json:"HostConfig"`
	Config struct {
		Image  string            `json:"Image"`
		Tty    bool              `json:"Tty"`
		Labels map[string]string `json:"Labels"`
		// Env, Cmd and Entrypoint are deliberately NOT declared: environment
		// variables and command lines routinely carry secrets, and this
		// struct is the only thing that ever decodes the daemon's answer.
	} `json:"Config"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func prepareContainerInspect(e *Env, req *Request) (Runnable, error) {
	if err := e.requireContainers(); err != nil {
		return nil, err
	}
	var a inspectArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := checkContainer(a.Container); err != nil {
		return nil, err
	}
	return func(ctx context.Context) (Result, error) {
		var d inspectDoc
		if err := e.docker().getJSON(ctx, "/containers/"+url.PathEscape(a.Container)+"/json", &d); err != nil {
			return Result{}, err
		}
		data := map[string]any{"id": clip(d.ID, 300), "name": clip(strings.TrimPrefix(d.Name, "/"), 200), "image": clip(d.Config.Image, 300), "state": clip(d.State.Status, 64), "running": d.State.Running, "oomKilled": d.State.OOMKilled, "exitCode": d.State.ExitCode, "startedAt": clip(d.State.StartedAt, 64), "finishedAt": clip(d.State.FinishedAt, 64), "restartCount": max(0, d.RestartCount)}
		if d.State.Health != nil {
			data["health"] = clip(d.State.Health.Status, 64)
		}
		return Result{OK: true, Data: data}, nil
	}, nil
}

/* ----------------------------------- logs ---------------------------------- */

type containerLogsArgs struct {
	Container  string `json:"container"`
	Lines      int    `json:"lines"`
	Since      string `json:"since"`
	Timestamps bool   `json:"timestamps"`
}

func prepareContainerLogs(e *Env, req *Request) (Runnable, error) {
	if err := e.requireContainers(); err != nil {
		return nil, err
	}
	var a containerLogsArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := checkContainer(a.Container); err != nil {
		return nil, err
	}
	if a.Lines == 0 {
		a.Lines = 200
	}
	if a.Lines < 1 || a.Lines > 5000 {
		return nil, invalid("lines must be between 1 and 5000")
	}
	q := url.Values{"tail": {strconv.Itoa(a.Lines)}, "stdout": {"1"}, "stderr": {"1"}}
	if a.Timestamps {
		q.Set("timestamps", "1")
	}
	if a.Since != "" {
		s, err := sinceUnix(a.Since, e.now())
		if err != nil {
			return nil, err
		}
		q.Set("since", strconv.FormatInt(s, 10))
	}
	limit := req.MaxOutputBytes
	return func(ctx context.Context) (Result, error) {
		d := e.docker()
		var doc inspectDoc
		if err := d.getJSON(ctx, "/containers/"+url.PathEscape(a.Container)+"/json", &doc); err != nil {
			return Result{}, err
		}
		resp, err := d.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(a.Container)+"/logs?"+q.Encode(), nil)
		if err != nil {
			return Result{}, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			return Result{}, fmt.Errorf("docker_error: HTTP %d %s", resp.StatusCode, redact.String(dockerMessage(b)))
		}
		var text strings.Builder
		readCap := limit*2 + 4096
		trunc, err := demuxTo(resp.Body, doc.Config.Tty, readCap, func(stream byte, p []byte) {
			text.Write(p)
		})
		if err != nil {
			return Result{}, fmt.Errorf("docker_stream_error: %v", err)
		}
		out, lines, cut := redactedTail(text.String(), limit)
		return Result{OK: true, Data: map[string]any{"container": a.Container, "lines": lines, "truncated": cut || trunc, "content": out}}, nil
	}, nil
}

func sinceUnix(s string, now time.Time) (int64, error) {
	d, err := relativeSince(s)
	if err != nil {
		return 0, err
	}
	return now.Add(-d).Unix(), nil
}

// demuxTo reads Docker's multiplexed log/exec stream (8-byte frame headers:
// stream type, three zero bytes, big-endian length) or, for a TTY, raw bytes,
// calling emit per chunk. It stops after readCap bytes and reports whether
// data was cut.
func demuxTo(r io.Reader, tty bool, readCap int64, emit func(stream byte, p []byte)) (truncated bool, err error) {
	var total int64
	if tty {
		buf := make([]byte, 32<<10)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				if total+int64(n) > readCap {
					emit(1, buf[:readCap-total])
					return true, nil
				}
				total += int64(n)
				emit(1, buf[:n])
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					return false, nil
				}
				return false, err
			}
		}
	}
	br := bufio.NewReaderSize(r, 64<<10)
	var hdr [8]byte
	for {
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				return false, nil
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return false, nil
			}
			return false, err
		}
		size := int64(binary.BigEndian.Uint32(hdr[4:]))
		if size > 1<<24 {
			return false, fmt.Errorf("implausible frame size %d", size)
		}
		remaining := size
		for remaining > 0 {
			chunk := int64(32 << 10)
			if chunk > remaining {
				chunk = remaining
			}
			buf := make([]byte, chunk)
			n, err := io.ReadFull(br, buf)
			if n > 0 {
				if total+int64(n) > readCap {
					emit(hdr[0], buf[:readCap-total])
					return true, nil
				}
				total += int64(n)
				emit(hdr[0], buf[:n])
			}
			if err != nil {
				if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
					return false, nil
				}
				return false, err
			}
			remaining -= int64(n)
		}
	}
}

/* ----------------------------------- exec ---------------------------------- */

type containerExecArgs struct {
	Container  string   `json:"container"`
	Argv       []string `json:"argv"`
	TimeoutSec int      `json:"timeoutSec"`
}

var (
	execUserRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	execIDRe   = regexp.MustCompile(`^[0-9a-f]{8,128}$`)
)

func validateArgv(argv []string) error {
	if len(argv) == 0 || len(argv) > 32 {
		return invalid("argv must contain between 1 and 32 elements")
	}
	total := 0
	for _, a := range argv {
		if len(a) > 4096 || strings.ContainsRune(a, 0) {
			return invalid("argv elements must be at most 4096 bytes and contain no NUL")
		}
		total += len(a)
	}
	if argv[0] == "" {
		return invalid("argv[0] must not be empty")
	}
	if total > 32<<10 {
		return invalid("argv is too large")
	}
	return nil
}

func prepareContainerExec(e *Env, req *Request) (Runnable, error) {
	if err := e.requireContainers(); err != nil {
		return nil, err
	}
	if !e.Cfg.Exec.Enabled {
		return nil, disabled("container.exec is disabled: exec.enabled is false on this machine")
	}
	var a containerExecArgs
	if err := decodeArgs(req.Args, &a); err != nil {
		return nil, err
	}
	if err := checkContainer(a.Container); err != nil {
		return nil, err
	}
	if err := validateArgv(a.Argv); err != nil {
		return nil, err
	}
	if err := checkExecTimeout(a.TimeoutSec, req.Timeout); err != nil {
		return nil, err
	}
	limit := req.MaxOutputBytes
	return func(ctx context.Context) (Result, error) {
		ctx, cancel := execContext(ctx, a.TimeoutSec)
		defer cancel()
		d := e.docker()
		var created struct {
			ID string `json:"Id"`
		}
		body := map[string]any{"AttachStdout": true, "AttachStderr": true, "AttachStdin": false, "Tty": false, "Cmd": a.Argv}
		resp, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(a.Container)+"/exec", body)
		if err != nil {
			return Result{}, err
		}
		cb, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			return Result{}, errors.New("container_not_found")
		}
		if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
			return Result{}, fmt.Errorf("docker_error: HTTP %d %s", resp.StatusCode, redact.String(dockerMessage(cb)))
		}
		if err := json.Unmarshal(cb, &created); err != nil || !execIDRe.MatchString(created.ID) {
			return Result{}, errors.New("docker_error: unexpected exec create response")
		}
		var so, se limitedBuffer
		so.limit, se.limit = limit/2, limit/2
		trunc, err := d.execStream(ctx, created.ID, func(stream byte, p []byte) {
			if stream == 2 {
				_, _ = se.Write(p)
			} else {
				_, _ = so.Write(p)
			}
		}, limit*2+4096)
		if err != nil {
			return Result{}, err
		}
		var info struct {
			ExitCode int  `json:"ExitCode"`
			Running  bool `json:"Running"`
		}
		ictx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := d.getJSON(ictx, "/exec/"+created.ID+"/json", &info); err != nil {
			return Result{}, err
		}
		if info.Running {
			return Result{}, errors.New("output_limit: Docker exec is still running after the stream closed")
		}
		code := info.ExitCode
		res := Result{OK: code == 0, Data: map[string]any{"exitCode": code}, Output: &Output{
			Stdout: redact.String(strings.ToValidUTF8(so.buf.String(), "?")), Stderr: redact.String(strings.ToValidUTF8(se.buf.String(), "?")),
			ExitCode: &code, Truncated: so.trunc || se.trunc || trunc,
		}}
		if !res.OK {
			f := Failure("command_failed", fmt.Sprintf("command exited %d", code))
			f.Data["exitCode"] = code
			res.Data, res.Err = f.Data, f.Err
		}
		return res, nil
	}, nil
}

// execStream starts an exec instance and demultiplexes its output. The Engine
// API answers with a hijacked connection (101 Upgrade, or 200 with a raw
// stream), so this speaks HTTP over the unix socket by hand. On cancellation
// the connection is closed; the Docker Engine has no API to kill an exec'd
// process, so a timed-out command may keep running inside the container.
func (d *Docker) execStream(ctx context.Context, execID string, emit func(stream byte, p []byte), readCap int64) (bool, error) {
	dial := (&net.Dialer{Timeout: 5 * time.Second}).DialContext
	if d.dialContext != nil {
		dial = d.dialContext
	}
	conn, err := dial(ctx, "unix", d.socket)
	if err != nil {
		return false, fmt.Errorf("docker_unavailable: %s", redact.String(clip(err.Error(), 200)))
	}
	defer conn.Close()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-stop:
		}
	}()
	payload := []byte(`{"Detach":false,"Tty":false}`)
	req := fmt.Sprintf("POST /exec/%s/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: %d\r\n\r\n", execID, len(payload))
	if _, err := conn.Write(append([]byte(req), payload...)); err != nil {
		return false, fmt.Errorf("docker_error: %v", err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, fmt.Errorf("docker_error: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(br, 512))
		return false, fmt.Errorf("docker_error: exec start HTTP %d %s", resp.StatusCode, redact.String(dockerMessage(b)))
	}
	trunc, err := demuxTo(br, false, readCap, emit)
	if ctx.Err() != nil {
		return trunc, ctx.Err()
	}
	if err != nil {
		return trunc, fmt.Errorf("docker_stream_error: %v", err)
	}
	return trunc, nil
}
