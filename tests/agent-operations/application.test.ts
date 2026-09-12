import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tempDataDir } from "../_support/data-dir";
import type { AgentGrant } from "../../src/lib/agent-operations/access";
import type { SelectedScope } from "../../src/lib/agent-access/security";

// Set process configuration before dynamically importing the real application.
tempDataDir("zenith-agent-application-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_HOSTED_STORE = "sqlite";
process.env.ZENITH_HOSTED_MODE = "0";
process.env.ZENITH_AGENT_WRITES = "1";
process.env.ZENITH_AGENT_OPERATOR_KEY_FILE = "/not-used-by-the-direct-service-test";
delete process.env.VERCEL;
const { db, q, resetDb, readAudit, flushPendingAsync } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
await import("@/lib/actions/defs");
const { prepareChange, executeChange, journal, publicReceipt, stateFingerprint, readTool } = await import("../../src/lib/agent-operations/application");
const { manifestHash } = await import("@/lib/actions/defs/project-manifest");
let selected: SelectedScope, grant: AgentGrant;
const subject = "agent-member", reviewer = "independent-admin", workspaceId = "agent-workspace";
const approve = (id: string) => {
  const receipt = journal().forReview(id);
  return journal().decide(id, receipt.digest, reviewer, "approve", randomUUID(), Date.now() + 30000);
};
async function settle(id: string) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const d = q.deployment(id)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("The actual deployment engine did not settle within its test budget.");
}
beforeAll(async () => {
  resetDb({ workspaces: [{ id: workspaceId, name: "Agent tests", slug: "agent-tests", createdAt: new Date().toISOString() }],
    members: [{ id: subject, workspaceId, name: "Agent user", email: "agent@example.test", role: "admin" }, { id: reviewer, workspaceId, name: "Reviewer", email: "review@example.test", role: "admin" }] });
  const created = await runAction("project.applyBlueprint", { workspaceId, actor: { type: "user", id: subject, name: "Agent user" } }, { blueprint: "internal-tool", name: "Agent contract" }, { mode: "execute" });
  expect(created.result?.ok).toBe(true);
  const ids = created.result!.data as { projectId: string; environmentId: string };
  selected = { workspaceId, ...ids };
  grant = { id: "grant-test", kind: "opaque", subject, workspaceId, projectIds: [ids.projectId], environmentIds: [ids.environmentId], scopes: ["read", "plan", "execute", "export"], issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), authorityHash: "test-enrollment" };
});

describe("real application action/engine integration", () => {
  it("inspect -> prepare -> independent approval -> dispatch -> observe uses the actual store and engine", async () => {
    const context = await readTool("zenith_get_context", {}, grant, selected) as { user: { id: string } };
    expect(context.user.id).toBe(subject);
    const receipt = await prepareChange("deploy", {}, randomUUID(), grant, selected);
    expect(q.deploymentsOf(selected.environmentId!)).toHaveLength(0);
    await expect(executeChange(receipt.id, randomUUID(), grant, selected)).rejects.toMatchObject({ code: "approval_required" });
    approve(receipt.id);
    const key = randomUUID(), operation = await executeChange(receipt.id, key, grant, selected);
    expect(operation.state).toBe("accepted");
    const deploymentId = String(operation.result?.deploymentId);
    const done = await settle(deploymentId); expect(done.status).toBe("succeeded");
    expect(done.outputs.some(o => o.kind === "url" && o.simulated)).toBe(true);
    const replay = await executeChange(receipt.id, key, grant, selected);
    expect(replay.id).toBe(operation.id); expect(q.deploymentsOf(selected.environmentId!)).toHaveLength(1);
    const audit = readAudit({ projectId: selected.projectId });
    expect(audit.some(row => row.actionId === "deploy.apply" && row.actor.id === subject && row.actor.type === "user" && row.actor.name.includes(operation.id))).toBe(true);
  });
  it("preserves existing literal values without storing them in a receipt", async () => {
    const p = q.project(selected.projectId!)!;
    p.workingManifest.services[0].env.push({ key: "PRIVATE_VALUE", value: "never-in-the-agent-receipt" });
    const manifest = structuredClone(p.workingManifest); manifest.services[0].replicas += 1;
    manifest.services[0].env = manifest.services[0].env.map(e => e.value === undefined ? e : { ...e, value: "[redacted]" });
    const receipt = await prepareChange("manifest", { manifest, expectedHash: manifestHash(p.workingManifest) }, randomUUID(), grant, selected);
    expect(JSON.stringify(journal().forReview(receipt.id))).not.toContain("never-in-the-agent-receipt");
    approve(receipt.id); const op = await executeChange(receipt.id, randomUUID(), grant, selected);
    expect(op.state).toBe("accepted"); expect(p.workingManifest.services[0].env.find(e => e.key === "PRIVATE_VALUE")?.value).toBe("never-in-the-agent-receipt");
  });
  it("rejects stale receipts when a browser changes the working copy", async () => {
    const receipt = await prepareChange("deploy", {}, randomUUID(), grant, selected); approve(receipt.id);
    const p = q.project(selected.projectId!)!; p.workingManifest.services[0].replicas += 1;
    await expect(executeChange(receipt.id, randomUUID(), grant, selected)).rejects.toMatchObject({ code: "plan_stale" });
    expect(journal().forReview(receipt.id).state).toBe("approved");
  });
  it("does not accept a new literal credential or a raw action ID", async () => {
    const p = q.project(selected.projectId!)!, manifest = structuredClone(p.workingManifest);
    manifest.services[0].env.push({ key: "PASSWORD", value: "new-secret" });
    await expect(prepareChange("manifest", { manifest, expectedHash: manifestHash(p.workingManifest) }, randomUUID(), grant, selected)).rejects.toMatchObject({ code: "literal_environment_value" });
    await expect(prepareChange("deploy", { actionId: "workspace.setAutonomy", approved: true }, randomUUID(), grant, selected)).rejects.toMatchObject({ code: "invalid_intent" });
  });
  it("rechecks the human reviewer and acting member immediately before the claim", async () => {
    const receipt = await prepareChange("deploy", {}, randomUUID(), grant, selected); approve(receipt.id);
    const member = db().members.find(m => m.id === reviewer)!;
    const prior = member.role; member.role = "viewer";
    await expect(executeChange(receipt.id, randomUUID(), grant, selected)).rejects.toMatchObject({ code: "role_denied" });
    member.role = prior;
    const actor = db().members.find(m => m.id === subject)!; actor.role = "viewer";
    expect(() => stateFingerprint(grant, selected, journal().forReview(receipt.id).intent)).toThrow(/membership/);
    actor.role = "admin";
  });
  it("keeps role and tenant differences out of public receipt payloads", () => {
    const p = journal().prepare({ subject, credentialId: grant.id, workspaceId, projectId: selected.projectId, authorizationHash: "test" }, { kind: "deploy", input: {} }, "state", { summary: "Test", details: [], warnings: [], risk: "low", costDeltaUsd: 0, requiredRole: "editor", requiresApproval: true }, randomUUID());
    expect(JSON.stringify(publicReceipt(p))).not.toContain("authorizationHash");
    expect(() => journal().receipt(p.id, { ...p.owner, workspaceId: "foreign" })).toThrow(/No permitted/);
  });
  it("exports and drift preserve provider truth after an actual sandbox deployment", async () => {
    const drift = await readTool("zenith_get_drift", {}, grant, selected) as { simulated: boolean; provider: string };
    expect(drift.simulated).toBe(true); expect(drift.provider).toBe("sandbox");
    const bundle = await readTool("zenith_export_project", {}, grant, selected) as { files: unknown[] };
    expect(bundle.files.length).toBeGreaterThan(0);
    await flushPendingAsync();
  });
});
