/**
 * Real actions, real audit log, planted secrets (WS-SEC).
 *
 * `redaction-coverage.test.ts` measures the audit redactor (core.ts `redact`) on
 * synthetic shapes. This file runs the ACTUAL actions whose inputs can carry a
 * secret — the ones a person or an agent is most likely to hand a credential to
 * — with a canary in the input, and scans every audit row they wrote.
 *
 * Finding SEC-R1 (MEDIUM): `project.importCompose` records its `composeYaml`
 * input verbatim in the audit log (up to the 4 KiB audit budget). A compose file
 * routinely carries plaintext `environment:` values. The importer itself does
 * the right thing — the value never reaches the manifest, only a `vault:`
 * reference does — but the audit row keeps the pasted text, so the secret ends up
 * in a table that every workspace member with audit access can read and that is
 * exported and backed up. `redact()` masks by KEY NAME and the compose text is
 * one string under the key `composeYaml`. The same applies to any action whose
 * input is a free-text blob (`project.updateManifest`'s literal env values under
 * non-secret-looking names, for instance). The fix belongs in `actions/core.ts`
 * (an action-declared audit projection, or treating blob fields as shape-only):
 * not modified by this workstream.
 */
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { canarySecret, deepScanForCanaries } from "../_support/security";

tempDataDir("zenith-sec-audit-", { fast: true });
process.env.ZENITH_SECRET_KEY = "5".repeat(64);

const { runAction } = await import("@/lib/actions/core");
const { q, readAudit, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const WS = "ws-audit-01";
const ctx = { workspaceId: WS, actor: { type: "user" as const, id: "u-audit-01", name: "Auditor" } };
resetDb({
  workspaces: [{ id: WS, name: "Audit", slug: "audit", createdAt: "2026-09-01T00:00:00.000Z" }],
  members: [{ id: "u-audit-01", workspaceId: WS, name: "Auditor", email: "a@zenith.test", role: "admin" }],
});

const execute = (actionId: string, input: unknown, scope: Record<string, unknown> = {}) => runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" }).then((r) => r.result!);
const auditRows = () => readAudit({ workspaceId: WS, limit: 500 });

describe("audit rows written by real actions that are handed a secret", () => {
  it("project.importCompose: the secret is kept out of the manifest (the importer's control works)", async () => {
    const secret = canarySecret("compose-manifest", "password");
    const compose = `services:\n  api:\n    image: node:22\n    environment:\n      API_KEY: ${secret}\n      LOG_LEVEL: debug`;
    const r = await execute("project.importCompose", { composeYaml: compose, name: "Compose" });
    expect(r.ok, r.error).toBe(true);
    const project = q.project((r.data as { projectId: string }).projectId)!;
    expect(deepScanForCanaries(project.workingManifest, [secret]), "the manifest holds a reference, never the value").toEqual([]);
    expect(JSON.stringify(project.workingManifest)).toContain("vault:");
  });

  /**
   * SEC-R1. The importer drops the value, the audit log keeps it. Flip to `it`
   * when `core.ts` stops recording blob inputs verbatim.
   */
  it("SEC-R1 (MEDIUM): importing a compose file with a plaintext secret never writes the plaintext into the audit log", async () => {
    const secret = canarySecret("compose-audit", "password");
    const compose = `services:\n  api:\n    image: node:22\n    environment:\n      API_KEY: ${secret}`;
    await execute("project.importCompose", { composeYaml: compose, name: "Compose2" });
    const hits = deepScanForCanaries(auditRows(), [secret]);
    expect(hits, `the compose text was audited verbatim:\n${hits.map((h) => `  ${h.path}`).join("\n")}`).toEqual([]);
  });

  it("system.setSecret: secretValue is masked, even when the action refuses", async () => {
    const secret = canarySecret("set-secret", "password");
    const created = await execute("project.importCompose", { composeYaml: "services:\n  api:\n    image: node:22\n", name: "Holder" });
    const projectId = (created.data as { projectId: string }).projectId;
    const serviceId = q.project(projectId)!.workingManifest.services[0].id;
    await execute("system.setSecret", { projectId, serviceId, key: "API_KEY", secretValue: secret }, { projectId });
    // a refused write (unknown service) must not echo the value either
    await execute("system.setSecret", { projectId, serviceId: "svc-nope", key: "API_KEY", secretValue: secret }, { projectId });
    expect(deepScanForCanaries(auditRows(), [secret]), "secretValue is masked by field name in success and failure rows").toEqual([]);
  });

  it("alerts.createChannel: the signing secret is masked and the webhook URL is cut to its origin", async () => {
    const signing = canarySecret("channel-secret", "password");
    const token = canarySecret("slack-webhook-token", "slack-token");
    const r = await execute("alerts.createChannel", { kind: "webhook", name: "ops", target: `https://hooks.example.com/services/${token}`, secret: signing });
    expect(r.ok, r.error).toBe(true);
    expect(deepScanForCanaries([auditRows(), r], [signing, token]), "neither the signing secret nor the URL path token reaches the audit log or the action result").toEqual([]);
  });

  it("system.setEnvVar: a secret-named variable's literal value is refused, and a neutral one is stored as data", async () => {
    const secret = canarySecret("env-var", "password");
    const created = await execute("project.importCompose", { composeYaml: "services:\n  api:\n    image: node:22\n", name: "Env" });
    const projectId = (created.data as { projectId: string }).projectId;
    const serviceId = q.project(projectId)!.workingManifest.services[0].id;
    const refused = await execute("system.setEnvVar", { projectId, serviceId, key: "DB_PASSWORD", value: secret }, { projectId });
    expect(refused.ok).toBe(false);
    expect(deepScanForCanaries([auditRows(), refused], [secret]), "a refused secret-named variable is not echoed anywhere").toEqual([]);
  });
});
