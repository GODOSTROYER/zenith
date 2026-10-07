/**
 * PROD-DUR-03 / PROD-DUR-04 at the dispatch points of the real execution activities (isolated fakes):
 * planning records the reviewed semantics write-once and shows them in the plan evidence; the re-plan
 * before apply and the apply dispatch itself recompute them and refuse when anything relevant moved;
 * dispatch-time authority is decided again from current state. Real-PostgreSQL behaviour of the table is
 * covered in tests/controlplane/executable-semantics.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { projectPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { readExecutableSemantics } from "@/lib/execution/semantics/digest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { MemorySemanticsStore } from "@/lib/execution/semantics/store";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { StepFailedError } from "@/lib/execution/errors";
import { ReleaseSafetyService, createMemoryReleaseStore, type ProvenanceVerifier } from "@/lib/release-safety";
import { OP, WS, bucketManifest, migratingManifest } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

function world(withStore = true): { w: World; store: MemorySemanticsStore } {
  const store = new MemorySemanticsStore();
  const w = createWorld(withStore ? { semantics: store } : {});
  w.product.setManifest(bucketManifest());
  // Explicit isolated human-authority fixture; the real broker's dispatch authority is tested in tests/capabilities.
  w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
  worlds.push(w);
  return { w, store };
}

async function planned(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  await w.activities.validateDesiredState({ operationId: OP });
  const lease = await w.lease();
  const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { lease, plan };
}

type Mutable = { activeOwnershipTransfers?: () => Promise<unknown[]> };
const transfer = { address: "object_store/assets", resourceType: "aws_s3_bucket", path: "versioning", from: "iac", to: "release", approvalId: "apr_1", approvedAt: "2026-09-30T00:00:00.000Z", digest: "7".repeat(64) };
const moveOwnership = (w: World): void => {
  (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [transfer];
};

describe("planning records what the approver is shown", () => {
  it("writes the semantics once, bound to the plan digest, and shows the same digest in the plan evidence", async () => {
    const { w, store } = world();
    const { plan } = await planned(w);
    const row = await store.get(WS, OP, plan.planDigest);
    expect(row).not.toBeNull();
    const [evidence] = w.evidence.ofKind("tofu_plan");
    const shown = readExecutableSemantics(evidence.summary.semantics);
    expect(shown?.digest).toBe(row!.semantics.digest);
    // the plan review projection the approval card and the broker read carries it
    const review = projectPlanReview(evidence.summary, plan.planDigest);
    expect(review?.semantics?.digest).toBe(row!.semantics.digest);
  });

  it("a plan whose evidence carries a malformed semantics document is not reviewable", async () => {
    const { w } = world();
    const { plan } = await planned(w);
    const [evidence] = w.evidence.ofKind("tofu_plan");
    expect(projectPlanReview({ ...evidence.summary, semantics: { format: "zenith.executable-semantics.v1", digest: "0".repeat(64), components: {} } }, plan.planDigest)).toBeUndefined();
  });

  it("without a store the legacy behaviour holds and the evidence still shows the semantics", async () => {
    const { w } = world(false);
    const { lease, plan } = await planned(w);
    expect(readExecutableSemantics(w.evidence.ofKind("tofu_plan")[0].summary.semantics)).toBeDefined();
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).resolves.toMatchObject({ applied: 1 });
  });
});

describe("the re-plan before apply", () => {
  it("passes when nothing relevant changed", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    const again = await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: plan.planDigest, lease });
    expect(again.planDigest).toBe(plan.planDigest);
  });

  it("refuses with a plan_changed failure naming the component when ownership moved after review", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    moveOwnership(w);
    const err = await w.activities.finalPlan({ operationId: OP, approvedPlanDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
    expect((err as SemanticsChangedError).type).toBe(FAILURE_TYPES.planChanged);
    expect((err as Error).message).toMatch(/final plan/);
  });
});

describe("apply dispatch", () => {
  it("dispatches the reviewed original when the semantics are unchanged", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    const out = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(out.applied).toBe(1);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);
  });

  it("refuses at dispatch, before any write, when an ownership transfer appeared after approval", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    moveOwnership(w);
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
    expect((err as SemanticsChangedError).message).toMatch(/apply dispatch/);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
  });

  it("refuses a plan with no recorded semantics rather than treating it as unchanged", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    w.deps.semantics = new MemorySemanticsStore();
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/No executable semantics were recorded/);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it("refuses when current human approval was withdrawn after review (authority is decided at dispatch)", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    w.broker.approval = { approved: false, rejected: false };
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toThrow(/Current policy or human approval changed/);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it("the semantics check runs before the approval check, so a moved plan is never mistaken for a missing approval", async () => {
    const { w } = world();
    const { lease, plan } = await planned(w);
    moveOwnership(w);
    w.broker.approval = { approved: false, rejected: false };
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(SemanticsChangedError);
  });
});

describe("release steps: build, rollout and migration dispatch", () => {
  const SVC = "container_service/web";
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const image = { service: SVC, imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@${DIGEST}`, digest: DIGEST };
  const verifier: ProvenanceVerifier = { name: "test", verify: async () => ({ verified: true, level: "pinned_digest", evidenceRef: "ev:test" }) };

  async function releasing() {
    const store = new MemorySemanticsStore();
    const safety = new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier], minProvenance: "pinned_digest" });
    const w = createWorld({ semantics: store, releaseSafety: safety });
    const manifest = migratingManifest();
    manifest.release = { migrate: { ...manifest.release!.migrate!, class: "expand" } };
    w.product.setManifest(manifest);
    w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
    worlds.push(w);
    const { lease, plan } = await planned(w);
    return { w, lease, plan, store };
  }
  const move = (w: World): void => {
    (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [{ ...transfer, address: SVC }];
  };

  it("rolls out and migrates when the semantics are unchanged", async () => {
    const { w, lease } = await releasing();
    expect(await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] })).toEqual({ services: 1 });
    expect(w.workloads.deployed).toHaveLength(1);
    expect((await w.activities.runMigrations({ operationId: OP, lease })).ran).toBe(true);
    expect(w.migrations.runs).toHaveLength(1);
  });

  it("refuses the first rollout effect when the semantics moved after review", async () => {
    const { w, lease } = await releasing();
    move(w);
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as SemanticsChangedError).message).toMatch(/rollout dispatch/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("refuses the migration, and spends no single-use migration approval, when the semantics moved after the rollout", async () => {
    const { w, lease } = await releasing();
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] });
    move(w);
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SemanticsChangedError);
    expect((err as SemanticsChangedError).message).toMatch(/migration dispatch/);
    expect(w.migrations.runs).toHaveLength(0);
  });

  it("decides authorization again at rollout dispatch from current state", async () => {
    const { w, lease } = await releasing();
    w.broker.approval = { approved: false, rejected: true };
    const err = await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/Current policy or human approval changed before rollout dispatch/);
    expect(w.workloads.deployed).toHaveLength(0);
  });

  it("decides authorization again at migration dispatch from current state", async () => {
    const { w, lease } = await releasing();
    await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] });
    w.broker.approval = { approved: true, rejected: false }; // no approval id although the operation requires one
    w.ops.seed({ ...(await w.ops.get(OP))!, approvalRequired: true });
    const err = await w.activities.runMigrations({ operationId: OP, lease }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Current policy or human approval changed before migration dispatch/);
    expect(w.migrations.runs).toHaveLength(0);
  });

  it("a legacy worker without the store dispatches as before", async () => {
    const w = createWorld({ releaseSafety: new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier], minProvenance: "pinned_digest" }) });
    worlds.push(w);
    const manifest = migratingManifest();
    manifest.release = { migrate: { ...manifest.release!.migrate!, class: "expand" } };
    w.product.setManifest(manifest);
    await w.activities.markOperation({ operationId: OP, status: "running" });
    const lease = await w.lease();
    move(w);
    expect(await w.activities.deployWorkloads({ operationId: OP, lease, images: [image] })).toEqual({ services: 1 });
  });
});
