package kinds

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// memSink collects log lines.
type memSink struct {
	mu    sync.Mutex
	lines []string
}

func (m *memSink) Line(stream, line string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lines = append(m.lines, stream+": "+line)
}

func (m *memSink) String() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(m.lines, "\n")
}

// fakeTofuScript stands in for OpenTofu so the runner's own logic (env
// allowlist, plan retention, redaction, limits, timeouts) is tested without a
// network or a real provider. Behavior is selected by a workspace file
// behavior.txt (a .txt file is an accepted workspace file).
const fakeTofuScript = `#!/bin/sh
cmd="$1"
log() { [ -n "$FAKE_TOFU_LOG" ] && echo "$*" >> "$FAKE_TOFU_LOG"; return 0; }
behavior=""
[ -f behavior.txt ] && behavior=$(cat behavior.txt)
case "$cmd" in
  version)
    echo "{\"terraform_version\":\"${FAKE_TOFU_VERSION:-1.12.5}\"}" ;;
  init)
    log "init $*"
    echo "Initializing the backend..."
    case "$behavior" in *envdump*) env | sort;; esac
    case "$behavior" in *leak*) echo "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"; echo "key id AKIAIOSFODNN7EXAMPLE";; esac
    case "$behavior" in *pemleak*) echo "-----BEGIN PRIVATE KEY-----"; echo "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"; echo "-----END PRIVATE KEY-----";; esac
    case "$behavior" in *initfail*) echo "Error: boom" >&2; exit 1;; esac
    case "$behavior" in *chatty*) i=0; while [ $i -lt 5000 ]; do echo "line $i of noisy provider output"; i=$((i+1)); done;; esac
    mkdir -p .terraform ;;
  plan)
    out=""
    for a in "$@"; do case "$a" in -out=*) out="${a#-out=}";; esac; done
    log "plan $*"
    case "$behavior" in *slow*) sleep 30;; esac
    echo "PLAN:$$:$(date +%s%N):$behavior" > "$out"
    echo "Plan: 1 to add, 0 to change, 0 to destroy." ;;
  show)
    for a in "$@"; do f="$a"; done
    log "show $f"
    if [ -f "$f" ]; then sum=$(cksum < "$f" | cut -d' ' -f1); else sum=missing; fi
    case "$behavior" in *bigplan*) printf '{"format_version":"1.2","pad":"%s"}\n' "$(head -c 20000 /dev/zero | tr '\0' 'a')"; exit 0;; esac
    printf '{"format_version":"1.2","terraform_version":"1.12.5","resource_changes":[],"planfile_cksum":"%s"}\n' "$sum" ;;
  apply)
    for a in "$@"; do f="$a"; done
    log "apply $(cksum < "$f")"
    echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed."
    case "$behavior" in *applyfail*) echo "Error: apply exploded" >&2; exit 1;; esac ;;
  *) echo "unexpected command $cmd" >&2; exit 2 ;;
esac
`

type tofuHarness struct {
	t        *testing.T
	tofu     *Tofu
	work     string
	stateDir string
	logFile  string
	env      map[string]string
}

func newTofuHarness(t *testing.T, mutate func(*TofuConfig)) *tofuHarness {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake OpenTofu is a POSIX shell script")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "tofu")
	if err := os.WriteFile(bin, []byte(fakeTofuScript), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &tofuHarness{t: t, work: filepath.Join(dir, "work"), stateDir: filepath.Join(dir, "state"), logFile: filepath.Join(dir, "calls.log"), env: map[string]string{}}
	if err := os.MkdirAll(h.work, 0o700); err != nil {
		t.Fatal(err)
	}
	h.env["FAKE_TOFU_LOG"] = h.logFile
	cfg := TofuConfig{Binary: bin, WorkDir: h.work, PassEnv: []string{"FAKE_TOFU_LOG", "FAKE_TOFU_VERSION"}}
	if mutate != nil {
		mutate(&cfg)
	}
	tofu, err := NewTofu(cfg, h.stateDir, TofuDeps{Getenv: func(k string) string { return h.env[k] }})
	if err != nil {
		t.Fatal(err)
	}
	h.tofu = tofu
	return h
}

func (h *tofuHarness) calls() string {
	b, _ := os.ReadFile(h.logFile)
	return string(b)
}

const s3BackendDoc = `{"terraform":{"backend":{"s3":{"bucket":"state","key":"k","region":"us-east-1"}}},"resource":{"terraform_data":{"x":{"input":"a"}}}}`
const localDoc = `{"resource":{"terraform_data":{"x":{"input":"a"}}}}`

type wsFile struct{ path, content string }

// payload builds a tofu.run payload with a correct configDigest.
func payload(command string, files []wsFile, extra map[string]any) map[string]any {
	var cf []ConfigFile
	var tf []map[string]string
	for _, f := range files {
		cf = append(cf, ConfigFile{Path: f.path, Content: []byte(f.content)})
		tf = append(tf, map[string]string{"path": f.path, "contentB64": base64.StdEncoding.EncodeToString([]byte(f.content))})
	}
	p := map[string]any{"command": command, "files": tf, "lockfile": "# lock\n", "configDigest": ConfigDigest(cf)}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func (h *tofuHarness) prepare(capability string, pl map[string]any, maxOut int64) (Runnable, error) {
	raw, _ := json.Marshal(pl)
	if maxOut == 0 {
		maxOut = 1 << 20
	}
	return h.tofu.Prepare(&Request{JTI: "job_t", OperationID: "op_t", WorkspaceID: "ws_t", Capability: capability, Payload: raw, Timeout: 30 * time.Second, MaxOutputBytes: maxOut})
}

func (h *tofuHarness) run(capability string, pl map[string]any) (Outcome, *memSink) {
	h.t.Helper()
	return h.runWith(capability, pl, 0, 30*time.Second)
}

func (h *tofuHarness) runWith(capability string, pl map[string]any, maxOut int64, timeout time.Duration) (Outcome, *memSink) {
	h.t.Helper()
	run, err := h.prepare(capability, pl, maxOut)
	if err != nil {
		h.t.Fatalf("prepare: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	sink := &memSink{}
	return run(ctx, sink), sink
}

func resultMap(t *testing.T, o Outcome) map[string]any {
	t.Helper()
	raw, err := json.Marshal(o.Result)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func expectPrepareCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected rejection %s, got success", code)
	}
	if got := protocol.CodeOf(err); got != code {
		t.Fatalf("expected %s, got %s (%v)", code, got, err)
	}
}

var basicFiles = []wsFile{{"main.tf.json", s3BackendDoc}}

func TestTofuPlanThenShowThenApply(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := basicFiles

	o, sink := h.run("infrastructure.plan", payload("plan", files, nil))
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("plan: %+v", o)
	}
	res := resultMap(t, o)
	planSHA, _ := res["planFileSha256"].(string)
	if len(planSHA) != 64 {
		t.Fatalf("plan result must carry planFileSha256: %v", res)
	}
	pj, _ := res["planJson"].(map[string]any)
	if pj == nil || pj["format_version"] != "1.2" {
		t.Fatalf("plan result must carry planJson as a JSON document: %v", res["planJson"])
	}
	if !strings.Contains(res["output"].(string), "Plan: 1 to add") {
		t.Fatalf("output: %v", res["output"])
	}
	if !strings.Contains(sink.String(), "stdout: Plan: 1 to add") {
		t.Fatalf("log stream should carry tool output: %s", sink)
	}
	calls := h.calls()
	if !strings.Contains(calls, "init -input=false -no-color -lockfile=readonly") {
		t.Fatalf("init must run with -lockfile=readonly: %s", calls)
	}
	if !strings.Contains(calls, "plan -input=false -no-color -lock-timeout=60s -out=") {
		t.Fatalf("plan flags: %s", calls)
	}

	// show returns the same plan JSON for the retained file
	so, _ := h.run("infrastructure.plan", payload("show", files, map[string]any{"planFileSha256": planSHA}))
	if so.Status != agent.StatusSucceeded {
		t.Fatalf("show: %+v", so)
	}
	if resultMap(t, so)["planJson"].(map[string]any)["planfile_cksum"] != pj["planfile_cksum"] {
		t.Fatal("show must describe the very file plan produced")
	}

	// apply applies exactly that file
	ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": planSHA}))
	if ao.Status != agent.StatusSucceeded || ao.ExitCode == nil || *ao.ExitCode != 0 {
		t.Fatalf("apply: %+v", ao)
	}
	if !strings.Contains(resultMap(t, ao)["output"].(string), "Apply complete!") {
		t.Fatal("apply output missing")
	}
	// single use: the plan is gone
	ao2, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": planSHA}))
	if ao2.Status != agent.StatusRejected || !strings.Contains(ao2.Error, "no plan") {
		t.Fatalf("a consumed plan must not be applied twice: %+v", ao2)
	}
	entries, _ := os.ReadDir(h.work)
	if len(entries) != 0 {
		t.Fatalf("per-job temp directories must be removed, found %d", len(entries))
	}
}

func TestTofuApplyRequiresThePlanThisRunnerProduced(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := basicFiles
	o, _ := h.run("infrastructure.plan", payload("plan", files, nil))
	planSHA := resultMap(t, o)["planFileSha256"].(string)
	cfgDigest := payload("plan", files, nil)["configDigest"].(string)

	t.Run("wrong sha", func(t *testing.T) {
		ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": strings.Repeat("0", 64)}))
		if ao.Status != agent.StatusRejected {
			t.Fatalf("%+v", ao)
		}
	})
	t.Run("different configuration", func(t *testing.T) {
		other := []wsFile{{"main.tf.json", strings.Replace(s3BackendDoc, `"a"`, `"b"`, 1)}}
		ao, _ := h.run("infrastructure.apply", payload("apply", other, map[string]any{"planFileSha256": planSHA}))
		if ao.Status != agent.StatusRejected {
			t.Fatalf("a plan for one configDigest must not apply another: %+v", ao)
		}
	})
	t.Run("different lockfile", func(t *testing.T) {
		ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": planSHA, "lockfile": "# other lock\n"}))
		if ao.Status != agent.StatusRejected || !strings.Contains(ao.Error, "lockfile") {
			t.Fatalf("%+v", ao)
		}
	})
	t.Run("tampered plan file", func(t *testing.T) {
		planPath := filepath.Join(h.stateDir, "tofu-plans", cfgDigest+"."+planSHA+".tfplan")
		orig, err := os.ReadFile(planPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(planPath, []byte("PLAN:tampered"), 0o600); err != nil {
			t.Fatal(err)
		}
		ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": planSHA}))
		if ao.Status != agent.StatusRejected || !strings.Contains(ao.Error, "integrity") {
			t.Fatalf("a modified plan file must fail the integrity check: %+v", ao)
		}
		_ = os.WriteFile(planPath, orig, 0o600)
	})
	t.Run("expired plan", func(t *testing.T) {
		h2 := newTofuHarness(t, func(c *TofuConfig) { c.PlanMaxAgeSec = 60 })
		now := time.Now()
		h2.tofu.now = func() time.Time { return now }
		h2.tofu.plans.now = h2.tofu.now
		o, _ := h2.run("infrastructure.plan", payload("plan", files, nil))
		sha := resultMap(t, o)["planFileSha256"].(string)
		now = now.Add(2 * time.Minute)
		ao, _ := h2.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": sha}))
		if ao.Status != agent.StatusRejected || !strings.Contains(ao.Error, "expired") {
			t.Fatalf("%+v", ao)
		}
	})
	t.Run("the intact plan still applies", func(t *testing.T) {
		ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": planSHA}))
		if ao.Status != agent.StatusSucceeded {
			t.Fatalf("%+v", ao)
		}
	})
}

func TestTofuPrepareRejections(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := basicFiles
	sha := strings.Repeat("a", 64)
	t.Run("configDigest mismatch", func(t *testing.T) {
		p := payload("plan", files, nil)
		p["configDigest"] = strings.Repeat("b", 64)
		_, err := h.prepare("infrastructure.plan", p, 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
		if !strings.Contains(err.Error(), "configDigest mismatch") {
			t.Fatal(err)
		}
	})
	t.Run("tampered file content after digest", func(t *testing.T) {
		p := payload("plan", files, nil)
		p["files"] = []map[string]string{{"path": "main.tf.json", "contentB64": base64.StdEncoding.EncodeToString([]byte(`{"resource":{"aws_iam_user":{"evil":{}}}}`))}}
		_, err := h.prepare("infrastructure.plan", p, 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("plan capability cannot apply", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("apply", files, map[string]any{"planFileSha256": sha}), 0)
		expectPrepareCode(t, err, protocol.CodeNotAllowed)
	})
	t.Run("unrelated capability", func(t *testing.T) {
		_, err := h.prepare("logs.read", payload("plan", files, nil), 0)
		expectPrepareCode(t, err, protocol.CodeNotAllowed)
	})
	t.Run("unknown command", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("destroy", files, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("apply without planFileSha256", func(t *testing.T) {
		_, err := h.prepare("infrastructure.apply", payload("apply", files, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("planFileSha256 on plan", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", files, map[string]any{"planFileSha256": sha}), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("unknown payload field", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", files, map[string]any{"extra": true}), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("path traversal", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", []wsFile{{"../evil.tf.json", "{}"}}, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("lockfile smuggled as a file", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", []wsFile{{".terraform.lock.hcl", "x"}}, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("duplicate path", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", []wsFile{{"a.tf.json", "{}"}, {"a.tf.json", "{}"}}, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("file and directory collide", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", []wsFile{{"a.json", "{}"}, {"a.json/b.json", "{}"}}, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("empty workspace", func(t *testing.T) {
		_, err := h.prepare("infrastructure.plan", payload("plan", nil, nil), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
	t.Run("provisioner is refused", func(t *testing.T) {
		bad := []wsFile{{"main.tf.json", `{"resource":{"null_resource":{"x":{"provisioner":{"local-exec":{"command":"id"}}}}}}`}}
		_, err := h.prepare("infrastructure.plan", payload("plan", bad, nil), 0)
		expectPrepareCode(t, err, protocol.CodeNotAllowed)
	})
	t.Run("apply needs a remote backend", func(t *testing.T) {
		_, err := h.prepare("infrastructure.apply", payload("apply", []wsFile{{"main.tf.json", localDoc}}, map[string]any{"planFileSha256": sha}), 0)
		expectPrepareCode(t, err, protocol.CodeNotAllowed)
		// ...but planning against no backend is fine
		if _, err := h.prepare("infrastructure.plan", payload("plan", []wsFile{{"main.tf.json", localDoc}}, nil), 0); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("destroy only with plan", func(t *testing.T) {
		_, err := h.prepare("infrastructure.destroy", payload("apply", files, map[string]any{"planFileSha256": sha, "destroy": true}), 0)
		expectPrepareCode(t, err, protocol.CodeInvalidPayload)
	})
}

func TestTofuDestroyPlanNeedsDestroyCapability(t *testing.T) {
	h := newTofuHarness(t, nil)
	o, _ := h.run("infrastructure.plan", payload("plan", basicFiles, map[string]any{"destroy": true}))
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", o)
	}
	if !strings.Contains(h.calls(), "-destroy") {
		t.Fatal("a destroy plan must pass -destroy")
	}
	sha := resultMap(t, o)["planFileSha256"].(string)
	ao, _ := h.run("infrastructure.apply", payload("apply", basicFiles, map[string]any{"planFileSha256": sha}))
	if ao.Status != agent.StatusRejected || !strings.Contains(ao.Error, "infrastructure.destroy") {
		t.Fatalf("a destroy plan must not run under infrastructure.apply: %+v", ao)
	}
	ao, _ = h.run("infrastructure.destroy", payload("apply", basicFiles, map[string]any{"planFileSha256": sha}))
	if ao.Status != agent.StatusSucceeded {
		t.Fatalf("%+v", ao)
	}
}

func TestTofuEnvironmentIsAllowlisted(t *testing.T) {
	h := newTofuHarness(t, func(c *TofuConfig) { c.PassEnv = append(c.PassEnv, "MY_PROVIDER_REGION") })
	h.env["ZENITH_REGISTRATION_TOKEN"] = "zrt_supersecrettoken1234"
	h.env["ZENITH_CONTROL_SIGNING_JWK"] = "jwk-secret"
	h.env["DATABASE_URL"] = "postgres://user:pw@db/x"
	h.env["AWS_REGION"] = "ap-south-1"
	h.env["AWS_ROLE_ARN"] = "arn:aws:iam::123456789012:role/zenith"
	h.env["MY_PROVIDER_REGION"] = "eu-west-1"
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "envdump"}}
	o, _ := h.run("infrastructure.plan", payload("plan", files, nil))
	out := resultMap(t, o)["output"].(string)
	for _, must := range []string{"AWS_REGION=ap-south-1", "AWS_ROLE_ARN=arn:aws:iam::123456789012:role/zenith", "MY_PROVIDER_REGION=eu-west-1", "TF_IN_AUTOMATION=1", "TF_INPUT=0"} {
		if !strings.Contains(out, must) {
			t.Errorf("the child environment should contain %s\n%s", must, out)
		}
	}
	for _, mustNot := range []string{"ZENITH_", "zrt_", "jwk-secret", "DATABASE_URL", "postgres://"} {
		if strings.Contains(out, mustNot) {
			t.Errorf("the child environment must not contain %q\n%s", mustNot, out)
		}
	}
	if !strings.Contains(out, "HOME="+h.work) {
		t.Errorf("HOME must be a job-private directory, not the runner's home\n%s", out)
	}
}

func TestTofuPassEnvRefusesZenithVariables(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tofu")
	_ = os.WriteFile(bin, []byte(fakeTofuScript), 0o755)
	_, err := NewTofu(TofuConfig{Binary: bin, PassEnv: []string{"ZENITH_REGISTRATION_TOKEN"}}, dir, TofuDeps{})
	if err == nil {
		t.Fatal("ZENITH_* variables must never be passable to tofu")
	}
	_, err = NewTofu(TofuConfig{Binary: "relative/tofu"}, dir, TofuDeps{})
	if err == nil {
		t.Fatal("the binary path must be absolute")
	}
}

func TestTofuOutputIsRedactedInResultAndLogs(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "leak pemleak"}}
	o, sink := h.run("infrastructure.plan", payload("plan", files, nil))
	out := resultMap(t, o)["output"].(string)
	for _, secret := range []string{"wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "AKIAIOSFODNN7EXAMPLE", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"} {
		if strings.Contains(out, secret) || strings.Contains(sink.String(), secret) {
			t.Errorf("secret %q leaked into the result or the log stream", secret)
		}
	}
	if !strings.Contains(out, "REDACTED") {
		t.Errorf("expected redaction markers in %q", out)
	}
}

func TestTofuVersionIsPinned(t *testing.T) {
	h := newTofuHarness(t, nil)
	h.env["FAKE_TOFU_VERSION"] = "1.13.0"
	o, _ := h.run("infrastructure.plan", payload("plan", basicFiles, nil))
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "tofu_version_mismatch") {
		t.Fatalf("a different OpenTofu version must be refused: %+v", o)
	}
	if strings.Contains(h.calls(), "init") {
		t.Fatal("nothing may run under the wrong version")
	}
}

func TestTofuInitFailureReportsExitCodeAndOutput(t *testing.T) {
	h := newTofuHarness(t, nil)
	o, _ := h.run("infrastructure.plan", payload("plan", []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "initfail"}}, nil))
	if o.Status != agent.StatusFailed || o.ExitCode == nil || *o.ExitCode != 1 || !strings.Contains(o.Error, "tofu init failed") {
		t.Fatalf("%+v", o)
	}
	if !strings.Contains(resultMap(t, o)["output"].(string), "Error: boom") {
		t.Fatal("output should include the tool's error text")
	}
	if strings.Contains(h.calls(), "plan ") {
		t.Fatal("plan must not run after a failed init")
	}
}

func TestTofuApplyFailureConsumesThePlanAnyway(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "applyfail"}}
	o, _ := h.run("infrastructure.plan", payload("plan", files, nil))
	sha := resultMap(t, o)["planFileSha256"].(string)
	ao, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": sha}))
	if ao.Status != agent.StatusFailed || ao.ExitCode == nil || *ao.ExitCode != 1 {
		t.Fatalf("%+v", ao)
	}
	again, _ := h.run("infrastructure.apply", payload("apply", files, map[string]any{"planFileSha256": sha}))
	if again.Status != agent.StatusRejected {
		t.Fatal("a plan whose apply failed midway must not be re-applied blindly")
	}
}

func TestTofuOutputIsBoundedAndKeepsHeadAndTail(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "chatty"}}
	o, _ := h.runWith("infrastructure.plan", payload("plan", files, nil), 8192, 30*time.Second)
	res := resultMap(t, o)
	out := res["output"].(string)
	if res["truncated"] != true {
		t.Fatal("truncated must be reported")
	}
	if len(out) > 8192+200 {
		t.Fatalf("output is %d bytes, above the 8192 budget", len(out))
	}
	if !strings.Contains(out, "Initializing the backend") || !strings.Contains(out, "Plan: 1 to add") || !strings.Contains(out, "lines omitted") {
		t.Fatalf("head, tail and an omission marker are expected:\n%s", out[:min(len(out), 400)])
	}
}

func TestTofuPlanJSONTooLargeIsAFailureNotATruncation(t *testing.T) {
	h := newTofuHarness(t, func(c *TofuConfig) { c.MaxPlanJSONBytes = 1000 })
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "bigplan"}}
	o, _ := h.run("infrastructure.plan", payload("plan", files, nil))
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "plan_json_too_large") {
		t.Fatalf("%+v", o)
	}
}

func TestTofuTimeoutKillsTheProcessGroup(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "slow"}}
	start := time.Now()
	o, _ := h.runWith("infrastructure.plan", payload("plan", files, nil), 0, 1500*time.Millisecond)
	if o.Status != agent.StatusTimedOut {
		t.Fatalf("%+v", o)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatalf("the sleeping child must be interrupted promptly, took %s", time.Since(start))
	}
	entries, _ := os.ReadDir(h.work)
	if len(entries) != 0 {
		t.Fatal("temp dirs must be cleaned up after a timeout")
	}
}

func TestTofuCancellationReportsFailedNotTimedOut(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}, {"behavior.txt", "slow"}}
	run, err := h.prepare("infrastructure.plan", payload("plan", files, nil), 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(700 * time.Millisecond); cancel() }()
	o := run(ctx, &memSink{})
	if o.Status != agent.StatusFailed || !strings.Contains(o.Error, "cancelled") {
		t.Fatalf("%+v", o)
	}
}

func TestTofuConcurrencyIsBounded(t *testing.T) {
	h := newTofuHarness(t, nil)
	files := []wsFile{{"main.tf.json", s3BackendDoc}}
	run, _ := h.prepare("infrastructure.plan", payload("plan", files, nil), 0)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o := run(context.Background(), &memSink{})
			if o.Status != agent.StatusSucceeded {
				t.Errorf("%+v", o)
			}
		}()
	}
	wg.Wait()
}

// Real OpenTofu, gated: ZENITH_TEST_TOFU=/path/to/tofu (1.12.5). The
// terraform_data resource comes from the built-in provider, so no network or
// cloud account is needed. This verifies the argv and flags against the real
// binary, including a real plan file, `show -json` and apply.
func TestRealOpenTofuPlanShowApply(t *testing.T) {
	bin := os.Getenv("ZENITH_TEST_TOFU")
	if bin == "" {
		t.Skip("set ZENITH_TEST_TOFU=/path/to/tofu (1.12.5) to run against the real binary")
	}
	dir := t.TempDir()
	h := &tofuHarness{t: t, work: filepath.Join(dir, "work"), stateDir: filepath.Join(dir, "state"), env: map[string]string{}}
	_ = os.MkdirAll(h.work, 0o700)
	tofu, err := NewTofu(TofuConfig{Binary: bin, WorkDir: h.work, AllowEphemeralState: true}, h.stateDir, TofuDeps{})
	if err != nil {
		t.Fatal(err)
	}
	h.tofu = tofu
	files := []wsFile{{"main.tf.json", `{"resource":{"terraform_data":{"x":{"input":"hello from zenith"}}},"output":{"greeting":{"value":"${terraform_data.x.input}"}}}`}}
	p := payload("plan", files, nil)
	p["lockfile"] = ""

	o, _ := h.run("infrastructure.plan", p)
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("plan: %+v\n%v", o, resultMap(t, o)["output"])
	}
	res := resultMap(t, o)
	pj := res["planJson"].(map[string]any)
	if pj["terraform_version"] != "1.12.5" {
		t.Fatalf("plan JSON: %v", pj["terraform_version"])
	}
	if changes, _ := pj["resource_changes"].([]any); len(changes) != 1 {
		t.Fatalf("expected one resource change, got %v", pj["resource_changes"])
	}
	sha := res["planFileSha256"].(string)

	ap := payload("apply", files, map[string]any{"planFileSha256": sha})
	ap["lockfile"] = ""
	ao, _ := h.run("infrastructure.apply", ap)
	if ao.Status != agent.StatusSucceeded || !strings.Contains(resultMap(t, ao)["output"].(string), "Apply complete!") {
		t.Fatalf("apply: %+v\n%v", ao, resultMap(t, ao)["output"])
	}
}

// Real OpenTofu with a real provider from the public registry, gated:
// ZENITH_TEST_TOFU=/path/to/tofu and ZENITH_TEST_TOFU_NETWORK=1. It proves the
// lockfile is enforced (-lockfile=readonly: a wrong hash makes the job fail), the
// optional provider cache works, and apply of a retained plan works with a real
// provider. It downloads hashicorp/random (a few MB) from registry.opentofu.org.
func TestRealOpenTofuWithProviderAndLockfile(t *testing.T) {
	bin := os.Getenv("ZENITH_TEST_TOFU")
	if bin == "" || os.Getenv("ZENITH_TEST_TOFU_NETWORK") != "1" {
		t.Skip("set ZENITH_TEST_TOFU=/path/to/tofu and ZENITH_TEST_TOFU_NETWORK=1 to run against the public registry")
	}
	dir := t.TempDir()
	files := []wsFile{
		{"versions.tf.json", `{"terraform":{"required_providers":{"random":{"source":"hashicorp/random","version":"= 3.7.2"}}}}`},
		{"main.tf.json", `{"resource":{"random_pet":{"p":{"length":2}}}}`},
	}
	// Produce a real lockfile the way the control plane would: init + providers lock.
	seed := filepath.Join(dir, "seed")
	if err := os.MkdirAll(seed, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(seed, f.path), []byte(f.content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-input=false", "-no-color"}, {"providers", "lock", "-platform=linux_amd64", "-platform=linux_arm64"}} {
		cmd := exec.Command(bin, args...)
		cmd.Dir = seed
		cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + dir, "TF_IN_AUTOMATION=1"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("tofu %v: %v\n%s", args, err, out)
		}
	}
	lock, err := os.ReadFile(filepath.Join(seed, ".terraform.lock.hcl"))
	if err != nil {
		t.Fatal(err)
	}

	h := &tofuHarness{t: t, work: filepath.Join(dir, "work"), stateDir: filepath.Join(dir, "state"), env: map[string]string{}}
	_ = os.MkdirAll(h.work, 0o700)
	cache := filepath.Join(dir, "plugin-cache")
	_ = os.MkdirAll(cache, 0o700)
	tofu, err := NewTofu(TofuConfig{Binary: bin, WorkDir: h.work, PluginCacheDir: cache, AllowEphemeralState: true}, h.stateDir, TofuDeps{})
	if err != nil {
		t.Fatal(err)
	}
	h.tofu = tofu

	p := payload("plan", files, map[string]any{"lockfile": string(lock)})
	o, _ := h.runWith("infrastructure.plan", p, 0, 4*time.Minute)
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("plan: %+v\n%v", o, resultMap(t, o)["output"])
	}
	res := resultMap(t, o)
	changes, _ := res["planJson"].(map[string]any)["resource_changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["type"] != "random_pet" {
		t.Fatalf("plan JSON: %v", res["planJson"])
	}
	if entries, _ := os.ReadDir(cache); len(entries) == 0 {
		t.Fatal("the provider cache should have been populated")
	}
	sha := res["planFileSha256"].(string)

	ap := payload("apply", files, map[string]any{"lockfile": string(lock), "planFileSha256": sha})
	ao, _ := h.runWith("infrastructure.apply", ap, 0, 4*time.Minute)
	if ao.Status != agent.StatusSucceeded || !strings.Contains(resultMap(t, ao)["output"].(string), "Apply complete!") {
		t.Fatalf("apply: %+v\n%v", ao, resultMap(t, ao)["output"])
	}

	// A lockfile whose hashes do not match the downloaded provider must fail init.
	bad := strings.ReplaceAll(string(lock), "h1:", "h1:AAAA")
	badPlan := payload("plan", files, map[string]any{"lockfile": bad})
	bo, _ := h.runWith("infrastructure.plan", badPlan, 0, 4*time.Minute)
	if bo.Status != agent.StatusFailed || !strings.Contains(resultMap(t, bo)["output"].(string), "checksum") {
		// With the shared cache OpenTofu verifies the recorded hashes when the provider is
		// instantiated (plan), without it during init; either way the job must fail.
		t.Fatalf("a tampered lockfile must make the job fail on a checksum mismatch: %+v", bo)
	}
}
