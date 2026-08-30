/**
 * Engine state machine, end to end, against a throwaway data directory.
 * ORRERY_FAST collapses every step budget to <=40ms so the whole file runs in
 * a couple of seconds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-engine-"));
process.env.ORRERY_DATA = dataDir;
process.env.ORRERY_FAST = "1";

// Imported after the env is set: the store resolves its data dir at load time.
const { db, q, readEvents, resetDb, save } = await import("@/lib/db/store");
const { engine } = await import("@/lib/engine/engine");
const { emptyManifest } = await import("@/lib/domain/types");
type Manifest = import("@/lib/domain/types").Manifest;
type Deployment = import("@/lib/domain/types").Deployment;

/* --------------------------------- fixture -------------------------------- */

const WEB = "svc_web";
const DB_ID = "res_main";
const ROUTE = "rt_app";

function manifest(chaos: boolean): Manifest {
  return {
    ...emptyManifest(),
    services: [
      {
        id: WEB,
        name: "web",
        kind: "web",
        source: { type: "image", image: "ghcr.io/acme/web:1" },
        size: "small",
        replicas: 2,
        port: 3000,
        healthPath: "/healthz",
        env: chaos ? [{ key: "ORRERY_CHAOS", value: "fail_once" }] : [],
        ownership: "managed",
      },
    ],
    resources: [
      {
        id: DB_ID,
        name: "main",
        kind: "postgres",
        config: {},
        size: "small",
        ownership: "managed",
      },
    ],
    routes: [
      { id: ROUTE, host: "app.atlas.orrery.app", pathPrefix: "/", tls: true, managedDns: true },
    ],
    bindings: [
      { id: "b_route", from: ROUTE, to: WEB, capability: "http" },
      { id: "b_sql", from: WEB, to: DB_ID, capability: "sql" },
    ],
  };
}

const actor = { type: "user" as const, id: "you", name: "you" };
const ENV_ID = "env_staging";

function seed(approvalRequired = false) {
  resetDb({
    workspaces: [{ id: "ws", name: "Acme", slug: "acme", createdAt: new Date().toISOString() }],
    connections: [
      {
        id: "conn_sandbox",
        workspaceId: "ws",
        provider: "sandbox",
        label: "Sandbox",
        region: "sim-a",
        status: "healthy",
        grantedPermissions: [],
        createdAt: new Date().toISOString(),
      },
    ],
    projects: [
      {
        id: "proj",
        workspaceId: "ws",
        name: "Atlas",
        slug: "atlas",
        workingManifest: manifest(false),
        createdAt: new Date().toISOString(),
        origin: { type: "blank" },
      },
    ],
    environments: [
      {
        id: ENV_ID,
        projectId: "proj",
        name: "staging",
        class: "staging",
        connectionId: "conn_sandbox",
        region: "sim-a",
        policies: { approvalRequired, allowStatefulDeletion: false },
        baseDomain: "atlas.orrery.app",
        createdAt: new Date().toISOString(),
      },
    ],
    revisions: [
      {
        id: "rev1",
        projectId: "proj",
        number: 1,
        manifest: manifest(false),
        message: "initial",
        author: actor,
        createdAt: new Date().toISOString(),
      },
      {
        id: "rev2",
        projectId: "proj",
        number: 2,
        manifest: manifest(true),
        message: "chaos",
        author: actor,
        createdAt: new Date().toISOString(),
      },
    ],
  });
  save();
}

async function settle(deploymentId: string, timeoutMs = 20000): Promise<Deployment> {
  const started = Date.now();
  for (;;) {
    const d = q.deployment(deploymentId);
    if (d && ["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    if (Date.now() - started > timeoutMs)
      throw new Error(`Deployment ${deploymentId} never settled (status ${d?.status}).`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const start = (revisionId: string, changeSummary: string) =>
  engine.start({
    projectId: "proj",
    environmentId: ENV_ID,
    revisionId,
    changeSummary,
    estCostDeltaUsd: 0,
    actorName: "you",
    actorType: "user",
  });

/* ---------------------------------- tests --------------------------------- */

test("a clean deployment walks the phases, publishes URLs and moves the environment", async () => {
  seed();
  const started = await start("rev1", "Initial deploy");
  expect(started.status).toBe("applying");
  expect(started.previousRevisionId).toBeUndefined();

  const d = await settle(started.id);
  expect(d.status).toBe("succeeded");
  expect(d.steps.every((s) => s.status === "done")).toBe(true);

  // Phases only ever move forward.
  const order = ["prepare", "provision", "release", "verify"];
  const seen = d.steps.map((s) => order.indexOf(s.phase));
  expect(seen).toEqual([...seen].sort((a, b) => a - b));

  // Every step has a real span.
  for (const s of d.steps) {
    expect(s.startedAt).toBeTruthy();
    expect(s.endedAt).toBeTruthy();
  }

  // Activation moment: a clickable local URL plus the pretty hostname.
  const url = d.outputs.find((o) => o.kind === "url" && o.targetId === WEB);
  expect(url?.value).toBe(`/preview/${d.id}/${WEB}`);
  expect(url?.label).toContain("https://app.atlas.orrery.app");
  expect(d.outputs.some((o) => o.kind === "connection" && o.targetId === DB_ID)).toBe(true);

  // Revision bookkeeping.
  expect(q.environment(ENV_ID)?.deployedRevisionId).toBe("rev1");

  // Event log: strictly increasing seq, replayable from any cursor.
  const events = readEvents(d.id);
  const seqs = events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(readEvents(d.id, seqs[0]).length).toBe(events.length - 1);
  expect(events.some((e) => e.type === "status" && e.status === "succeeded")).toBe(true);
  expect(events.some((e) => e.type === "log" && e.stream === "provider")).toBe(true);
}, 30_000);

test("chaos fails the release step, skips the rest, and rollback restores the last good revision", async () => {
  seed();
  const first = await settle((await start("rev1", "Initial deploy")).id);
  expect(first.status).toBe("succeeded");

  const bad = await settle((await start("rev2", "Ship chaos")).id);
  expect(bad.status).toBe("failed");
  expect(bad.previousRevisionId).toBe("rev1");

  const failed = bad.steps.find((s) => s.status === "failed");
  expect(failed?.phase).toBe("release");
  expect(failed?.error).toMatch(/deploy again|roll back/i); // errors name their fix
  expect(bad.steps.filter((s) => s.status === "pending")).toHaveLength(0);
  expect(bad.steps.some((s) => s.status === "skipped")).toBe(true);

  // A failed deploy must not move the environment.
  expect(q.environment(ENV_ID)?.deployedRevisionId).toBe("rev1");

  const rb = await engine.rollback(ENV_ID);
  expect(rb.revisionId).toBe("rev1");
  expect(rb.changeSummary).toBe("Roll back to r1");

  const done = await settle(rb.id);
  expect(done.status).toBe("succeeded");
  expect(q.deployment(bad.id)?.status).toBe("rolled_back");
  expect(q.environment(ENV_ID)?.deployedRevisionId).toBe("rev1");
}, 30_000);

test("approval gates the deploy, and cancel stops it", async () => {
  seed(true);
  const pending = await start("rev1", "Needs a human");
  expect(pending.status).toBe("awaiting_approval");
  expect(pending.steps.every((s) => s.status === "pending")).toBe(true);

  await engine.approve(pending.id);
  expect(q.deployment(pending.id)?.status).toBe("applying");
  expect(await settle(pending.id)).toMatchObject({ status: "succeeded" });

  await expect(engine.approve(pending.id)).rejects.toThrow(/not awaiting approval/);

  const second = await start("rev2", "Cancel me");
  await engine.cancel(second.id);
  const cancelled = q.deployment(second.id)!;
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.steps.some((s) => s.status === "pending")).toBe(false);
  expect(db().deployments.filter((d) => d.status === "cancelled")).toHaveLength(1);
}, 30_000);
