/** Current security docs pin active controls; the archived audit is historical evidence only. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, read } from "./markdown";

const source = (rel: string): string => read(path.join(REPO_ROOT, rel));
const current = source("docs/platform/THREAT-MODEL.md").split("## Archived WS-SEC audit")[0];

describe("current security documentation", () => {
  const controls = [
    ["SEC-F1", "src/lib/agent-access/control/journal-pg.ts", "and workspace_id = ${workspace} and subject = ${subject}", "tests/security/mcp-v2-tenant-isolation.test.ts"],
    ["SEC-F2", "src/lib/tofu/workspace.ts", "(?!__proto__$)", "tests/security/tofu-workspace-injection.test.ts"],
    ["SEC-F3", "src/lib/tofu/workspace.ts", "assertProviderConfig(input.providerConfig)", "tests/security/tofu-workspace-injection.test.ts"],
    ["SEC-F4 / SEC-F5", "src/lib/tofu/expression-policy.ts", "const scan = scanHclTemplate(source)", "tests/security/tofu-workspace-injection.test.ts"],
    ["SEC-F6", "src/lib/tofu/env.ts", "names.some((name) => !OPERATOR_ENV.has(name))", "tests/security/tofu-runner-env.test.ts"],
    ["SEC-F7", "src/lib/tofu/plan.ts", "\\p{Cf}", "tests/security/tofu-secrets.test.ts"],
    ["SEC-F8", "policy/rego/lib.rego", 'agent_initiated if input.principal.kind in {"integration", "navigator"}', "tests/security/policy-invariants.test.ts"],
    ["SEC-F10", "src/lib/credentials/aws/broker.ts", 'return SAFE_ERROR_NAMES.has(name) ? name : "Error"', "tests/security/credential-boundaries.test.ts"],
    ["SEC-F11", "src/lib/observability/sources/http.ts", "const mapped = /^::ffff:", "tests/security/signal-boundaries.test.ts"],
    ["SEC-F12", "src/lib/workflows/client.ts", "const payload = workflowPayload(input,", "tests/security/workflow-history.test.ts"],
    ["SEC-F13", "src/lib/reconcile/core.ts", "desired: scrubValue(field.desired)", "tests/security/reconcile-value-boundaries.test.ts"],
    ["SEC-R1", "src/lib/actions/core.ts", '"Compose import diagnostic omitted because source text may contain secrets."', "tests/security/audit-secret-leakage.test.ts"],
    ["SEC-R2", "src/lib/server/errors.ts", "const err = safeRequestError(raw)", "tests/security/request-error-logging.test.ts"],
  ];

  it.each(controls)("%s names its active source control and ordinary regression suite", (finding, file, control, test) => {
    const row = current.split("\n").find((line) => line.startsWith(`| ${finding} |`));
    expect(row, finding).toBeDefined();
    // F3's table points at the guard module; assembly must actually call it.
    expect(current).toContain(finding === "SEC-F3" ? "src/lib/tofu/provider-config.ts" : file);
    expect(row).toContain(test);
    expect(source(file)).toContain(control);
    const regression = source(test);
    expect(regression).toMatch(/\bit\(/);
    expect(regression).not.toMatch(new RegExp(`it\\.fails\\(["']${finding.replaceAll("/", "\\/")}`));
  });

  it("keeps live gates and runtime limits distinct from source fixes and historical counts", () => {
    expect(current).toContain("This sync did not run the security suites");
    expect(current).toContain("SEC-F9 is closed by a runtime pin");
    expect(source("tests/security/runtime-sanity.test.ts")).toContain('it("SEC-F9');
    expect(source("tests/security/runtime-sanity.test.ts")).not.toContain('it.fails("SEC-F9');
    const archived = source("docs/platform/THREAT-MODEL.md").split("## Archived WS-SEC audit")[1];
    expect(archived).toContain("verification count below is historical");
    expect(current).toContain("no payload codec encrypts Temporal history");
  });
});
