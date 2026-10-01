package machine

import (
	"encoding/json"
	"strings"
	"testing"

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
