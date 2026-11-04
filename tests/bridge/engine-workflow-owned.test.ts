/** Engine never advances, claims, supersedes, approves or cancels workflow rows. */
import { beforeEach, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-bridge-engine-", { fast: true });
const { ctx, seed, workflowDeployment } = await import("./support");
const { db, q, readEvents } = await import("@/lib/db/store");
const { engine, engineTick, ensureEngine } = await import("@/lib/engine/engine");
const start = () => engine.start({ projectId: ctx.projectId!, environmentId: ctx.environmentId!, revisionId: "bridge-r1", changeSummary: "test", estCostDeltaUsd: 0, actorId: ctx.actor.id, actorName: ctx.actor.name, actorType: "user", approved: true });
beforeEach(() => { seed("sandbox"); ensureEngine(); });
it("resume leaves an unclaimed workflow untouched, and tick drops an accidentally active id", async () => {
  const d = workflowDeployment();
  const prior = JSON.stringify(d);
  engine.resumeInFlight();
  expect(q.environment(d.environmentId)?.activeDeploymentId).toBeUndefined();
  const g = globalThis as typeof globalThis & { __zenithActive?: Set<string> };
  (g.__zenithActive ??= new Set()).add(d.id);
  engineTick();
  expect(g.__zenithActive?.has(d.id)).toBe(false);
  expect(JSON.stringify(d)).toBe(prior); expect(readEvents(d.id)).toEqual([]);
});
it("start/rollback cannot supersede a live workflow lease", async () => {
  const d = workflowDeployment(); q.environment(d.environmentId)!.activeDeploymentId = d.id;
  await expect(start()).rejects.toThrow(/workflow/i);
  await expect(engine.rollback(d.environmentId, "bridge-r1", ctx.actor)).rejects.toThrow(/workflow/i);
  expect(d.status).toBe("applying"); expect(db().deployments).toHaveLength(1);
});
it("rollback refuses an unclaimed live workflow too", async () => {
  const d = workflowDeployment();
  await expect(engine.rollback(d.environmentId, "bridge-r1", ctx.actor)).rejects.toThrow(/workflow/i);
  expect(d.status).toBe("applying");
});
it("engine approve/cancel cannot take over workflow controls", async () => {
  const d = workflowDeployment("awaiting_approval");
  await expect(engine.approve(d.id)).rejects.toThrow(/workflow/i);
  await expect(engine.cancel(d.id)).rejects.toThrow(/workflow/i);
  expect(d.status).toBe("awaiting_approval");
});
it("resume does not repair a workflow row in rolling_back", () => {
  const d = workflowDeployment("rolling_back");
  engine.resumeInFlight();
  expect(d.status).toBe("rolling_back"); expect(readEvents(d.id)).toEqual([]);
});
it("a terminal workflow's stale lease is cleaned and sandbox still deploys", async () => {
  const old = workflowDeployment("succeeded"); q.environment(old.environmentId)!.activeDeploymentId = old.id;
  engine.resumeInFlight(); expect(q.environment(old.environmentId)!.activeDeploymentId).toBeUndefined();
  const d = await start();
  const deadline = Date.now() + 10_000;
  while (!["succeeded", "failed"].includes(d.status) && Date.now() < deadline) { engineTick(); await new Promise((r) => setTimeout(r, 20)); }
  expect(d.status).toBe("succeeded"); expect(d.executor).not.toBe("workflow");
});
