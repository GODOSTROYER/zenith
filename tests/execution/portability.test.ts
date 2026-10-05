/**
 * PROD-LIFE-11 worker side: the four portability capabilities as `executeCapability`
 * runs them, and the decommission gate on the teardown and plan paths.
 *
 * The execution fakes stand in for ports (the same convention as the rest of this
 * directory): the store, the drivers and the broker are scripted, so what is under
 * test is the worker's own decisions. The engines themselves run against real
 * Postgres and real storage in tests/portability; the repository against a real
 * platform database in tests/portability/store.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AdoptInput, PortabilityExport, PortabilityRestore, ReleaseInput, ResourceAdoption } from "@/lib/controlplane/db/repos/portability";
import { assertPlanDeletionsOwned, assertTeardownOwnership } from "@/lib/execution/decommission";
import { StepFailedError } from "@/lib/execution/errors";
import type { PortabilityPort } from "@/lib/execution/ports";
import type { AdoptionFact } from "@/lib/portability/decommission";
import type { ResourceNode } from "@/lib/resources/types";
import { ENV, OP, PROJECT, REVISION, WS } from "./fakes/fixtures";
import { presentObservation, type DriverScript } from "./fakes/drivers";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

class FakePortability implements PortabilityPort {
  readonly adopted: AdoptInput[] = [];
  readonly released: ReleaseInput[] = [];
  readonly exports = new Map<string, PortabilityExport>();
  adoption: ResourceAdoption | null = null;
  facts: AdoptionFact[] = [];
  async recordExport(): Promise<PortabilityExport> {
    throw new Error("not reached in these tests");
  }
  async getExport(_ws: string, id: string): Promise<PortabilityExport | null> {
    return this.exports.get(id) ?? null;
  }
  async recordRestore(): Promise<PortabilityRestore> {
    throw new Error("not reached in these tests");
  }
  async adopt(input: AdoptInput): Promise<ResourceAdoption> {
    this.adopted.push(input);
    return { id: "ado-1", workspaceId: WS, environmentId: ENV, resourceId: input.resourceId, address: "postgres/legacy-db", provider: "aws", nativeType: "aws:rds_instance", externalId: input.externalId, lifecycle: input.lifecycle as "manage", claim: input.claim, claimDigest: input.claimDigest, fieldOwners: input.fieldOwners, baseline: input.baseline, baselineDigest: input.baselineDigest, operationId: input.operationId, approvalId: input.approvalId, proposalDigest: "a".repeat(64), status: "active", adoptedAt: "2026-10-05T00:00:00.000Z" };
  }
  async release(input: ReleaseInput): Promise<ResourceAdoption> {
    this.released.push(input);
    return { ...this.adoption!, status: "released", releasedAt: "2026-10-05T00:00:00.000Z", releasedBy: input.releasedBy, releaseOperationId: input.operationId };
  }
  async getAdoption(): Promise<ResourceAdoption | null> {
    return this.adoption;
  }
  async adoptionFacts(): Promise<AdoptionFact[]> {
    return this.facts;
  }
}

const manifest = (db: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
  version: 1,
  services: [],
  resources: [{ id: "res-db", name: "legacy-db", kind: "postgres", config: {}, size: "small", ...db }, ...extra],
  routes: [],
  bindings: [],
});
const referencedDb = manifest({ ownership: "referenced", externalRef: "legacy-db-1" });
const managedDb = manifest({ ownership: "managed" });

interface Setup { capability: string; input: Record<string, unknown>; manifest?: unknown; address?: string; observe?: DriverScript["observe"]; approved?: boolean; port?: FakePortability | null; options?: Partial<WorldOptions> }

async function setup(s: Setup) {
  const observe: NonNullable<DriverScript["observe"]> = s.observe ?? (async (ctx, node) => ({
    ...presentObservation(ctx, node, {
      engineVersion: { state: "known", value: "16", observedAt: ctx.now().toISOString() },
      allocatedStorage: { state: "known", value: 20, observedAt: ctx.now().toISOString() },
      unreadable: { state: "unknown", reason: "access_denied" },
    }),
    externalId: "legacy-db-1",
  }));
  const w = createWorld({ overrides: { "aws:rds_instance": { observe } }, ...s.options });
  worlds.push(w);
  const port = s.port === undefined ? new FakePortability() : s.port;
  if (port) w.deps.portability = port;
  w.broker.approval = s.approved === false ? { approved: false, rejected: false } : { approved: true, rejected: false, approvalId: "apr-1" };
  w.product.setManifest(s.manifest ?? referencedDb);
  w.product.base.environment.deployedRevisionId = REVISION;
  const def = { capability: s.capability, scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV }, input: s.input, summary: s.capability, details: [], risk: "high" as const };
  w.ops.seed({ capability: s.capability, proposal: def });
  await w.activities.validateDesiredState({ operationId: OP });
  const target = w.resources.byAddress(s.address ?? "postgres/legacy-db")!;
  w.ops.seed({ capability: s.capability, proposal: def, status: "approved", resourceId: target.id });
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  return { w, port, lease, target, run: () => w.activities.executeCapability({ operationId: OP, lease }) };
}

const claim = (over: Record<string, unknown> = {}) => ({ claim: { externalId: "legacy-db-1", acknowledge: true, lifecycle: "manage", ...over } });

describe("resource.adopt", () => {
  it("adopts a referenced resource when a live read proves the claimed object, recording the claim, the registry owners and a drift baseline", async () => {
    const { w, port, run, target } = await setup({ capability: "resource.adopt", input: claim() });
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/Adopted postgres\/legacy-db \(manage\)/);
    expect(port!.adopted).toHaveLength(1);
    const adopted = port!.adopted[0]!;
    expect(adopted).toMatchObject({ workspaceId: WS, environmentId: ENV, resourceId: target.id, operationId: OP, approvalId: "apr-1", externalId: "legacy-db-1", lifecycle: "manage" });
    expect(adopted.claimDigest).toMatch(/^[0-9a-f]{64}$/);
    // the baseline holds known, IaC-owned attributes only; an unreadable one is not invented
    expect(adopted.baseline.attributes).toEqual({ engineVersion: "16", allocatedStorage: 20 });
    expect(w.evidence.ofKind("observation")[0]!.summary).toMatchObject({ capability: "resource.adopt", ok: true, adoptionId: "ado-1", baselineFields: 2 });
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
    // the live read used the observe role, not a deploy role
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "observe", capability: "infrastructure.observe" });
  });

  it("refuses without a current human approval and changes nothing", async () => {
    const { port, run } = await setup({ capability: "resource.adopt", input: claim(), approved: false });
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/human approval/);
    expect(port!.adopted).toHaveLength(0);
  });

  it("refuses when the live object is not the object the claim names", async () => {
    const { port, run } = await setup({ capability: "resource.adopt", input: claim({ externalId: "legacy-db-2" }) });
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/identity/);
    expect(port!.adopted).toHaveLength(0);
  });

  it("refuses when the object cannot be found, or only a simulated read exists outside a sandbox", async () => {
    const missing = await setup({ capability: "resource.adopt", input: claim(), observe: async (ctx, node) => ({ ...presentObservation(ctx, node), presence: "missing" }) });
    await expect(missing.run()).rejects.toThrow(/not found by a live read/);
    const simulated = await setup({ capability: "resource.adopt", input: claim(), observe: async (ctx, node) => ({ ...presentObservation(ctx, node), externalId: "legacy-db-1", simulated: true }) });
    await expect(simulated.run()).rejects.toThrow(/simulated/);
    expect(missing.port!.adopted.length + simulated.port!.adopted.length).toBe(0);
  });

  it("refuses a resource that is already managed", async () => {
    const managed = await setup({ capability: "resource.adopt", input: claim(), manifest: managedDb });
    await expect(managed.run()).rejects.toThrow(/only a referenced resource/);
    expect(managed.port!.adopted).toHaveLength(0);
  });

  it("refuses when the worker has no portability store", async () => {
    const { run } = await setup({ capability: "resource.adopt", input: claim(), port: null });
    await expect(run()).rejects.toThrow(/no portability store/);
  });

  it("refuses a malformed claim before anything is read", async () => {
    const { run, w } = await setup({ capability: "resource.adopt", input: { claim: { externalId: "x", acknowledge: false } } });
    await expect(run()).rejects.toThrow(/input is invalid/);
    expect(w.credentials.sessions).toHaveLength(0);
  });
});

describe("resource.release", () => {
  const active = (over: Partial<ResourceAdoption> = {}): ResourceAdoption => ({ id: "ado-1", workspaceId: WS, environmentId: ENV, resourceId: "x", address: "postgres/legacy-db", provider: "aws", nativeType: "aws:rds_instance", externalId: "legacy-db-1", lifecycle: "manage", claim: {}, claimDigest: "a".repeat(64), fieldOwners: [], baseline: {}, baselineDigest: "b".repeat(64), operationId: "op-adopt", approvalId: "apr-0", proposalDigest: "c".repeat(64), status: "active", adoptedAt: "2026-10-04T00:00:00.000Z", ...over });

  it("hands an adopted resource back under approval, touching no cloud", async () => {
    const s = await setup({ capability: "resource.release", input: { adoptionId: "ado-1" }, manifest: managedDb });
    s.port!.adoption = active({ resourceId: s.target.id });
    const out = await s.run();
    expect(out.ok).toBe(true);
    expect(s.port!.released).toEqual([expect.objectContaining({ adoptionId: "ado-1", resourceId: s.target.id, operationId: OP, approvalId: "apr-1", releasedBy: "user-1" })]);
    expect(s.w.credentials.sessions).toHaveLength(0);
  });

  it("refuses a claim that belongs to another resource, one already released, and an unapproved release", async () => {
    const other = await setup({ capability: "resource.release", input: { adoptionId: "ado-1" }, manifest: managedDb });
    other.port!.adoption = active({ resourceId: "someone-else" });
    await expect(other.run()).rejects.toThrow(/does not belong to this resource/);
    const done = await setup({ capability: "resource.release", input: { adoptionId: "ado-1" }, manifest: managedDb });
    done.port!.adoption = active({ resourceId: done.target.id, status: "released" });
    await expect(done.run()).rejects.toThrow(/already released/);
    const unapproved = await setup({ capability: "resource.release", input: { adoptionId: "ado-1" }, manifest: managedDb, approved: false });
    unapproved.port!.adoption = active({ resourceId: unapproved.target.id });
    await expect(unapproved.run()).rejects.toThrow(/human approval/);
    expect(other.port!.released.length + done.port!.released.length + unapproved.port!.released.length).toBe(0);
  });
});

describe("data.export and data.import refuse before any effect", () => {
  const destination = { resourceAddress: "object_store/assets", credentialsRef: "vault:proj/backups/credentials" };
  const withBucket = (db: Record<string, unknown>, bucket: Record<string, unknown> = {}) => manifest(db, [{ id: "res-assets", name: "assets", kind: "object_store", config: {}, size: "small", ownership: "managed", ...bucket }]);

  it("refuses an export with no usable destination in the environment", async () => {
    const s = await setup({ capability: "data.export", input: { destination } });
    // a referenced postgres on aws is a supported source, so the first refusal is the missing destination resource
    await expect(s.run()).rejects.toThrow(/not an object store resource/);
  });

  it("refuses an export whose destination is documented-only (external) storage or the source itself", async () => {
    const ext = await setup({ capability: "data.export", input: { destination }, manifest: manifest({ ownership: "managed" }, [{ id: "res-assets", name: "assets", kind: "object_store", config: {}, size: "small", ownership: "external" }]) });
    await expect(ext.run()).rejects.toThrow(/documented only|external/);
  });

  it("refuses to restore into a resource Zenith does not manage, from an unknown export, from the same resource, or across kinds", async () => {
    const referenced = await setup({ capability: "data.import", input: { exportId: "pex_1", destination }, manifest: withBucket({ ownership: "referenced", externalRef: "legacy-db-1" }) });
    await expect(referenced.run()).rejects.toThrow(/restores are written only into a new target Zenith manages/);
    const unknown = await setup({ capability: "data.import", input: { exportId: "pex_missing", destination }, manifest: withBucket({ ownership: "managed" }) });
    await expect(unknown.run()).rejects.toThrow(/does not exist in this workspace/);
    const exp = (over: Partial<PortabilityExport>): PortabilityExport => ({ id: "pex_1", workspaceId: WS, environmentId: ENV, operationId: "op-x", resourceId: "res-other", address: "postgres/source", kind: "postgres", provider: "aws", engine: "postgres-logical-v1", destinationLabel: "s3://b/p/", artifactPrefix: "p/", manifestDigest: "a".repeat(64), contentDigest: "b".repeat(64), fileCount: 1, byteSize: 1, coverage: {}, verifiedAt: "2026-10-05T00:00:00.000Z", createdAt: "2026-10-05T00:00:00.000Z", ...over });
    const same = await setup({ capability: "data.import", input: { exportId: "pex_1", destination }, manifest: withBucket({ ownership: "managed" }) });
    same.port!.exports.set("pex_1", exp({ resourceId: same.target.id }));
    await expect(same.run()).rejects.toThrow(/never overwrites the resource the export came from/);
    const kind = await setup({ capability: "data.import", input: { exportId: "pex_1", destination }, manifest: withBucket({ ownership: "managed" }) });
    kind.port!.exports.set("pex_1", exp({ kind: "mysql" }));
    await expect(kind.run()).rejects.toThrow(/cannot be restored into a postgres target/);
  });

  it("refuses when the worker has no portability store", async () => {
    const s = await setup({ capability: "data.export", input: { destination }, port: null });
    await expect(s.run()).rejects.toThrow(/no portability store/);
  });
});

describe("decommission gate", () => {
  const node = (over: Partial<ResourceNode> & { address: string }): ResourceNode => ({ kind: "postgres", provider: "aws", region: "us-east-1", nativeType: "aws:rds_instance", ownership: "managed", spec: {}, origin: [], dependsOn: [], specDigest: "d".repeat(64), labels: {}, ...over });
  const rt = (facts: AdoptionFact[] | null) => ({ d: { portability: facts === null ? undefined : { adoptionFacts: async () => facts } } }) as unknown as Parameters<typeof assertTeardownOwnership>[0];
  const scope = { workspaceId: WS, environmentId: ENV };
  const fact = (over: Partial<AdoptionFact> = {}): AdoptionFact => ({ address: "postgres/legacy-db", externalId: "legacy-db-1", status: "active", lifecycle: "manage", approvalId: "apr-0", ...over });

  it("refuses to tear down an adopted object whose claim does not allow destruction, naming it", async () => {
    await expect(assertTeardownOwnership(rt([fact()]), scope, [node({ address: "postgres/legacy-db", externalRef: "legacy-db-1" })])).rejects.toThrow(/was adopted, not created by Zenith/);
  });

  it("allows it when the human claim allowed destruction, and ignores nodes Zenith never manages", async () => {
    await expect(assertTeardownOwnership(rt([fact({ lifecycle: "manage_and_destroy" })]), scope, [node({ address: "postgres/legacy-db", externalRef: "legacy-db-1" })])).resolves.toBeUndefined();
    await expect(assertTeardownOwnership(rt([fact()]), scope, [node({ address: "postgres/other", ownership: "referenced" })])).resolves.toBeUndefined();
  });

  it("refuses a released claim and a managed node pointing at an object adopted under another address", async () => {
    await expect(assertTeardownOwnership(rt([fact({ status: "released" })]), scope, [node({ address: "postgres/legacy-db" })])).rejects.toThrow(/released/);
    await expect(assertTeardownOwnership(rt([fact()]), scope, [node({ address: "postgres/alias", externalRef: "legacy-db-1" })])).rejects.toThrow(/adopted under another address/);
  });

  it("applies to plan deletions and replacements only", async () => {
    const nodes = [node({ address: "postgres/legacy-db", externalRef: "legacy-db-1" }), node({ address: "postgres/fresh" })];
    const plan = (action: string, address: string) => ({ resourceChanges: [{ address: "aws_db_instance.x", nodeAddress: address, type: "aws_db_instance", providerName: "aws", action, changes: [], destroysData: true }] }) as never;
    await expect(assertPlanDeletionsOwned(rt([fact()]), scope, plan("delete", "postgres/legacy-db"), nodes)).rejects.toThrow(/adopted/);
    await expect(assertPlanDeletionsOwned(rt([fact()]), scope, plan("replace", "postgres/legacy-db"), nodes)).rejects.toThrow(/adopted/);
    await expect(assertPlanDeletionsOwned(rt([fact()]), scope, plan("update", "postgres/legacy-db"), nodes)).resolves.toBeUndefined();
    await expect(assertPlanDeletionsOwned(rt([fact()]), scope, plan("delete", "postgres/fresh"), nodes)).resolves.toBeUndefined();
  });

  it("is vacuous without adoption facts or without a portability store (test fakes)", async () => {
    await expect(assertTeardownOwnership(rt([]), scope, [node({ address: "postgres/legacy-db" })])).resolves.toBeUndefined();
    await expect(assertTeardownOwnership(rt(null), scope, [node({ address: "postgres/legacy-db" })])).resolves.toBeUndefined();
  });
});
