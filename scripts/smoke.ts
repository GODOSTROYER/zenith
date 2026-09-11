/**
 * Zenith smoke test — the two paths that must never break:
 *   1. Happy path: blueprint → environment → plan → apply → succeeded → URL.
 *   2. Failure path: chaos-flagged release fails → rollback → recovered.
 *
 * Runs against real code paths (actions + engine + sandbox provider) with
 * ZENITH_FAST=1 and an isolated data dir. Exit 0 = pass.
 *
 * Run: npm run smoke
 */
process.env.ZENITH_FAST = "1";
process.env.ZENITH_DATA = `${process.cwd()}/.data-smoke`;

import fs from "node:fs";

async function main() {
  fs.rmSync(process.env.ZENITH_DATA!, { recursive: true, force: true });

  const { resetDb, db, save, q } = await import("../src/lib/db/store");
  const { runAction } = await import("../src/lib/actions/core");
  const { registerAllActions } = await import("../src/lib/actions/defs");
  const { ensureEngine } = await import("../src/lib/engine/engine");

  registerAllActions();
  ensureEngine();

  resetDb();
  const data = db();
  data.workspaces.push({ id: "ws-t", name: "Smoke", slug: "smoke", createdAt: new Date().toISOString() });
  data.connections.push({
    id: "conn-t", workspaceId: "ws-t", provider: "sandbox", label: "Sandbox",
    region: "local-1", status: "healthy", grantedPermissions: [], createdAt: new Date().toISOString(),
  });
  save();

  const ctx = {
    workspaceId: "ws-t",
    actor: { type: "user" as const, id: "t", name: "Smoke" },
  };

  const fail = (msg: string): never => {
    console.error(`✗ SMOKE FAIL: ${msg}`);
    process.exit(1);
  };
  const ok = (msg: string) => console.log(`✓ ${msg}`);

  /* 1 — create project from blueprint */
  const created = await runAction("project.applyBlueprint", ctx, { name: "Smoke App", blueprint: "api-worker" }, { mode: "execute" });
  if (!created.result?.ok) fail(`applyBlueprint: ${created.result?.error}`);
  const projectId = (created.result!.data as { projectId: string }).projectId;
  ok(`project created (${projectId})`);

  const pctx = { ...ctx, projectId };

  /* 2 — create environment */
  const envRes = await runAction("env.create", pctx, { name: "staging", class: "staging", connectionId: "conn-t", region: "local-1" }, { mode: "execute" });
  if (!envRes.result?.ok) fail(`env.create: ${envRes.result?.error}`);
  const environmentId = (envRes.result!.data as { environmentId: string }).environmentId;
  ok(`environment created (${environmentId})`);

  const ectx = { ...pctx, environmentId };

  /* 3 — plan shows a readable changeset with cost */
  const plan = await runAction("deploy.plan", ectx, {}, { mode: "execute" });
  const cs = ((plan.result?.data as { changeset?: { items?: unknown[]; projectedMonthlyUsd?: number } })?.changeset ?? {}) as {
    items?: unknown[];
    projectedMonthlyUsd?: number;
  };
  const itemCount = cs.items?.length ?? 0;
  if (!plan.result?.ok || itemCount === 0) fail("deploy.plan returned no changeset items");
  ok(`plan: ${itemCount} changes, projected $${cs.projectedMonthlyUsd ?? 0}/mo`);

  /* 4 — apply and wait */
  const applied = await runAction("deploy.apply", ectx, { message: "smoke deploy" }, { mode: "execute" });
  if (!applied.result?.ok) fail(`deploy.apply: ${applied.result?.error}`);
  const depId = (applied.result!.data as { deploymentId: string }).deploymentId;
  const final = await waitFor(depId, ["succeeded", "failed"], 30000);
  if (final.status !== "succeeded") fail(`deployment ended ${final.status}: ${final.error ?? ""}`);
  if (!final.outputs.some((o: { kind: string }) => o.kind === "url")) fail("no URL output on success — activation moment broken");
  ok(`deployed: ${final.outputs.find((o: { kind: string }) => o.kind === "url")!.label}`);

  /* 5 — chaos: make the release fail once */
  const proj = q.project(projectId)!;
  const web = proj.workingManifest.services.find((s) => s.kind === "web")!;
  const chaos = await runAction("system.setEnvVar", ectx, {
    serviceId: web.id,
    key: "ZENITH_CHAOS",
    value: "fail_once",
  }, { mode: "execute" });
  if (!chaos.result?.ok) fail(`chaos env set: ${chaos.result?.error}`);

  const applied2 = await runAction("deploy.apply", ectx, { message: "chaos deploy" }, { mode: "execute" });
  if (!applied2.result?.ok) fail(`deploy.apply(2): ${applied2.result?.error}`);
  const dep2 = (applied2.result!.data as { deploymentId: string }).deploymentId;
  const final2 = await waitFor(dep2, ["succeeded", "failed"], 30000);
  if (final2.status !== "failed") fail(`chaos deployment should fail, got ${final2.status}`);
  ok(`chaos deployment failed as designed: ${final2.error ?? "release failure"}`);

  /* 6 — rollback restores the previous revision */
  const rb = await runAction("deploy.rollback", ectx, {}, { mode: "execute" });
  if (!rb.result?.ok) fail(`deploy.rollback: ${rb.result?.error}`);
  const rbDep = (rb.result!.data as { deploymentId: string }).deploymentId;
  const final3 = await waitFor(rbDep, ["succeeded", "failed", "rolled_back"], 30000);
  if (final3.status === "failed") fail(`rollback failed: ${final3.error}`);
  const env = q.environment(environmentId)!;
  ok(`rolled back; environment now at revision ${env.deployedRevisionId}`);

  console.log("\nSMOKE PASS — happy path and failure/rollback path both hold.");
  process.exit(0);

  async function waitFor(deploymentId: string, terminal: string[], timeoutMs: number) {
    const t0 = Date.now();
    for (;;) {
      const d = q.deployment(deploymentId);
      if (d && terminal.includes(d.status)) return d;
      if (Date.now() - t0 > timeoutMs) return fail(`timeout waiting for ${deploymentId} (${d?.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

main().catch((e) => {
  console.error("✗ SMOKE FAIL (exception):", e);
  process.exit(1);
});
