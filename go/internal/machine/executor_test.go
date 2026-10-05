package machine

import (
	"context"
	"encoding/json"
	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/machine/ops"
)

func TestAuditTargetRedactsCredentialArgv(t *testing.T) {
	raw := json.RawMessage(`{"container":"web","argv":["/bin/tool","--password","separate-password-canary","--token=inline-token-canary","ordinary"]}`)
	for _, op := range []string{ops.OpExec, ops.OpContainerExec} {
		target := auditTarget(op, raw)
		b, err := json.Marshal(target)
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{"separate-password-canary", "inline-token-canary"} {
			if strings.Contains(string(b), secret) {
				t.Fatal("audit must not contain credential arguments")
			}
		}
		argv := target["argv"].([]string)
		if argv[0] != "/bin/tool" || argv[1] != "--password" || argv[2] != "[REDACTED]" || argv[4] != "ordinary" {
			t.Fatalf("noncredential argv structure must be retained: %v", argv)
		}
	}
}

func TestExecFailureWireIncludesUnknownExitCodeAndOutput(t *testing.T) {
	for _, op := range []string{ops.OpExec, ops.OpContainerExec} {
		j := &job{op: op}
		b, err := json.Marshal(j.resultBody(ops.Failure("unavailable", "fixture executable unavailable")))
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]any
		if err := json.Unmarshal(b, &wire); err != nil {
			t.Fatal(err)
		}
		data := wire["data"].(map[string]any)
		if v, ok := data["exitCode"]; !ok || v != nil {
			t.Fatalf("an unobserved exit code must be explicit null: %s", b)
		}
		output := wire["output"].(map[string]any)
		if output["stdout"] != "" || output["stderr"] != "" || output["truncated"] != false || output["exitCode"] != nil {
			t.Fatalf("missing output must have the exec shape: %s", b)
		}
	}
}

func TestWriteWirePreservesUncertainCustodyWithoutOutput(t *testing.T) {
	j := &job{op: ops.OpFileWrite}
	data := map[string]any{"error": "mutation_uncertain", "phase": "rename", "effect": "unknown", "postcondition": "unverified", "backupRef": "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	wire := j.resultBody(ops.Result{OK: false, Data: data, Err: "file.write rename: unknown"})
	if wire["operation"] != ops.OpFileWrite || wire["output"] != nil {
		t.Fatal("write wire must preserve semantic operation without exec output")
	}
	b, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if json.Unmarshal(b, &decoded) != nil {
		t.Fatal("write receipt is not JSON")
	}
	receipt := decoded["data"].(map[string]any)
	if receipt["effect"] != "unknown" || receipt["backupRef"] != data["backupRef"] {
		t.Fatal("uncertain mutation custody was discarded")
	}
	raw := json.RawMessage(`{"path":"/opt/customer/settings.txt","contentRef":"settings","contentVersion":"v1","expectedSha256":null}`)
	target := auditTarget(ops.OpFileWrite, raw)
	if target["path"] != "/opt/customer/settings.txt" || target["content"] != nil || target["contentRef"] != nil {
		t.Fatal("write audit target must contain metadata only")
	}
}

func TestWriteAuditCompletionFailureIsUncertain(t *testing.T) {
	audit, err := OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	audit.Close()
	e := &Executor{now: time.Now, audit: audit, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	receipt := "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	j := &job{e: e, op: ops.OpFileWrite, timeout: time.Second, run: func(context.Context) (ops.Result, error) {
		return ops.Result{OK: true, Data: map[string]any{"effect": "committed", "phase": "verified", "postcondition": "verified", "transactionRef": receipt, "backupRef": receipt}}, nil
	}}
	body := j.Run(context.Background(), nil)
	if body.Status != agent.StatusFailed {
		t.Fatal("write claimed success without completion audit custody")
	}
	data := body.Result.(map[string]any)["data"].(map[string]any)
	if data["effect"] != "unknown" || data["phase"] != "audit" || data["backupRef"] != receipt {
		t.Fatal("completion audit failure lost uncertain receipt")
	}
}

func TestUploadWireAndAuditPreserveMetadataOnlyUncertainty(t *testing.T) {
	j := &job{op: ops.OpFileUpload}
	data := map[string]any{"error": "mutation_uncertain", "phase": "rename", "effect": "unknown", "postcondition": "unverified", "transactionRef": "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	wire := j.resultBody(ops.Result{Data: data, Err: "file.upload rename: unknown"})
	if wire["operation"] != ops.OpFileUpload || wire["output"] != nil || wire["data"].(map[string]any)["transactionRef"] != data["transactionRef"] {
		t.Fatal("upload wire lost mutation custody")
	}
	target := auditTarget(ops.OpFileUpload, json.RawMessage(`{"path":"/opt/customer/model.bin","sourceRef":"model","sourceVersion":"v1","expectedSha256":null}`))
	if target["path"] != "/opt/customer/model.bin" || target["sourceRef"] != nil || target["sourcePath"] != nil || target["bytes"] != nil {
		t.Fatal("upload audit exposed source custody")
	}
}

func TestUploadAuditCompletionFailureRetainsUncertainReceipt(t *testing.T) {
	audit, err := OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	audit.Close()
	e := &Executor{now: time.Now, audit: audit, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	receipt := "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	j := &job{e: e, op: ops.OpFileUpload, timeout: time.Second, run: func(context.Context) (ops.Result, error) {
		return ops.Result{OK: true, Data: map[string]any{"effect": "committed", "phase": "verified", "postcondition": "verified", "transactionRef": receipt}}, nil
	}}
	body := j.Run(context.Background(), nil)
	data := body.Result.(map[string]any)["data"].(map[string]any)
	if body.Status != agent.StatusFailed || body.Error != "file.upload audit: unknown" || data["transactionRef"] != receipt || data["effect"] != "unknown" {
		t.Fatal("audit failure claimed accepted upload completion")
	}
}

func TestPackageCancellationRetainsUnknownOriginalIntent(t *testing.T) {
	audit, e := OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	defer audit.Close()
	ex := &Executor{now: time.Now, audit: audit, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	receipt := "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	j := &job{e: ex, op: ops.OpPackageInstall, id: "package_request", opID: "package_operation", timeout: time.Second, run: func(context.Context) (ops.Result, error) {
		return ops.PackageInstallFailure("unknown", receipt), context.Canceled
	}}
	body := j.Run(ctx, nil)
	data := body.Result.(map[string]any)["data"].(map[string]any)
	if body.Status != agent.StatusFailed || data["transactionRef"] != receipt || data["effect"] != "unknown" || body.Result.(map[string]any)["output"] != nil {
		t.Fatal("cancelled package delivery lost effect custody")
	}
}
func TestPackageCompletionAuditFailureCannotClaimSuccess(t *testing.T) {
	audit, e := OpenAudit(filepath.Join(t.TempDir(), "audit.jsonl"))
	if e != nil {
		t.Fatal(e)
	}
	audit.Close()
	ex := &Executor{now: time.Now, audit: audit, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ref := "pi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	j := &job{e: ex, op: ops.OpPackageInstall, timeout: time.Second, run: func(context.Context) (ops.Result, error) {
		return ops.Result{OK: true, Data: map[string]any{"transactionRef": ref, "effect": "committed", "phase": "verified", "postcondition": "verified"}}, nil
	}}
	body := j.Run(context.Background(), nil)
	data := body.Result.(map[string]any)["data"].(map[string]any)
	if body.Status != agent.StatusFailed || data["effect"] != "unknown" || data["phase"] != "audit" || data["transactionRef"] != ref {
		t.Fatal("package completion audit loss became success")
	}
}
