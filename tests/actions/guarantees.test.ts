/**
 * Contract tests for the guarantees the product makes about refusing, auditing
 * and not losing data. Each one names the promise it defends.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";
import type { Deployment, SecurityFinding } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-guarantees-"));
process.env.ORRERY_FAST = "1";

const { runAction } = await import("@/lib/actions/core");
const { db, q, readAudit, resetDb } = await import("@/lib/db/store");
const { ensureEngine } = await import("@/lib/engine/engine");
const { manifestHash } = await import("@/lib/actions/defs/manifest");
const { syncFindings } = await import("@/lib/security/rules");
await import("@/lib/actions/defs");

const WS = "ws-guarantees";
const ctx: ActionContext = {
  workspaceId: WS,
  actor: { type: "user", id: "u-alice", name: "Alice" },
};

const exec = (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" }).then((r) => r.result!);

const plan = (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  runAction(actionId, { ...ctx, ...scope }, input, { mode: "plan" }).then((r) => r.plan!);

async function settle(deploymentId: string, ms = 20_000): Promise<Deployment> {
  const until = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    if (Date.now() > until) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

let projectId = "";
let environmentId = "";

beforeAll(async () => {
  ensureEngine(); // registers the provider adapters
  resetDb({
    workspaces: [{ id: WS, name: "Guarantees", slug: "guarantees", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  environmentId = data.environmentId;
});

/* ------------------------- rollback honours approval ----------------------- */

describe("rollback is a deployment, so the approval gate applies to it (P1)", () => {
  it("waits for approval when the environment requires it, instead of applying itself", async () => {
    const first = await exec("deploy.apply", {}, { projectId, environmentId });
    await settle((first.data as { deploymentId: string }).deploymentId);

    await exec("ops.scaleService", { serviceId: "app", replicas: 2 }, { projectId });
    const second = await exec("deploy.apply", {}, { projectId, environmentId });
    await settle((second.data as { deploymentId: string }).deploymentId);

    // Turn the gate on, exactly as an admin would.
    q.environment(environmentId)!.policies.approvalRequired = true;

    const preview = await plan("deploy.rollback", {}, { projectId, environmentId });
    expect(preview.requiresApproval).toBe(true);
    expect(preview.details.join(" ")).toMatch(/awaiting approval/i);

    const rolled = await exec("deploy.rollback", {}, { projectId, environmentId });
    expect(rolled.ok).toBe(true);
    const { deploymentId, status } = rolled.data as { deploymentId: string; status: string };
    expect(status).toBe("awaiting_approval");
    expect(rolled.summary).toMatch(/waiting for approval/i);

    // It really is parked: nothing ran and the environment did not move.
    const parked = q.deployment(deploymentId)!;
    expect(parked.steps.every((s) => s.status === "pending")).toBe(true);

    const done = await settle((await approveAndRun(deploymentId)).id);
    expect(done.status).toBe("succeeded");
    q.environment(environmentId)!.policies.approvalRequired = false;
  });
});

async function approveAndRun(deploymentId: string): Promise<Deployment> {
  const approved = await exec("deploy.approve", { deploymentId });
  expect(approved.ok).toBe(true);
  return q.deployment(deploymentId)!;
}

/* ------------------------------- plan.blocked ------------------------------ */

describe("a plan says when execute would refuse (K1)", () => {
  it("blocks on a Preview provider and keeps warnings advisory", async () => {
    db().connections.push({
      id: "conn-aws",
      workspaceId: WS,
      provider: "aws",
      label: "AWS preview",
      region: "us-east-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
    const env = await exec(
      "env.create",
      { name: "awsenv", class: "staging", connectionId: "conn-aws", region: "us-east-1" },
      { projectId }
    );
    const awsEnv = (env.data as { environmentId: string }).environmentId;

    const preview = await plan("deploy.apply", {}, { projectId, environmentId: awsEnv });
    expect(preview.blocked).toMatch(/Preview provider/);
    const refused = await exec("deploy.apply", {}, { projectId, environmentId: awsEnv });
    expect(refused.ok).toBe(false);
  });

  it("blocks on a disconnected connection, which availability alone never catches", async () => {
    db().connections.push({
      id: "conn-ls",
      workspaceId: WS,
      provider: "localstack",
      label: "LocalStack",
      region: "us-east-1",
      status: "disconnected",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
    const env = await exec(
      "env.create",
      { name: "lsenv", class: "staging", connectionId: "conn-ls", region: "us-east-1" },
      { projectId }
    );
    const lsEnv = (env.data as { environmentId: string }).environmentId;

    const preview = await plan("deploy.apply", {}, { projectId, environmentId: lsEnv });
    expect(preview.blocked).toMatch(/disconnected/i);
    expect(preview.blocked).toMatch(/Docker|Settings → Connections/);

    // and nothing is written when it is tried anyway
    const revisionsBefore = db().revisions.length;
    const refused = await exec("deploy.apply", {}, { projectId, environmentId: lsEnv });
    expect(refused.ok).toBe(false);
    expect(db().revisions).toHaveLength(revisionsBefore);
    expect(q.deploymentsOf(lsEnv)).toHaveLength(0);
  });

  it("blocks a plan the caller's role cannot execute, naming the role", async () => {
    db().members.push(
      { id: "u-alice", workspaceId: WS, name: "Alice", email: "a@x.test", role: "admin" },
      { id: "u-vic", workspaceId: WS, name: "Vic", email: "v@x.test", role: "viewer" }
    );
    const viewer: ActionContext = { ...ctx, actor: { type: "user", id: "u-vic", name: "Vic" } };
    const preview = await plan("deploy.apply", {}, { ...viewer, projectId, environmentId });
    expect(preview.blocked).toMatch(/editor role/);
    expect(preview.blocked).toMatch(/viewer/);
    expect(preview.requiredRole).toBe("editor");
    db().members = [];
  });

  it("blocks an input the schema rejects rather than rendering it as plannable", async () => {
    const preview = await plan("system.updateService", { serviceId: "app", replicas: 99 }, { projectId });
    expect(preview.blocked).toBeTruthy();
    expect(preview.blocked).toMatch(/replicas/);
  });
});

/* -------------------------------- idempotency ------------------------------ */

describe("the idempotency window is per actor (E2)", () => {
  it("replays for the same actor and runs for a different one", async () => {
    const key = "same-key";
    const alice = { ...ctx, projectId };
    const bob: ActionContext = { ...ctx, projectId, actor: { type: "user", id: "u-bob", name: "Bob" } };

    const a1 = await runAction("system.addResource", alice, { name: "cache-a", kind: "redis" }, { mode: "execute", idempotencyKey: key });
    const a2 = await runAction("system.addResource", alice, { name: "cache-a", kind: "redis" }, { mode: "execute", idempotencyKey: key });
    expect(a2.result).toBe(a1.result); // replayed, not re-run

    // Bob's identical key is Bob's action: it runs, and it fails on its own
    // merits (duplicate name) rather than silently inheriting Alice's result.
    const b1 = await runAction("system.addResource", bob, { name: "cache-a", kind: "redis" }, { mode: "execute", idempotencyKey: key });
    expect(b1.result).not.toBe(a1.result);

    const rows = readAudit({ projectId }).filter((r) => r.actionId === "system.addResource");
    expect(rows.some((r) => r.actor.id === "u-bob")).toBe(true);
  });
});

/* --------------------------------- redaction ------------------------------- */

describe("audit redaction masks values, never variable names (E3)", () => {
  it("keeps the env var NAME readable and does not log a secret-shaped value", async () => {
    await exec("system.setEnvVar", { serviceId: "app", key: "API_BASE_URL", value: "https://api.test" }, { projectId });
    const row = readAudit({ projectId }).find((r) => r.actionId === "system.setEnvVar")!;
    const input = row.input as { key: string; value: string };
    expect(input.key).toBe("API_BASE_URL"); // a name is not a secret
    expect(input.value).toBe("https://api.test"); // and a non-secret value stays readable

    const refused = await exec("system.setSecret", { serviceId: "app", key: "X", secretValue: "sk_live_abc123" }, { projectId });
    expect(refused.ok).toBe(false);
    const secretRow = readAudit({ projectId }).find((r) => r.actionId === "system.setSecret")!;
    expect((secretRow.input as { key: string }).key).toBe("X");
    expect(JSON.stringify(secretRow.input)).not.toContain("sk_live_abc123");
  });

  it("summarises an oversized input instead of copying it into the log (K6/T1)", async () => {
    const project = q.project(projectId)!;
    const manifest = structuredClone(project.workingManifest);
    manifest.services[0].env = [
      { key: "BIG_BLOB", value: "x".repeat(20_000) },
    ];
    await exec("project.updateManifest", { projectId, manifest }, { projectId });
    const row = readAudit({ projectId }).find((r) => r.actionId === "project.updateManifest")!;
    expect(JSON.stringify(row.input).length).toBeLessThan(4096 + 512);
    expect(JSON.stringify(row.input)).toMatch(/truncated/);
  });
});

/* --------------------------- optimistic concurrency ------------------------ */

describe("a stale Source save is refused, not merged over (E4/S2)", () => {
  it("refuses when the working copy moved, and names Revert/reload", async () => {
    const project = q.project(projectId)!;
    const stale = manifestHash(project.workingManifest);

    // someone else saves in between
    await exec("system.addResource", { name: "queue-x", kind: "queue" }, { projectId });

    const mine = structuredClone(project.workingManifest);
    mine.services[0].replicas = 3;

    const preview = await plan("project.updateManifest", { projectId, manifest: mine, expectedHash: stale }, { projectId });
    expect(preview.blocked).toMatch(/changed after you loaded it/i);
    expect(preview.blocked).toMatch(/Reload|Revert/);

    const refused = await exec("project.updateManifest", { projectId, manifest: mine, expectedHash: stale }, { projectId });
    expect(refused.ok).toBe(false);

    // the current hash goes through
    const fresh = manifestHash(q.project(projectId)!.workingManifest);
    const ok = await exec("project.updateManifest", { projectId, manifest: mine, expectedHash: fresh }, { projectId });
    expect(ok.ok).toBe(true);
    expect((ok.data as { manifestHash: string }).manifestHash).toBe(manifestHash(mine));
  });

  it("omitting the token still saves — single-turn editors do not need one", async () => {
    const mine = structuredClone(q.project(projectId)!.workingManifest);
    mine.services[0].replicas = 1;
    const ok = await exec("project.updateManifest", { projectId, manifest: mine }, { projectId });
    expect(ok.ok).toBe(true);
  });
});

/* --------------------------------- retention ------------------------------- */

describe("deployment retention keeps the store bounded (E5)", () => {
  it("drops the oldest finished deployments past the cap and never a live one", async () => {
    const envId = environmentId;
    const now = Date.now();
    for (let i = 0; i < 260; i++)
      db().deployments.push({
        id: `old-${i}`,
        projectId,
        environmentId: envId,
        revisionId: "r?",
        status: i === 0 ? "applying" : "succeeded",
        steps: [],
        outputs: [],
        changeSummary: "filler",
        estCostDeltaUsd: 0,
        actor: { type: "user", id: "u-alice", name: "Alice" },
        createdAt: new Date(now - (300 - i) * 60_000).toISOString(),
      });

    await exec("ops.scaleService", { serviceId: "app", replicas: 2 }, { projectId });
    const applied = await exec("deploy.apply", {}, { projectId, environmentId: envId });
    expect(applied.ok).toBe(true);

    const kept = q.deploymentsOf(envId);
    const finished = kept.filter((d) =>
      ["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)
    );
    expect(finished.length).toBeLessThanOrEqual(200);
    // an unfinished deployment is never dropped, however old it is
    expect(kept.some((d) => d.id === "old-0")).toBe(true);
    // and the oldest finished filler is gone
    expect(kept.some((d) => d.id === "old-1")).toBe(false);
    await settle((applied.data as { deploymentId: string }).deploymentId);
  });
});

/* ------------------------ fixed, pending deploy (C1) ----------------------- */

describe("a working-copy fix does not report the environment as safe (C1)", () => {
  const findingsOf = (): SecurityFinding[] => db().findings.filter((f) => f.projectId === projectId);

  it("goes to fixed_pending_deploy, then resolves when a deploy lands it", async () => {
    // Raise a real finding: a route without TLS...
    const project = q.project(projectId)!;
    const route = project.workingManifest.routes[0];
    expect(route).toBeTruthy();
    route.tls = false;
    syncFindings(projectId);

    const finding = findingsOf().find((f) => f.id.startsWith("sf_route_no_tls"))!;
    expect(finding.status).toBe("open");

    // ...and deploy it, so the environment really is exposed. This is the case
    // the state exists for: fixing the working copy must not close a finding
    // that is still true of what is running.
    const exposed = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(exposed.ok).toBe(true);
    await settle((exposed.data as { deploymentId: string }).deploymentId);
    syncFindings(projectId);
    expect(findingsOf().find((f) => f.id === finding.id)!.status).toBe("open");

    const fixed = await exec("security.resolveFinding", { findingId: finding.id }, { projectId });
    expect(fixed.ok).toBe(true);

    const pending = findingsOf().find((f) => f.id === finding.id)!;
    expect(pending.status).toBe("fixed_pending_deploy");
    expect(pending.resolvedBy?.id).toBe("u-alice");
    expect(pending.resolvedReason).toMatch(/system\.updateRoute/);
    expect(fixed.summary).toMatch(/until a deploy lands it/i);

    // Still pending after a resync: the environment has not changed yet.
    syncFindings(projectId);
    expect(findingsOf().find((f) => f.id === finding.id)!.status).toBe("fixed_pending_deploy");

    const applied = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(applied.ok).toBe(true);
    const done = await settle((applied.data as { deploymentId: string }).deploymentId);

    syncFindings(projectId);
    const resolved = findingsOf().find((f) => f.id === finding.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.fixedInRevisionId).toBe(done.revisionId);
  });
});

/* ---------------------- revisions record where they ran -------------------- */

describe("a revision records the environments that ran it (K7)", () => {
  it("appends the environment id when the deployment succeeds", async () => {
    const env = q.environment(environmentId)!;
    const revision = q.revision(env.deployedRevisionId!)!;
    expect(revision.deployedTo).toContain(environmentId);
  });
});
