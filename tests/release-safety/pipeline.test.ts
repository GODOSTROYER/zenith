/**
 * PROD-LIFE-10: the release pipeline service over the in-memory store. The same store contract is
 * exercised over SQL in tests/controlplane/release-pipelines.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ReleaseSafetyError,
  ReleaseSafetyService,
  assertTransition,
  canTransition,
  canarySteps,
  createMemoryReleaseStore,
  normalizeRollout,
  resetProvenanceVerifiersForTests,
  registerProvenanceVerifier,
  registeredProvenanceVerifiers,
  type BeginInput,
  type ProvenanceLevel,
  type ProvenanceVerifier,
  type ReleaseRun,
} from "@/lib/release-safety";

const WS = "ws-1";
const ENV = "env-1";
const SVC = "container_service/web";
const dg = (c: string) => `sha256:${c.repeat(64)}`;
const D1 = dg("1");
const D2 = dg("2");
const D3 = dg("3");
const uri = (d: string) => `registry.example.test/web@${d}`;
const CMD = "c".repeat(64);
const user = (id: string) => ({ kind: "user" as const, id, name: id });

const verifier = (level: ProvenanceLevel, verified = true, name = `v-${level}`): ProvenanceVerifier => ({
  name,
  verify: async () => (verified ? { verified, level, evidenceRef: `ev:${name}` } : { verified: false, level: "none", reason: "nothing to verify" }),
});

let now = new Date("2026-10-05T10:00:00.000Z");
let n = 0;
const clock = () => now;
const make = (verifiers: ProvenanceVerifier[] = [verifier("build_record")], minProvenance?: ProvenanceLevel) => {
  const store = createMemoryReleaseStore(clock);
  return { store, svc: new ReleaseSafetyService({ store, verifiers, clock, ids: () => `id${++n}`, minProvenance }) };
};
const input = (over: Partial<BeginInput> = {}): BeginInput => ({
  workspaceId: WS,
  environmentId: ENV,
  operationId: "op-1",
  serviceAddress: SVC,
  provider: "gcp",
  nodeKind: "container_service",
  kind: "deploy",
  imageUri: uri(D1),
  imageDigest: D1,
  origin: "built",
  requestedBy: "alice",
  ...over,
});

/** Take a run all the way to cut over and verified readback. */
async function release(svc: ReleaseSafetyService, over: Partial<BeginInput> = {}): Promise<ReleaseRun> {
  let run = await svc.begin(input(over));
  run = await svc.markDeployed(run, { percent: 100, detail: "deployed" });
  if (run.kind === "deploy" && run.migration.status !== "none") {
    run = await svc.beginMigration(run);
    run = await svc.markMigrated(run, { ran: true, exitCode: 0 });
  } else run = await svc.markMigrated(run, { ran: false });
  run = await svc.markReady(run, "ready");
  run = await svc.markCutOver(run, "cut over");
  return svc.recordReadback(run, { supported: true, observedDigest: run.imageDigest });
}

/** Approve a blocked migration as `bob`, then clear the same operation again. */
async function approvedRelease(svc: ReleaseSafetyService, store: ReturnType<typeof make>["store"], over: Partial<BeginInput>): Promise<ReleaseRun> {
  const first = input(over);
  await expect(svc.begin(first)).rejects.toMatchObject({ code: "migration_approval_required" });
  const blocked = (await store.findRun(WS, first.operationId, SVC, "deploy"))!;
  await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: user("bob") });
  return release(svc, over);
}

beforeEach(() => {
  now = new Date("2026-10-05T10:00:00.000Z");
  resetProvenanceVerifiersForTests();
});

describe("state machine", () => {
  it("allows the pipeline order and nothing that skips a gate", () => {
    const path = ["planned", "built", "verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
    expect(canTransition("planned", "deployed")).toBe(false);
    expect(canTransition("built", "deployed")).toBe(false);
    expect(canTransition("blocked_approval", "deployed")).toBe(false);
    expect(canTransition("verified", "cut_over")).toBe(false);
    expect(canTransition("deployed", "cut_over")).toBe(false);
    expect(() => assertTransition("planned", "deployed")).toThrow(/cannot move from planned to deployed/);
  });
  it("terminal states are terminal, and only served releases can be rolled back", () => {
    for (const t of ["failed", "refused", "rolled_back"] as const) for (const to of ["verified", "deployed", "failed"] as const) expect(canTransition(t, to)).toBe(false);
    expect(canTransition("readback_verified", "rolled_back")).toBe(true);
    expect(canTransition("verified", "rolled_back")).toBe(false);
    expect(canTransition("blocked_approval", "rolled_back")).toBe(false);
  });
});

describe("source, digest, provenance, deploy, readiness, cutover, readback", () => {
  it("binds the digest, verifies provenance and walks every state to a verified readback", async () => {
    const { svc, store } = make();
    const run = await release(svc);
    expect(run.state).toBe("readback_verified");
    expect(run.imageDigest).toBe(D1);
    expect(run.provenance).toMatchObject({ level: "build_record", evidenceRef: "ev:v-build_record" });
    expect(run.rollout.percent).toBe(100);
    expect(run.readback).toMatchObject({ status: "verified", observedDigest: D1 });
    const events = await store.listEvents(WS, run.id);
    expect(events.map((e) => e.to)).toEqual(["planned", "built", "verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"]);
  });

  it("begin is idempotent for an operation and service", async () => {
    const { svc } = make();
    const a = await svc.begin(input());
    const b = await svc.begin(input());
    expect(b.id).toBe(a.id);
    expect(b.state).toBe("verified");
  });

  it("the digest is immutable: another digest needs another operation", async () => {
    const { svc } = make();
    await svc.begin(input());
    await expect(svc.begin(input({ imageDigest: D2, imageUri: uri(D2) }))).rejects.toMatchObject({ code: "digest_immutable" });
  });

  it("refuses an image reference that is not pinned to the bound digest", async () => {
    const { svc } = make();
    await expect(svc.begin(input({ imageUri: "registry.example.test/web:latest" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.begin(input({ imageUri: uri(D2) }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.begin(input({ imageDigest: "sha256:abc", imageUri: "registry.example.test/web@sha256:abc" }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a digest with no verified provenance and records why", async () => {
    const { svc, store } = make([verifier("build_record", false)]);
    await expect(svc.begin(input())).rejects.toMatchObject({ code: "provenance_unverified" });
    const run = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    expect(run.state).toBe("refused");
    expect(run.reason).toMatch(/no verified provenance/);
    await expect(svc.begin(input())).rejects.toBeInstanceOf(ReleaseSafetyError);
  });

  it("a verifier that throws, or no verifier at all, never counts as verified", async () => {
    const boom: ProvenanceVerifier = { name: "boom", verify: async () => { throw new Error("attestation service down"); } };
    await expect(make([boom]).svc.begin(input())).rejects.toMatchObject({ code: "provenance_unverified" });
    await expect(make([]).svc.begin(input())).rejects.toMatchObject({ code: "provenance_unverified" });
  });

  it("enforces the minimum level and takes the strongest verified verdict", async () => {
    await expect(make([verifier("pinned_digest")], "build_record").svc.begin(input())).rejects.toMatchObject({ code: "provenance_unverified" });
    const strong = make([verifier("pinned_digest"), verifier("attested")], "build_record");
    expect((await strong.svc.begin(input())).provenance.level).toBe("attested");
  });

  it("reads LIFE-09 verifiers from the registry hook", async () => {
    registerProvenanceVerifier(verifier("attested", true, "life09"));
    expect(registeredProvenanceVerifiers().map((v) => v.name)).toEqual(["life09"]);
    const store = createMemoryReleaseStore(clock);
    const svc = new ReleaseSafetyService({ store, verifiers: () => registeredProvenanceVerifiers(), clock, ids: () => `id${++n}`, minProvenance: "attested" });
    expect((await svc.begin(input())).provenance.level).toBe("attested");
  });

  it("cannot deploy before it is verified, or finish out of order", async () => {
    const { svc } = make();
    const run = await svc.begin(input());
    await expect(svc.markReady(run, "x")).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(svc.markCutOver(run, "x")).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("a stale writer loses the compare-and-set and an exact retry is a success", async () => {
    const { svc } = make();
    const run = await svc.begin(input());
    const moved = await svc.markDeployed(run, { percent: 100, detail: "first" });
    // the stale copy tries the same move again
    const again = await svc.markDeployed(run, { percent: 100, detail: "retry" });
    expect(again.id).toBe(moved.id);
    expect(again.state).toBe("deployed");
    await expect(svc.markReady(run, "stale")).rejects.toMatchObject({ code: expect.stringMatching(/invalid_transition|conflict/) });
  });

  it("readback: a mismatch fails, an unsupported adapter ends unverified, never verified", async () => {
    const a = make();
    let run = await a.svc.begin(input());
    run = await a.svc.markCutOver(await a.svc.markReady(await a.svc.markMigrated(await a.svc.markDeployed(run, { percent: 100, detail: "d" }), { ran: false }), "r"), "c");
    expect((await a.svc.recordReadback(run, { supported: true, observedDigest: D2 })).state).toBe("failed");

    const b = make();
    run = await b.svc.begin(input());
    run = await b.svc.markCutOver(await b.svc.markReady(await b.svc.markMigrated(await b.svc.markDeployed(run, { percent: 100, detail: "d" }), { ran: false }), "r"), "c");
    const unsupported = await b.svc.recordReadback(run, { supported: false });
    expect(unsupported.state).toBe("cut_over_unverified");
    expect(unsupported.readback?.status).toBe("unsupported");

    const c = make();
    run = await c.svc.begin(input());
    run = await c.svc.markCutOver(await c.svc.markReady(await c.svc.markMigrated(await c.svc.markDeployed(run, { percent: 100, detail: "d" }), { ran: false }), "r"), "c");
    expect((await c.svc.recordReadback(run, { supported: true, readable: false })).state).toBe("cut_over_unverified");
  });
});

describe("migration classification gates", () => {
  it("an expand (compatible) migration runs without a separate approval", async () => {
    const { svc } = make();
    let run = await svc.begin(input({ migration: { commandDigest: CMD, declared: "expand" } }));
    expect(run.migration).toMatchObject({ class: "expand", status: "cleared" });
    run = await svc.markDeployed(run, { percent: 100, detail: "d" });
    run = await svc.beginMigration(run);
    expect(run.migration.status).toBe("started");
    run = await svc.markMigrated(run, { ran: true, exitCode: 0 });
    expect(run.migration.status).toBe("ran");
  });

  it.each([
    ["contract", { declared: "contract" as const }],
    ["data", { declared: "data" as const }],
    ["unclassified", {}],
  ])("a %s migration stops before any rollout until a person approves", async (cls, decl) => {
    const { svc, store } = make();
    await expect(svc.begin(input({ migration: { commandDigest: CMD, ...decl } }))).rejects.toMatchObject({ code: "migration_approval_required" });
    const blocked = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    expect(blocked.state).toBe("blocked_approval");
    expect(blocked.migration).toMatchObject({ class: cls, status: "pending_approval" });
    // it cannot be deployed from here
    await expect(svc.markDeployed(blocked, { percent: 100, detail: "d" })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("SQL supplied for classification raises a declared expand to contract", async () => {
    const { svc, store } = make();
    await expect(svc.begin(input({ migration: { commandDigest: CMD, declared: "expand", sql: "alter table t drop column c" } }))).rejects.toMatchObject({ code: "migration_approval_required" });
    const run = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    expect(run.migration.class).toBe("contract");
    expect(run.migration.sqlDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run)).not.toContain("alter table");
  });

  it("the requester cannot approve their own migration, and neither can an agent", async () => {
    const { svc, store } = make();
    await expect(svc.begin(input({ migration: { commandDigest: CMD, declared: "contract" } }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const run = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    const binding = run.migration.bindingDigest!;
    await expect(svc.approveMigration({ workspaceId: WS, runId: run.id, bindingDigest: binding, approver: user("alice") })).rejects.toMatchObject({ code: "forbidden" });
    await expect(svc.approveMigration({ workspaceId: WS, runId: run.id, bindingDigest: binding, approver: { kind: "integration", id: "cred-1", name: "agent", onBehalfOf: "bob" } })).rejects.toMatchObject({ code: "forbidden" });
    // an agent acting for the requester is the requester
    const agentRun = make();
    await expect(agentRun.svc.begin(input({ requestedBy: "alice", migration: { commandDigest: CMD, declared: "data" } }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const blocked = (await agentRun.store.findRun(WS, "op-1", SVC, "deploy"))!;
    await expect(agentRun.svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: { kind: "user", id: "svc", name: "x", onBehalfOf: "alice" } })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("an approval is bound to the exact effect: a stale or different binding is refused", async () => {
    const { svc, store } = make();
    await expect(svc.begin(input({ migration: { commandDigest: CMD, declared: "contract" } }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const run = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    await expect(svc.approveMigration({ workspaceId: WS, runId: run.id, bindingDigest: "f".repeat(64), approver: user("bob") })).rejects.toMatchObject({ code: "approval_invalid" });
    await expect(svc.approveMigration({ workspaceId: WS, runId: "rel_unknown", bindingDigest: run.migration.bindingDigest!, approver: user("bob") })).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.approveMigration({ workspaceId: "ws-other", runId: run.id, bindingDigest: run.migration.bindingDigest!, approver: user("bob") })).rejects.toMatchObject({ code: "not_found" });
  });

  it("an approved migration proceeds once; the approval is single use and a new digest needs a new approval", async () => {
    const { svc, store } = make();
    const decl = { commandDigest: CMD, declared: "contract" as const };
    const first = await approvedRelease(svc, store, { operationId: "op-1", migration: decl });
    expect(first.state).toBe("readback_verified");
    expect(first.migration).toMatchObject({ class: "contract", status: "ran" });
    // same binding, new operation: the approval was consumed
    await expect(svc.begin(input({ operationId: "op-2", migration: decl }))).rejects.toMatchObject({ code: "migration_approval_required" });
    // a different image is a different binding
    await expect(svc.begin(input({ operationId: "op-3", imageDigest: D2, imageUri: uri(D2), migration: decl }))).rejects.toMatchObject({ code: "migration_approval_required" });
  });

  it("a retry of the dispatched migration reuses the provider key instead of needing a second approval", async () => {
    const { svc, store } = make();
    const decl = { commandDigest: CMD, declared: "data" as const };
    await expect(svc.begin(input({ migration: decl }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const blocked = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: user("bob") });
    let run = await svc.begin(input({ migration: decl }));
    run = await svc.markDeployed(run, { percent: 100, detail: "d" });
    const started = await svc.beginMigration(run);
    expect(started.migration.status).toBe("started");
    const retried = await svc.beginMigration(started);
    expect(retried.migration.status).toBe("started");
  });

  it("an expired approval no longer clears the gate", async () => {
    const { svc, store } = make();
    const decl = { commandDigest: CMD, declared: "contract" as const };
    await expect(svc.begin(input({ migration: decl }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const blocked = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: user("bob"), ttlSec: 60 });
    now = new Date(now.getTime() + 3 * 60_000);
    await expect(svc.begin(input({ operationId: "op-2", migration: decl }))).rejects.toMatchObject({ code: "migration_approval_required" });
  });

  it("an approver who is the new requester cannot satisfy the gate", async () => {
    const { svc, store } = make();
    const decl = { commandDigest: CMD, declared: "contract" as const };
    await expect(svc.begin(input({ migration: decl }))).rejects.toBeInstanceOf(ReleaseSafetyError);
    const blocked = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    await svc.approveMigration({ workspaceId: WS, runId: blocked.id, bindingDigest: blocked.migration.bindingDigest!, approver: user("bob") });
    await expect(svc.begin(input({ operationId: "op-2", requestedBy: "bob", migration: decl }))).rejects.toMatchObject({ code: "migration_approval_required" });
  });

  it("a failed migration fails the release and says nothing was reverted", async () => {
    const { svc } = make();
    let run = await svc.begin(input({ migration: { commandDigest: CMD, declared: "expand" } }));
    run = await svc.markDeployed(run, { percent: 100, detail: "d" });
    run = await svc.beginMigration(run);
    run = await svc.markMigrated(run, { ran: true, exitCode: 3 });
    expect(run.state).toBe("failed");
    expect(run.migration).toMatchObject({ status: "failed", exitCode: 3 });
    expect(run.reason).toMatch(/Nothing was reverted/);
  });
});

describe("progressive rollout", () => {
  const progressive = { strategy: "progressive" as const, steps: [10, 50, 100], bakeSec: 30 };

  it("is refused before any effect when the provider cannot split traffic", async () => {
    const { svc, store } = make();
    await expect(svc.begin(input({ provider: "aws", rollout: progressive }))).rejects.toMatchObject({ code: "rollout_unsupported" });
    const run = (await store.findRun(WS, "op-1", SVC, "deploy"))!;
    expect(run.state).toBe("refused");
    expect(run.reason).toMatch(/CodeDeploy|weighted/);
    await expect(make().svc.begin(input({ rollout: progressive, progressive: { supported: false, reason: "no mesh" } }))).rejects.toThrow(/no mesh/);
  });

  it("is recorded as canary steps when the provider supports it", async () => {
    const { svc } = make();
    const run = await svc.begin(input({ rollout: progressive, progressive: { supported: true } }));
    expect(run.rollout).toMatchObject({ strategy: "progressive", steps: [10, 50, 100], bakeSec: 30, percent: 0 });
    expect(canarySteps(run.rollout)).toEqual([10, 50]);
    const a = await svc.markDeployed(run, { percent: 10, detail: "10%" });
    const b = await svc.markDeployed(a, { percent: 50, detail: "50%" });
    expect(b.rollout.percent).toBe(50);
    expect(b.state).toBe("deployed");
  });

  it("validates the declaration", () => {
    expect(normalizeRollout(undefined)).toMatchObject({ strategy: "rolling", steps: [100] });
    expect(() => normalizeRollout({ strategy: "rolling", steps: [10, 100] })).toThrow(/no traffic steps/);
    expect(() => normalizeRollout({ strategy: "progressive", steps: [10, 50] })).toThrow(/last rollout step must be 100/);
    expect(() => normalizeRollout({ strategy: "progressive", steps: [50, 10, 100] })).toThrow(/strictly increase/);
    expect(() => normalizeRollout({ strategy: "progressive", steps: [100] })).toThrow(/at least one canary/);
    expect(() => normalizeRollout({ strategy: "progressive", steps: [0, 100] })).toThrow(/whole percentages/);
    expect(() => normalizeRollout({ strategy: "progressive", steps: [10, 100], bakeSec: 99999 })).toThrow(/bake period/);
    expect(normalizeRollout({ strategy: "progressive" })).toMatchObject({ steps: [10, 100], bakeSec: 60 });
  });
});

describe("code rollback never auto-reverts data", () => {
  it("is refused after a contract migration ran since the target digest served, naming the release", async () => {
    const { svc, store } = make();
    const r1 = await release(svc, { operationId: "op-1" });
    const r2 = await approvedRelease(svc, store, { operationId: "op-2", imageDigest: D2, imageUri: uri(D2), migration: { commandDigest: CMD, declared: "contract" } });
    const verdict = await svc.rollbackSafety({ workspaceId: WS, environmentId: ENV, serviceAddress: SVC, targetDigest: D1 });
    expect(verdict).toMatchObject({ allowed: false, blockingRunId: r2.id, restoresRunId: r1.id });
    expect(verdict.reason).toMatch(/contract migration/);
    await expect(svc.begin(input({ operationId: "op-rb", kind: "rollback", imageDigest: D1, imageUri: uri(D1), origin: "pinned" }))).rejects.toMatchObject({ code: "rollback_unsafe" });
    expect((await store.findRun(WS, "op-rb", SVC, "rollback"))!.state).toBe("refused");
    // restoring the digest that is already current is not blocked by its own migration
    expect((await svc.rollbackSafety({ workspaceId: WS, environmentId: ENV, serviceAddress: SVC, targetDigest: D2 })).allowed).toBe(true);
  });

  it("is allowed across expand migrations and across data migrations (with a warning), and never runs a migration", async () => {
    const { svc, store } = make();
    await release(svc, { operationId: "op-1" });
    const r2 = await approvedRelease(svc, store, { operationId: "op-2", imageDigest: D2, imageUri: uri(D2), migration: { commandDigest: CMD, declared: "data" } });
    const verdict = await svc.rollbackSafety({ workspaceId: WS, environmentId: ENV, serviceAddress: SVC, targetDigest: D1 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings.join(" ")).toMatch(/does not revert data/);

    let rb = await svc.begin(input({ operationId: "op-rb", kind: "rollback", imageDigest: D1, imageUri: uri(D1), origin: "pinned", migration: { commandDigest: CMD, declared: "contract" } }));
    expect(rb.migration).toMatchObject({ class: "none", status: "none" });
    expect(rb.restoresRunId).toBeDefined();
    rb = await svc.markDeployed(rb, { percent: 100, detail: "restored" });
    await expect(svc.beginMigration(rb)).rejects.toMatchObject({ code: "rollback_unsafe" });
    rb = await svc.recordReadback(await svc.markCutOver(await svc.markReady(await svc.markMigrated(rb, { ran: false }), "r"), "c"), { supported: true, observedDigest: D1 });
    expect(rb.state).toBe("readback_verified");
    const replaced = await svc.markRolledBack(WS, r2.id, "code rolled back");
    expect(replaced?.state).toBe("rolled_back");
    // the data migration record is untouched by the rollback
    expect(replaced?.migration).toMatchObject({ class: "data", status: "ran" });
  });

  it("an unknown target digest is refused only when a blocking migration is on record", async () => {
    const clean = make();
    await release(clean.svc, { operationId: "op-1" });
    expect((await clean.svc.rollbackSafety({ workspaceId: WS, environmentId: ENV, serviceAddress: SVC, targetDigest: D3 })).allowed).toBe(true);
    const dirty = make();
    await approvedRelease(dirty.svc, dirty.store, { operationId: "op-1", migration: { commandDigest: CMD, declared: "contract" } });
    const verdict = await dirty.svc.rollbackSafety({ workspaceId: WS, environmentId: ENV, serviceAddress: SVC, targetDigest: D3 });
    expect(verdict.allowed).toBe(false);
  });

  it("a rollback restores the digest the revision last served instead of rebuilding", async () => {
    const { svc } = make();
    await release(svc, { operationId: "op-1", revisionId: "rev-1" });
    await release(svc, { operationId: "op-2", revisionId: "rev-2", imageDigest: D2, imageUri: uri(D2) });
    const served = await svc.lastServedForRevision(WS, ENV, SVC, "rev-1");
    expect(served?.imageDigest).toBe(D1);
    expect(await svc.lastServedForRevision(WS, ENV, SVC, "rev-unknown")).toBeNull();
    expect((await svc.currentRelease(WS, ENV, SVC))?.imageDigest).toBe(D2);
  });

  it("a rollback re-verifies provenance unless the digest already served with a recorded verdict", async () => {
    let ok = true;
    const flaky: ProvenanceVerifier = { name: "flaky", verify: async () => (ok ? { verified: true, level: "pinned_digest" } : { verified: false, level: "none", reason: "verifier offline" }) };
    const { svc } = make([flaky], "pinned_digest");
    await release(svc, { operationId: "op-1" });
    ok = false;
    // a new digest is refused while the verifier is down
    await expect(svc.begin(input({ operationId: "op-3", imageDigest: D3, imageUri: uri(D3) }))).rejects.toMatchObject({ code: "provenance_unverified" });
    // the digest that already served keeps its recorded verdict, so a code rollback to it is still possible
    const rb = await svc.begin(input({ operationId: "op-rb", kind: "rollback", imageDigest: D1, imageUri: uri(D1), origin: "pinned" }));
    expect(rb.state).toBe("verified");
    expect(rb.provenance.level).toBe("pinned_digest");
  });
});

describe("memory store contract", () => {
  it("tenant scoping: another workspace cannot read or move a run", async () => {
    const { svc, store } = make();
    const run = await svc.begin(input());
    expect(await store.getRun("ws-other", run.id)).toBeNull();
    await expect(svc.get("ws-other", run.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await store.transition({ workspaceId: "ws-other", id: run.id, expectVersion: run.version, to: "deployed", actor: "x", detail: "x" })).toBeNull();
  });
  it("listRuns filters by environment, service, state and revision", async () => {
    const { svc, store } = make();
    await release(svc, { operationId: "op-1", revisionId: "rev-1" });
    await svc.begin(input({ operationId: "op-2", serviceAddress: "container_service/api", imageDigest: D2, imageUri: uri(D2), revisionId: "rev-2" }));
    expect(await store.listRuns(WS, { serviceAddress: SVC })).toHaveLength(1);
    expect(await store.listRuns(WS, { states: ["verified"] })).toHaveLength(1);
    expect(await store.listRuns(WS, { revisionId: "rev-2" })).toHaveLength(1);
    expect(await store.listRuns(WS, { environmentId: "env-x" })).toHaveLength(0);
  });
});
