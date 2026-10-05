/**
 * PROD-LIFE-10 wired into the deploy activities: deployWorkloads and runMigrations drive the
 * digest-bound release pipeline over scripted ports (never a cloud) and the in-memory store.
 */
import { afterEach, describe, expect, it } from "vitest";
import { StepFailedError } from "@/lib/execution/errors";
import { ReleaseSafetyService, createMemoryReleaseStore, type ProvenanceVerifier, type ReleaseRun } from "@/lib/release-safety";
import type { ManifestV2, RolloutHook } from "@/lib/resources/manifest-v2";
import { ENV, OP, WS, migratingManifest } from "./fakes/fixtures";
import { FakeProgressive } from "./fakes/release";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const SVC = "container_service/web";
const DIGEST = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;
const uri = (d: string) => `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@${d}`;
const image = (d = DIGEST) => ({ service: SVC, imageUri: uri(d), digest: d });
const bob = { kind: "user" as const, id: "bob", name: "Bob" };

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

const verifier = (verified = true): ProvenanceVerifier => ({ name: "test", verify: async () => (verified ? { verified: true, level: "pinned_digest", evidenceRef: "ev:test" } : { verified: false, level: "none", reason: "no attestation" }) });
const service = (verified = true) => new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier(verified)], minProvenance: "pinned_digest" });

function world(svc: ReleaseSafetyService, opts: WorldOptions = {}): World {
  const w = createWorld({ ...opts, releaseSafety: svc });
  worlds.push(w);
  return w;
}

type Declared = "none" | "unclassified" | "expand" | "data" | "contract";
function manifest(migrate: Declared, rollout?: RolloutHook): ManifestV2 {
  const m = migratingManifest();
  const hook = m.release!.migrate!;
  m.release = { ...(migrate === "none" ? {} : { migrate: migrate === "unclassified" ? hook : { ...hook, class: migrate } }), ...(rollout ? { rollout } : {}) };
  return m;
}

async function ready(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-review" };
  return lease;
}

const runs = (svc: ReleaseSafetyService): Promise<ReleaseRun[]> => svc.list(WS, { operationId: OP });

/** Put a digest through the whole pipeline in the shared store, as an earlier operation would have. */
async function served(svc: ReleaseSafetyService, op: string, digest: string, contract = false): Promise<ReleaseRun> {
  const input = { workspaceId: WS, environmentId: ENV, operationId: op, serviceAddress: SVC, provider: "aws", nodeKind: "container_service", kind: "deploy" as const, imageUri: uri(digest), imageDigest: digest, origin: "pinned" as const, requestedBy: "user-1", ...(contract ? { migration: { commandDigest: "c".repeat(64), declared: "contract" as const } } : {}) };
  if (contract) {
    await svc.begin(input).catch(() => undefined);
    const blocked = (await svc.store.findRun(WS, op, SVC, "deploy"))!;
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: bob });
  }
  let run = await svc.begin(input);
  run = await svc.markDeployed(run, { percent: 100, detail: "d" });
  if (contract) {
    run = await svc.beginMigration(run);
    run = await svc.markMigrated(run, { ran: true, exitCode: 0 });
  } else run = await svc.markMigrated(run, { ran: false });
  run = await svc.markReady(run, "r");
  run = await svc.markCutOver(run, "c");
  return svc.recordReadback(run, { supported: true, observedDigest: digest });
}

describe("forward release through the pipeline", () => {
  it("expand migration: deploy, migrate, readiness, cutover and a verified readback bound to the digest", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("expand"));
    w.workloads.serving = { digest: DIGEST, steady: true };
    const lease = await ready(w);

    expect(await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] })).toEqual({ services: 1 });
    let [run] = await runs(svc);
    expect(run).toMatchObject({ state: "deployed", imageDigest: DIGEST, kind: "deploy", provenance: { level: "pinned_digest" }, migration: { class: "expand", status: "cleared" } });
    expect(w.workloads.deployed).toHaveLength(1);

    const out = await w.activities.runMigrations({ operationId: OP, lease });
    expect(out.ran).toBe(true);
    expect(w.migrations.runs).toHaveLength(1);
    [run] = await runs(svc);
    expect(run.state).toBe("readback_verified");
    expect(run.migration.status).toBe("ran");
    expect(run.readback).toMatchObject({ status: "verified", observedDigest: DIGEST });
    expect((await svc.events(WS, run.id)).map((e) => e.to)).toEqual(["planned", "built", "verified", "deployed", "deployed", "migrated", "ready", "cut_over", "readback_verified"]);
  });

  it("a cutover the adapter cannot read back ends unverified, never verified", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("expand"));
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    await w.activities.runMigrations({ operationId: OP, lease });
    const [run] = await runs(svc);
    expect(run.state).toBe("cut_over_unverified");
    expect(run.readback?.status).toBe("unsupported");
  });

  it("a readback that names another digest fails the step and the release", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("expand"));
    w.workloads.serving = { digest: OLD, steady: true };
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/different image than the release bound/);
    expect((await runs(svc))[0].state).toBe("failed");
  });

  it("a release with no migration still finishes: readiness, cutover, readback", async () => {
    const svc = service();
    const w = world(svc);
    w.workloads.serving = { digest: DIGEST, steady: true };
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    expect(await w.activities.runMigrations({ operationId: OP, lease })).toEqual({ ran: false, detail: "no migration declared" });
    expect((await runs(svc))[0].state).toBe("readback_verified");
  });
});

describe("refusals happen before any rollout effect", () => {
  it("a digest with no verified provenance is refused", async () => {
    const svc = service(false);
    const w = world(svc);
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/no verified provenance/);
    expect(w.workloads.deployed).toHaveLength(0);
    expect((await runs(svc))[0].state).toBe("refused");
  });

  it("an unpinned image has no digest to bind and is refused", async () => {
    const svc = service();
    const w = world(svc);
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [{ service: SVC, imageUri: "ghcr.io/acme/web:1", digest: "" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/no pinned image digest/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it.each(["contract", "data", "unclassified"] as const)("a %s migration waits for a separate approval and deploys nothing meanwhile", async (cls) => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest(cls));
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/must approve release rel_/);
    expect(w.workloads.deployed).toHaveLength(0);
    expect(w.workloads.waited).toHaveLength(0);
    const [run] = await runs(svc);
    expect(run.state).toBe("blocked_approval");
  });

  it("after a person other than the requester approves the exact binding, the same operation proceeds and the migration runs once", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("contract"));
    w.workloads.serving = { digest: DIGEST, steady: true };
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] }).catch(() => undefined);
    const [blocked] = await runs(svc);
    // the requester (user-1) cannot approve their own migration
    await expect(svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: { kind: "user", id: "user-1", name: "Alice" } })).rejects.toMatchObject({ code: "forbidden" });
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: bob });

    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    expect(w.workloads.deployed).toHaveLength(1);
    await w.activities.runMigrations({ operationId: OP, lease });
    expect(w.migrations.runs).toHaveLength(1);
    const [run] = await runs(svc);
    expect(run.state).toBe("readback_verified");
    expect(run.migration).toMatchObject({ class: "contract", status: "ran" });
    // the evidence row for the task never holds the argv text
    expect(JSON.stringify(w.evidence.ofKind("machine_request"))).not.toContain("migrate.js");
  });

  it("a migration approved for one digest does not run for another", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("contract"));
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] }).catch(() => undefined);
    const [blocked] = await runs(svc);
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: bob });
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image(OLD)] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect(w.workloads.deployed).toHaveLength(0);
  });
});

describe("progressive rollout", () => {
  it("is refused when the provider adapter cannot split traffic", async () => {
    const svc = service();
    const w = world(svc);
    w.product.setManifest(manifest("expand", { strategy: "progressive", steps: [10, 100], bakeSec: 5 }));
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/Progressive rollout was requested but is not available/);
    expect(w.workloads.deployed).toHaveLength(0);
    expect((await runs(svc))[0].state).toBe("refused");
  });

  it("stages the candidate, shifts canary traffic, and only cuts over after the migration and readiness", async () => {
    const svc = service();
    const w = world(svc);
    w.workloads.progressive = new FakeProgressive();
    w.workloads.serving = { digest: DIGEST, steady: true };
    w.product.setManifest(manifest("expand", { strategy: "progressive", steps: [10, 50, 100], bakeSec: 5 }));
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    // no plain deployImage (it would send 100% of traffic): the candidate is staged, then 10% and 50%
    expect(w.workloads.deployed).toHaveLength(0);
    expect(w.workloads.progressive!.calls).toEqual([`stage ${SVC} ${DIGEST.slice(0, 12)}`, `traffic ${SVC} 10`, `traffic ${SVC} 50`]);
    expect((await runs(svc))[0].rollout.percent).toBe(50);

    await w.activities.runMigrations({ operationId: OP, lease });
    expect(w.workloads.progressive!.calls.at(-1)).toBe(`traffic ${SVC} 100`);
    const [run] = await runs(svc);
    expect(run.state).toBe("readback_verified");
    expect(run.rollout.percent).toBe(100);
  });

  it("a failed migration returns canary traffic to the previous revision and never touches data", async () => {
    const svc = service();
    const w = world(svc);
    w.workloads.progressive = new FakeProgressive();
    w.migrations.exitCode = 2;
    w.product.setManifest(manifest("expand", { strategy: "progressive", steps: [25, 100], bakeSec: 0 }));
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image()] });
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exited with code 2; the database may be partially migrated/);
    expect(w.workloads.progressive!.calls.at(-1)).toBe(`abort ${SVC}`);
    expect(w.workloads.progressive!.calls).not.toContain(`traffic ${SVC} 100`);
    expect((await runs(svc))[0].state).toBe("failed");
  });
});

describe("code rollback", () => {
  const rollbackOp = { capability: "deployment.rollback" } as const;

  it("restores a served digest, never runs the manifest's migration, and leaves data alone", async () => {
    const svc = service();
    await served(svc, "op-old", OLD);
    const w = world(svc, { op: rollbackOp });
    w.product.setManifest(manifest("contract"));
    w.workloads.serving = { digest: OLD, steady: true };
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image(OLD)] });
    const out = await w.activities.runMigrations({ operationId: OP, lease });
    expect(out.ran).toBe(false);
    expect(out.detail).toMatch(/code rollback/);
    expect(w.migrations.runs).toHaveLength(0);
    const [run] = await runs(svc);
    expect(run).toMatchObject({ kind: "rollback", state: "readback_verified", imageDigest: OLD, migration: { class: "none", status: "none" } });
    expect(run.restoresRunId).toBeDefined();
  });

  it("is refused, before anything is deployed, when a contract migration ran since that digest served", async () => {
    const svc = service();
    await served(svc, "op-old", OLD);
    await served(svc, "op-new", DIGEST, true);
    const w = world(svc, { op: rollbackOp });
    const lease = await ready(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image(OLD)] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/contract migration/);
    expect(w.workloads.deployed).toHaveLength(0);
    expect((await runs(svc))[0].state).toBe("refused");
  });

  it("marks the replaced release as rolled back once the older digest serves", async () => {
    const svc = service();
    await served(svc, "op-old", OLD);
    const replaced = await served(svc, "op-new", DIGEST);
    const w = world(svc, { op: rollbackOp });
    w.workloads.serving = { digest: OLD, steady: true };
    const lease = await ready(w);
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image(OLD)] });
    await w.activities.runMigrations({ operationId: OP, lease });
    expect((await svc.get(WS, replaced.id)).state).toBe("rolled_back");
  });
});
