/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-LIFE-07 contract evidence against fake-api.ts: StatefulSet and CronJob
 * lifecycle (apply, immutability, ordered rollout, rollback, scale), readiness
 * readback, persistent-data retention and teardown, CSI snapshot/restore with
 * refusals, and NetworkPolicy engine detection. A fake API server is contract
 * evidence only; the real-cluster proof is lifecycle-acceptance.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diff, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { getDriver } from "@/lib/drivers/types";
import { registerKubernetesDrivers } from "@/lib/providers/kubernetes/drivers";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { evaluateRollout } from "@/lib/providers/kubernetes/rollout";
import { teardownKubernetesEnvironment } from "@/lib/providers/kubernetes";
import { RawObjectApi, createK8sClient } from "@/lib/providers/kubernetes/client";
import { chooseSnapshotClass, detectSnapshotSupport } from "@/lib/providers/kubernetes/snapshots";
import { detectPolicyEngine } from "@/lib/providers/kubernetes/cni";
import { ANNOTATION, LABEL } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, cronNode, dbNode, driverCtx, firewallToDb, inNs, networkNode, serviceNode, sessionFor, volumeNode } from "./helpers";
import { PINNED_IMAGE, claimOf, ledgerPod, nativeCronNode, seedClaims, stsNode } from "./lifecycle-support";

registerKubernetesDrivers();

const IMAGE_B = `registry.example.com/acme/store@sha256:${"b".repeat(64)}`;
const CSI = "csi.example.com";
const SNAPSHOT_API = "snapshot.storage.k8s.io/v1";

let fake: FakeK8s;
beforeEach(async () => {
  fake = await startFakeK8s({ snapshotsReady: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterEach(async () => {
  await fake.close();
});

const driver = (nativeType: string) => getDriver("kubernetes", nativeType) as any;
const op = (nativeType: string, name: string) => driver(nativeType).operations[name] as (ctx: any, node: any, input: any) => Promise<any>;
const stsOp = (name: string) => op("k8s:StatefulSet", name);
const ctx = async (over: Record<string, unknown> = {}, ns: string[] = [NS]) => driverCtx(await sessionFor(fake, ns), over as any);
const deploy = async (nodes: any[], opts: Record<string, unknown> = {}) => {
  const { objects } = renderGraph(nodes, { environmentId: ENV_ID });
  const report = await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID, resolveSecret: async () => "generated-value-0001", ...opts });
  return { objects, report };
};
const liveSts = () => fake.get("StatefulSet", NS, "ledger") as any;

/** A cluster that can snapshot: a CSI default class and one PV per claim. */
function snapshotCluster(claims: string[], driverName = CSI): void {
  fake.seed({
    apiVersion: SNAPSHOT_API,
    kind: "VolumeSnapshotClass",
    metadata: { name: "fast", annotations: { "snapshot.storage.kubernetes.io/is-default-class": "true" } },
    driver: driverName,
    deletionPolicy: "Delete",
  });
  for (const c of claims) fake.seed({ apiVersion: "v1", kind: "PersistentVolume", metadata: { name: `pv-${c}` }, spec: { csi: { driver: CSI, volumeHandle: `handle-${c}` } } });
}

/* -------------------------------------------------------------------------- */

describe("native StatefulSet apply", () => {
  it("applies once, changes nothing on the second apply and records one revision", async () => {
    const first = await deploy([networkNode(), stsNode()]);
    expect(first.report.ok, JSON.stringify(first.report.results)).toBe(true);
    const live = liveSts();
    expect(live.spec.volumeClaimTemplates).toHaveLength(1);
    expect(live.spec.persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Retain", whenScaled: "Retain" });
    expect(live.spec.updateStrategy.rollingUpdate.partition).toBe(0);
    const second = await serverSideApply(first.objects, await sessionFor(fake, []), { environmentId: ENV_ID });
    expect(second.results.every((r) => r.status === "unchanged"), JSON.stringify(second.results)).toBe(true);
    const changes = await diff(first.objects, await sessionFor(fake, []), { environmentId: ENV_ID });
    expect(changes.every((d) => d.action === "none"), JSON.stringify(changes)).toBe(true);
    expect(fake.list("ControllerRevision", NS)).toHaveLength(1);
  });

  it("accepts a replica or image change (a new revision) because those are mutable", async () => {
    await deploy([networkNode(), stsNode()]);
    const next = await deploy([networkNode(), stsNode({ replicas: 3, image: IMAGE_B })]);
    expect(next.report.ok, JSON.stringify(next.report.results)).toBe(true);
    expect(liveSts().spec.replicas).toBe(3);
    expect(fake.list("ControllerRevision", NS)).toHaveLength(2);
  });
});

describe("immutable StatefulSet fields", () => {
  const refused = async (nodes: any[]) => {
    const before = fake.writes().length;
    const { objects } = renderGraph(nodes, { environmentId: ENV_ID });
    const report = await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID });
    expect(report.ok).toBe(false);
    expect(report.refused).toBe(true);
    // nothing in the batch was written, not even the objects that were fine
    expect(fake.writes().length).toBe(before);
    return report.results.find((r) => r.status === "error");
  };

  it("refuses a larger claim before applying anything", async () => {
    await deploy([networkNode(), stsNode()]);
    const failure = await refused([networkNode(), stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 10 }] })]);
    expect(failure?.errorCode).toBe("invalid");
    expect(failure?.message).toMatch(/volumeClaimTemplates\[data\]\.resources\.requests\.storage/);
    expect(liveSts().spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("5Gi");
  });

  it("refuses an added, removed or reclassed claim", async () => {
    await deploy([networkNode(), stsNode()]);
    const added = await refused([networkNode(), stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5 }, { name: "logs", mountPath: "/logs", sizeGb: 1 }] })]);
    expect(added?.message).toMatch(/volumeClaimTemplates\[logs\] \(added\)/);
    const classed = await refused([networkNode(), stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5, storageClass: "fast" }] })]);
    expect(classed?.message).toMatch(/storageClassName/);
    const modes = await refused([networkNode(), stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5, accessModes: ["ReadWriteOncePod"] }] })]);
    expect(modes?.message).toMatch(/accessModes/);
  });

  it("refuses a removed claim", async () => {
    await deploy([networkNode(), stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5 }, { name: "logs", mountPath: "/logs", sizeGb: 1 }] })]);
    const removed = await refused([networkNode(), stsNode()]);
    expect(removed?.message).toMatch(/volumeClaimTemplates\[logs\] \(removed\)/);
  });

  it("refuses a changed pod management policy and says what to do", async () => {
    await deploy([networkNode(), stsNode()]);
    const failure = await refused([networkNode(), stsNode({ rollout: { podManagementPolicy: "Parallel" } })]);
    expect(failure?.message).toMatch(/podManagementPolicy/);
    expect(failure?.message).toMatch(/Nothing was applied/);
  });
});

describe("evaluateRollout: staged and minReady StatefulSet rollouts", () => {
  const sts = (status: Record<string, unknown>, spec: Record<string, unknown>) => ({ metadata: { generation: 1 }, spec, status: { observedGeneration: 1, ...status } });
  const staged = (partition: number, replicas = 3) => ({ replicas, updateStrategy: { type: "RollingUpdate", rollingUpdate: { partition } } });

  it("is complete once every ordinal at or above the partition runs the update revision", () => {
    expect(evaluateRollout("StatefulSet", sts({ readyReplicas: 3, updatedReplicas: 1, currentRevision: "a", updateRevision: "b" }, staged(1))).reason).toBe("1 of 2 replicas updated");
    const done = evaluateRollout("StatefulSet", sts({ readyReplicas: 3, updatedReplicas: 2, currentRevision: "a", updateRevision: "b" }, staged(1)));
    expect(done).toMatchObject({ done: true, reason: "staged rollout complete to partition 1" });
  });

  it("treats a partition beyond the replica count as nothing to update, and partition 0 as a full rollout", () => {
    expect(evaluateRollout("StatefulSet", sts({ readyReplicas: 2, updatedReplicas: 0, currentRevision: "a", updateRevision: "b" }, staged(9, 2))).done).toBe(true);
    expect(evaluateRollout("StatefulSet", sts({ readyReplicas: 3, updatedReplicas: 3, currentRevision: "a", updateRevision: "b" }, staged(0))).reason).toMatch(/update revision/);
  });

  it("waits for availability when minReadySeconds is set", () => {
    const spec = { replicas: 3, minReadySeconds: 5 };
    expect(evaluateRollout("StatefulSet", sts({ readyReplicas: 3, updatedReplicas: 3, availableReplicas: 2, currentRevision: "a", updateRevision: "a" }, spec)).reason).toBe("2 of 3 replicas available");
    expect(evaluateRollout("StatefulSet", sts({ readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3, currentRevision: "a", updateRevision: "a" }, spec)).done).toBe(true);
  });
});

describe("StatefulSet readback", () => {
  const n = () => stsNode();
  const read = async () => {
    const c = await ctx();
    const d = driver("k8s:StatefulSet");
    const observation = await d.observe(c, n());
    const runtime = await d.runtime(c, n());
    return { observation, runtime, verify: await d.verify(c, n(), observation, runtime) };
  };

  it("reads healthy, with ordered readiness and every claim bound, and verifies every check", async () => {
    await deploy([networkNode(), n()]);
    seedClaims(fake, 2);
    fake.seedPod(ledgerPod(0, true));
    fake.seedPod(ledgerPod(1, true));
    const { observation, runtime, verify } = await read();
    expect(observation.attributes).toMatchObject({
      replicas: { state: "known", value: 2 },
      pvcRetentionWhenDeleted: { value: "Retain" },
      pvcRetentionWhenScaled: { value: "Retain" },
      podManagementPolicy: { value: "OrderedReady" },
      partition: { value: 0 },
      volumeClaims: { value: ["data:5Gi"] },
    });
    expect(runtime.health).toBe("healthy");
    expect(runtime.counts).toMatchObject({ desired: 2, ready: 2, ordinals_ready_prefix: 2, claims_expected: 2, claims_bound: 2, partition: 0 });
    expect(runtime.signals).toEqual([]);
    expect(verify.checks.filter((c: any) => c.passed !== true), JSON.stringify(verify.checks)).toEqual([]);
    expect(verify.checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(["rollout_complete", "ready", "ordered_readiness", "claims_bound"]));
    expect(verify.status).toBe("passed");
  });

  it("flags a higher ordinal that is ready while a lower one is not", async () => {
    await deploy([networkNode(), n()]);
    seedClaims(fake, 2);
    fake.seedPod(ledgerPod(0, false));
    fake.seedPod(ledgerPod(1, true));
    const { runtime, verify } = await read();
    expect(runtime.signals).toContain("ordinal_gap");
    expect(runtime.health).toBe("degraded");
    expect(verify.checks.find((c: any) => c.id === "ordered_readiness")).toMatchObject({ passed: false });
    expect(verify.status).toBe("failed");
  });

  it("does not flag the same shape under Parallel pod management", async () => {
    const parallel = stsNode({ rollout: { podManagementPolicy: "Parallel" } });
    await deploy([networkNode(), parallel]);
    seedClaims(fake, 2);
    fake.seedPod(ledgerPod(0, false));
    fake.seedPod(ledgerPod(1, true));
    const runtime = await driver("k8s:StatefulSet").runtime(await ctx(), parallel);
    expect(runtime.signals).not.toContain("ordinal_gap");
  });

  it("is degraded for a Pending claim, unhealthy for a Lost one and degraded for a missing one, even when the pods are Ready", async () => {
    await deploy([networkNode(), n()]);
    fake.seedPod(ledgerPod(0, true));
    fake.seedPod(ledgerPod(1, true));
    seedClaims(fake, 2);
    fake.setStatus("PersistentVolumeClaim", NS, "data-ledger-1", { phase: "Pending" });
    let r = (await read()).runtime;
    expect(r.signals).toContain("pvc_pending:1");
    expect(r.health).toBe("degraded");
    fake.setStatus("PersistentVolumeClaim", NS, "data-ledger-1", { phase: "Lost" });
    r = (await read()).runtime;
    expect(r.signals).toContain("pvc_lost:1");
    expect(r.health).toBe("unhealthy");
    fake.remove("PersistentVolumeClaim", NS, "data-ledger-1");
    r = (await read()).runtime;
    expect(r.signals).toContain("pvc_missing:1");
    expect(r.health).toBe("degraded");
    const { verify } = await read();
    expect(verify.checks.find((c: any) => c.id === "claims_bound")).toMatchObject({ passed: false, detail: "1 of 2 bound" });
  });

  it("reports a staged rollout, and an unconverged revision only when no partition holds it back", async () => {
    const stagedNode = stsNode({ rollout: { partition: 1 } });
    await deploy([networkNode(), stagedNode]);
    seedClaims(fake, 2);
    fake.seedPod(ledgerPod(0, true));
    fake.seedPod(ledgerPod(1, true));
    fake.setStatus("StatefulSet", NS, "ledger", { currentRevision: "old", updateRevision: "new", updatedReplicas: 1 });
    const staged = await driver("k8s:StatefulSet").runtime(await ctx(), stagedNode);
    expect(staged.signals).toContain("staged_rollout:partition_1");
    expect(staged.signals).not.toContain("revision_not_converged");
    expect(staged.counts.partition).toBe(1);

    // the same status under partition 0 is a rollout that has not converged
    const full = await deploy([networkNode(), stsNode()]);
    expect(full.report.ok, JSON.stringify(full.report.results)).toBe(true);
    fake.setStatus("StatefulSet", NS, "ledger", { currentRevision: "old", updateRevision: "new", updatedReplicas: 2 });
    const open = (await read()).runtime;
    expect(open.signals).toContain("revision_not_converged");
    expect(open.health).toBe("degraded");
  });

  it("does not claim claims for the dev-tier database, which has no claim templates", async () => {
    const db = inNs(dbNode());
    await deploy([networkNode(), dbNode()]);
    const runtime = await driver("k8s:StatefulSet").runtime(await ctx(), db);
    expect(runtime.counts.claims_expected).toBeUndefined();
    expect(runtime.signals.some((s: string) => s.startsWith("pvc_"))).toBe(false);
  });
});

describe("service.scale on a StatefulSet", () => {
  it("scales a native StatefulSet through the scale subresource", async () => {
    await deploy([networkNode(), stsNode()]);
    const r = await stsOp("service.scale")(await ctx({ operationId: "op-scale" }), stsNode(), { replicas: 3 });
    expect(r).toMatchObject({ ok: true, data: { from: 2, to: 3, alreadyApplied: false } });
    expect(liveSts().spec.replicas).toBe(3);
    expect(await stsOp("service.scale")(await ctx(), stsNode(), { replicas: 3 })).toMatchObject({ ok: true, data: { alreadyApplied: true } });
  });

  it("refuses a scale-down that would delete claims unless data loss is acknowledged", async () => {
    const risky = stsNode({ retention: { whenScaled: "Delete", acknowledgeDataLoss: true } });
    await deploy([networkNode(), risky]);
    const refused = await stsOp("service.scale")(await ctx(), risky, { replicas: 1 });
    expect(refused).toMatchObject({ ok: false, data: { code: "data_loss_unacknowledged", from: 2, to: 1 } });
    expect(liveSts().spec.replicas).toBe(2);
    expect(await stsOp("service.scale")(await ctx(), risky, { replicas: 1, acknowledgeDataLoss: true })).toMatchObject({ ok: true });
    expect(liveSts().spec.replicas).toBe(1);
    // growing never needs the acknowledgement
    expect(await stsOp("service.scale")(await ctx(), risky, { replicas: 4 })).toMatchObject({ ok: true });
  });

  it("scales down without acknowledgement when claims are retained", async () => {
    await deploy([networkNode(), stsNode()]);
    expect(await stsOp("service.scale")(await ctx(), stsNode(), { replicas: 1 })).toMatchObject({ ok: true });
  });

  it("refuses a bad replica count, a foreign object and the dev-tier database", async () => {
    await deploy([networkNode(), stsNode(), dbNode()]);
    expect(await stsOp("service.scale")(await ctx(), stsNode(), { replicas: -1 })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await stsOp("service.scale")(await ctx(), inNs(dbNode()), { replicas: 2 })).toMatchObject({ ok: false, data: { code: "unsupported" } });
    fake.foreignUpdate("StatefulSet", NS, "ledger", "someone", { metadata: { annotations: { [ANNOTATION.environment]: "env-other" } } });
    expect(await stsOp("service.scale")(await ctx(), stsNode(), { replicas: 2 })).toMatchObject({ ok: false, data: { code: "ownership_conflict" } });
  });
});

describe("deployment.rollback on a StatefulSet", () => {
  it("restores the previous revision's pod template, leaves the volumes and claims alone, and is idempotent per operation", async () => {
    await deploy([networkNode(), stsNode({ image: PINNED_IMAGE })]);
    await deploy([networkNode(), stsNode({ image: IMAGE_B })]);
    expect(liveSts().spec.template.spec.containers[0].image).toBe(IMAGE_B);
    const claimsBefore = JSON.stringify(liveSts().spec.volumeClaimTemplates);
    const r = await stsOp("deployment.rollback")(await ctx({ operationId: "op-rb" }), stsNode(), {});
    expect(r).toMatchObject({ ok: true, data: { kind: "StatefulSet", name: "ledger", status: "rolled_back", fromRevision: 2, toRevision: 1 } });
    expect(r.summary).toMatch(/reverse ordinal order/);
    expect(r.summary).toMatch(/volumes were not changed/);
    expect(liveSts().spec.template.spec.containers[0].image).toBe(PINNED_IMAGE);
    expect(JSON.stringify(liveSts().spec.volumeClaimTemplates)).toBe(claimsBefore);
    expect(liveSts().spec.replicas).toBe(2);
    expect(liveSts().metadata.annotations[ANNOTATION.lastRollback]).toBe("op-rb");
    const again = await stsOp("deployment.rollback")(await ctx({ operationId: "op-rb" }), stsNode(), {});
    expect(again).toMatchObject({ ok: true, data: { status: "already_applied" } });
    expect(liveSts().spec.template.spec.containers[0].image).toBe(PINNED_IMAGE);
  });

  it("can target an explicit revision and refuses one that is not in the history", async () => {
    await deploy([networkNode(), stsNode({ image: PINNED_IMAGE })]);
    await deploy([networkNode(), stsNode({ image: IMAGE_B })]);
    expect(await stsOp("deployment.rollback")(await ctx({ operationId: "op-x" }), stsNode(), { toRevision: 7 })).toMatchObject({ ok: false, data: { code: "rollback_unavailable" } });
    expect(await stsOp("deployment.rollback")(await ctx({ operationId: "op-y" }), stsNode(), { toRevision: 1 })).toMatchObject({ ok: true, data: { toRevision: 1 } });
  });

  it("has nothing to roll back to on a first revision", async () => {
    await deploy([networkNode(), stsNode()]);
    expect(await stsOp("deployment.rollback")(await ctx({ operationId: "op-z" }), stsNode(), {})).toMatchObject({ ok: false, data: { code: "rollback_unavailable" } });
  });

  it("refuses a foreign StatefulSet and the dev-tier database", async () => {
    await deploy([networkNode(), stsNode(), dbNode()]);
    expect(await stsOp("deployment.rollback")(await ctx(), inNs(dbNode()), {})).toMatchObject({ ok: false, data: { code: "unsupported" } });
    fake.foreignUpdate("StatefulSet", NS, "ledger", "someone", { metadata: { annotations: { [ANNOTATION.environment]: "env-other" } } });
    expect(await stsOp("deployment.rollback")(await ctx(), stsNode(), {})).toMatchObject({ ok: false, data: { code: "ownership_conflict" } });
  });
});

/* ------------------------------ volume snapshots --------------------------- */

describe("database.snapshot", () => {
  const claims = ["data-ledger-0", "data-ledger-1"];
  const setup = async () => {
    await deploy([networkNode(), stsNode()]);
    seedClaims(fake, 2);
  };
  const snapshot = async (input: Record<string, unknown> = {}, over: Record<string, unknown> = { operationId: "op-snap" }) => stsOp("database.snapshot")(await ctx(over), stsNode(), input);
  const snapshots = () => fake.list("VolumeSnapshot", NS) as any[];

  it("refuses, naming the reason and creating nothing, when the snapshot CRDs are not installed", async () => {
    await setup();
    fake.setCrds(false);
    const r = await snapshot();
    expect(r).toMatchObject({ ok: false, data: { code: "snapshots_unsupported", reasons: ["snapshot_crds_missing"] } });
    expect(r.summary).toMatch(/Nothing was copied/);
    fake.setCrds(true);
    expect(snapshots()).toEqual([]);
  });

  it("refuses when no VolumeSnapshotClass exists", async () => {
    await setup();
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "snapshots_unsupported", reasons: ["no_volumesnapshotclass"] } });
    expect(snapshots()).toEqual([]);
  });

  it("refuses all or nothing: a claim on a non-CSI volume or a driver with no class blocks every snapshot", async () => {
    await setup();
    snapshotCluster([claims[0]]);
    fake.seed({ apiVersion: "v1", kind: "PersistentVolume", metadata: { name: `pv-${claims[1]}` }, spec: { hostPath: { path: "/mnt/x" } } });
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "snapshots_unsupported", reasons: ["volume_not_csi"] } });
    expect(snapshots()).toEqual([]);
  });

  it("refuses when the claim's CSI driver has no snapshot class", async () => {
    await setup();
    snapshotCluster(claims, "other.example.com");
    // the PVs name CSI, the class belongs to another driver
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "snapshots_unsupported", reasons: ["no_snapshot_class_for_driver"] } });
  });

  it("refuses a claim that is not bound, one that is missing and one that is not Zenith's", async () => {
    await deploy([networkNode(), stsNode()]);
    snapshotCluster(claims);
    seedClaims(fake, 1, "Pending");
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "claim_not_bound", claim: claims[0] } });
    fake.setStatus("PersistentVolumeClaim", NS, claims[0], { phase: "Bound" });
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "claim_missing", claim: claims[1] } });
    fake.seed(claimOf(claims[1], "Bound", { owned: false }));
    fake.setStatus("PersistentVolumeClaim", NS, claims[1], { phase: "Bound" });
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "ownership_conflict", claim: claims[1] } });
    expect(snapshots()).toEqual([]);
  });

  it("snapshots every claim, ready, crash-consistent and not atomic, and replays without a second set", async () => {
    await setup();
    snapshotCluster(claims);
    const r = await snapshot();
    expect(r.ok, r.summary).toBe(true);
    expect(r.data).toMatchObject({ kind: "StatefulSet", name: "ledger", consistency: "crash-consistent", atomicAcrossClaims: false, allReady: true });
    expect(r.data.snapshots.map((s: any) => s.claim)).toEqual(claims);
    expect(r.data.snapshots.every((s: any) => s.readyToUse && s.volumeSnapshotClass === "fast" && s.alreadyExisted === false)).toBe(true);
    expect(snapshots()).toHaveLength(2);
    for (const s of snapshots()) {
      expect(s.metadata.labels[LABEL.managedBy]).toBe("zenith");
      expect(s.metadata.annotations).toMatchObject({ [ANNOTATION.resource]: "provider_native/ledger", [ANNOTATION.environment]: ENV_ID, "zenith.dev/operation": "op-snap" });
      expect(s.spec.volumeSnapshotClassName).toBe("fast");
    }
    const replay = await snapshot();
    expect(replay.ok).toBe(true);
    expect(replay.data.snapshots.every((s: any) => s.alreadyExisted)).toBe(true);
    expect(snapshots()).toHaveLength(2);
    const another = await snapshot({}, { operationId: "op-snap-2" });
    expect(another.data.snapshots.map((s: any) => s.name)).not.toEqual(r.data.snapshots.map((s: any) => s.name));
    expect(snapshots()).toHaveLength(4);
  });

  it("returns before readiness when asked not to wait, and says the snapshots are not ready", async () => {
    await fake.close();
    fake = await startFakeK8s({ snapshotsReady: false });
    await setup();
    snapshotCluster(claims);
    const r = await snapshot({ waitSeconds: 0 });
    expect(r.ok).toBe(true);
    expect(r.data.allReady).toBe(false);
    expect(r.summary).toMatch(/not all are ready/);
  });

  it("refuses a snapshot name collision it did not make", async () => {
    await setup();
    snapshotCluster(claims);
    const first = await snapshot();
    const name = first.data.snapshots[0].name;
    fake.remove("VolumeSnapshot", NS, name);
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot", metadata: { name, namespace: NS }, spec: { source: { persistentVolumeClaimName: "someone-elses" } } });
    expect(await snapshot()).toMatchObject({ ok: false, data: { code: "ownership_conflict", snapshot: name } });
  });

  it("honours an explicit class and refuses one that does not match the driver", async () => {
    await setup();
    snapshotCluster(claims);
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshotClass", metadata: { name: "archive" }, driver: CSI, deletionPolicy: "Retain" });
    const ok = await snapshot({ volumeSnapshotClassName: "archive" }, { operationId: "op-arch" });
    expect(ok.data.snapshots.every((s: any) => s.volumeSnapshotClass === "archive")).toBe(true);
    expect(await snapshot({ volumeSnapshotClassName: "missing" }, { operationId: "op-miss" })).toMatchObject({ ok: false, data: { code: "snapshots_unsupported" } });
  });

  it("rejects bad input and managed hosting, and snapshots a dev-tier database's claim", async () => {
    await setup();
    snapshotCluster(claims);
    expect(await snapshot({ waitSeconds: 9999 })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await snapshot({ volumeSnapshotClassName: "Not A Name!" })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await stsOp("database.snapshot")(await ctx({ provider: "zenith" }), stsNode(), {})).toMatchObject({ ok: false, data: { code: "unsupported" } });

    await deploy([networkNode(), dbNode()]);
    fake.foreignUpdate("PersistentVolumeClaim", NS, "db-data", "csi", { spec: { volumeName: "pv-db-data" } });
    fake.setStatus("PersistentVolumeClaim", NS, "db-data", { phase: "Bound" });
    fake.seed({ apiVersion: "v1", kind: "PersistentVolume", metadata: { name: "pv-db-data" }, spec: { csi: { driver: CSI, volumeHandle: "h" } } });
    const dev = await stsOp("database.snapshot")(await ctx({ operationId: "op-db" }), inNs(dbNode()), {});
    expect(dev.ok, dev.summary).toBe(true);
    expect(dev.data.snapshots.map((s: any) => s.claim)).toEqual(["db-data"]);
  });

  it("picks the default class for the driver, else the first by name", () => {
    const classes = [{ name: "b", driver: CSI, isDefault: false }, { name: "a", driver: CSI, isDefault: false }, { name: "c", driver: "x", isDefault: true }];
    expect(chooseSnapshotClass(classes, CSI)?.name).toBe("a");
    expect(chooseSnapshotClass([...classes, { name: "z", driver: CSI, isDefault: true }], CSI)?.name).toBe("z");
    expect(chooseSnapshotClass(classes, "none")).toBeUndefined();
    expect(chooseSnapshotClass(classes, CSI, "b")?.name).toBe("b");
    expect(chooseSnapshotClass(classes, CSI, "c")).toBeUndefined();
  });

  it("detects support from the cluster, not from an assumption", async () => {
    const client = createK8sClient(await sessionFor(fake, [NS]));
    expect(await detectSnapshotSupport(client)).toEqual({ available: false, classes: [], reasons: ["no_volumesnapshotclass"] });
    snapshotCluster([]);
    expect(await detectSnapshotSupport(client)).toMatchObject({ available: true, classes: [{ name: "fast", driver: CSI, isDefault: true }], reasons: [] });
    fake.setCrds(false);
    // a fresh client: API discovery is cached per client, and the point is what the cluster says now
    expect(await detectSnapshotSupport(createK8sClient(await sessionFor(fake, [NS])))).toMatchObject({ available: false, reasons: ["snapshot_crds_missing"] });
  });
});

describe("database.restore", () => {
  const claims = ["data-ledger-0", "data-ledger-1"];
  const restore = async (input: Record<string, unknown>, over: Record<string, unknown> = { operationId: "op-restore" }) => stsOp("database.restore")(await ctx(over), stsNode(), input);
  /** a deployed StatefulSet with a ready snapshot of its first claim */
  async function withSnapshot(): Promise<string> {
    await deploy([networkNode(), stsNode()]);
    seedClaims(fake, 2);
    snapshotCluster(claims);
    const snap = await stsOp("database.snapshot")(await ctx({ operationId: "op-snap" }), stsNode(), {});
    expect(snap.ok, snap.summary).toBe(true);
    return snap.data.snapshots[0].name;
  }

  it("creates a new owned claim from a ready snapshot for an ordinal that is not running", async () => {
    const snapshot = await withSnapshot();
    const r = await restore({ snapshot, ordinal: 2 });
    expect(r.ok, r.summary).toBe(true);
    expect(r.data).toMatchObject({ claim: "data-ledger-2", snapshot, namespace: NS, alreadyApplied: false, requestedStorage: "10Gi" });
    const pvc = fake.get("PersistentVolumeClaim", NS, "data-ledger-2") as any;
    expect(pvc.spec.dataSource).toEqual({ apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: snapshot });
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.metadata.labels).toMatchObject({ [LABEL.managedBy]: "zenith", [LABEL.name]: "ledger", [LABEL.partOf]: ENV_ID });
    expect(pvc.metadata.annotations).toMatchObject({ [ANNOTATION.environment]: ENV_ID, "zenith.dev/restored-from-snapshot": snapshot, "zenith.dev/operation": "op-restore" });
    expect(r.summary).toMatch(/Scale ledger up past its ordinal/);
  });

  it("replays idempotently and refuses to overwrite a claim with another operation", async () => {
    const snapshot = await withSnapshot();
    await restore({ snapshot, ordinal: 2 });
    expect(await restore({ snapshot, ordinal: 2 })).toMatchObject({ ok: true, data: { alreadyApplied: true } });
    expect(await restore({ snapshot, ordinal: 2 }, { operationId: "op-other" })).toMatchObject({ ok: false, data: { code: "claim_exists", claim: "data-ledger-2" } });
  });

  it("never replaces a running ordinal's claim", async () => {
    const snapshot = await withSnapshot();
    expect(await restore({ snapshot, ordinal: 0 })).toMatchObject({ ok: false, data: { code: "scale_down_first", ordinal: 0, replicas: 2 } });
    expect(await restore({ snapshot, ordinal: 1 })).toMatchObject({ ok: false, data: { code: "scale_down_first" } });
    expect((fake.get("PersistentVolumeClaim", NS, "data-ledger-0") as any).spec.dataSource).toBeUndefined();
  });

  it("refuses a missing, foreign or not-ready snapshot", async () => {
    await withSnapshot();
    expect(await restore({ snapshot: "no-such-snapshot", ordinal: 2 })).toMatchObject({ ok: false, data: { code: "snapshot_missing" } });
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot", metadata: { name: "foreign", namespace: NS }, spec: {}, status: { readyToUse: true } });
    expect(await restore({ snapshot: "foreign", ordinal: 2 })).toMatchObject({ ok: false, data: { code: "ownership_conflict" } });
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot", metadata: { name: "pending", namespace: NS, labels: { [LABEL.managedBy]: "zenith" }, annotations: { [ANNOTATION.environment]: ENV_ID } }, spec: {}, status: { readyToUse: false } });
    expect(await restore({ snapshot: "pending", ordinal: 2 })).toMatchObject({ ok: false, data: { code: "snapshot_not_ready" } });
    expect(fake.get("PersistentVolumeClaim", NS, "data-ledger-2")).toBeUndefined();
  });

  it("refuses when the cluster does not serve snapshots, bad input and managed hosting", async () => {
    const snapshot = await withSnapshot();
    expect(await restore({ ordinal: 2 })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await restore({ snapshot: "Bad Name", ordinal: 2 })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await restore({ snapshot, ordinal: -1 })).toMatchObject({ ok: false, data: { code: "bad_input" } });
    expect(await stsOp("database.restore")(await ctx({ provider: "zenith" }), stsNode(), { snapshot, ordinal: 2 })).toMatchObject({ ok: false, data: { code: "unsupported" } });
    fake.setCrds(false);
    expect(await restore({ snapshot, ordinal: 2 })).toMatchObject({ ok: false, data: { code: "snapshots_unsupported", reasons: ["snapshot_crds_missing"] } });
  });

  it("needs a claim template name when there are several", async () => {
    const two = stsNode({ volumeClaims: [{ name: "data", mountPath: "/data", sizeGb: 5 }, { name: "wal", mountPath: "/wal", sizeGb: 2 }] });
    await deploy([networkNode(), two]);
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot", metadata: { name: "s1", namespace: NS, labels: { [LABEL.managedBy]: "zenith" }, annotations: { [ANNOTATION.environment]: ENV_ID } }, spec: {}, status: { readyToUse: true, restoreSize: "1Gi" } });
    expect(await stsOp("database.restore")(await ctx({ operationId: "o" }), two, { snapshot: "s1", ordinal: 5 })).toMatchObject({ ok: false, data: { code: "template_required" } });
    const ok = await stsOp("database.restore")(await ctx({ operationId: "o" }), two, { snapshot: "s1", ordinal: 5, template: "wal" });
    expect(ok.data.claim).toBe("wal-ledger-5");
    // never smaller than the template asked for
    expect(ok.data.requestedStorage).toBe("2Gi");
  });

  it("snapshots and restores a plain PersistentVolumeClaim node", async () => {
    await deploy([networkNode(), volumeNode()]);
    const vol = inNs(volumeNode());
    fake.foreignUpdate("PersistentVolumeClaim", NS, "uploads", "csi", { spec: { volumeName: "pv-uploads" } });
    fake.setStatus("PersistentVolumeClaim", NS, "uploads", { phase: "Bound" });
    snapshotCluster(["uploads"]);
    const pvcOp = (name: string) => op("k8s:PersistentVolumeClaim", name);
    const snap = await pvcOp("database.snapshot")(await ctx({ operationId: "op-pvc" }), vol, {});
    expect(snap.ok, snap.summary).toBe(true);
    const name = snap.data.snapshots[0].name;
    const restored = await pvcOp("database.restore")(await ctx({ operationId: "op-pvc-r" }), vol, { snapshot: name, claim: "uploads-restored" });
    expect(restored.ok, restored.summary).toBe(true);
    expect((fake.get("PersistentVolumeClaim", NS, "uploads-restored") as any).spec).toMatchObject({ storageClassName: "fast", dataSource: { name } });
    expect(await pvcOp("database.restore")(await ctx({ operationId: "x" }), vol, { snapshot: name, claim: "uploads" })).toMatchObject({ ok: false, data: { code: "claim_exists" } });
    expect(await pvcOp("database.restore")(await ctx({ operationId: "y" }), vol, { snapshot: name })).toMatchObject({ ok: false, data: { code: "bad_input" } });
  });
});

/* --------------------------- retention and teardown ------------------------ */

describe("persistent data and environment teardown", () => {
  const teardown = async (over: Record<string, unknown> = {}) =>
    teardownKubernetesEnvironment({ workspaceId: "ws-1", environmentId: ENV_ID, session: await sessionFor(fake, []), retainStateful: true, ...over } as any);
  const deletes = () => fake.requests.filter((r) => r.method === "DELETE");
  const ownedSnapshot = (name: string) => ({
    apiVersion: SNAPSHOT_API,
    kind: "VolumeSnapshot",
    metadata: { name, namespace: NS, labels: { [LABEL.managedBy]: "zenith" }, annotations: { [ANNOTATION.environment]: ENV_ID } },
    spec: { source: { persistentVolumeClaimName: "data-ledger-0" } },
  });

  async function environment(): Promise<void> {
    await deploy([networkNode(), stsNode()]);
    seedClaims(fake, 2);
    fake.seed(ownedSnapshot("snap-1"));
    // not Zenith's: another tool's claim, another environment's claim, an unmarked snapshot
    fake.seed(claimOf("data-ledger-9", "Bound", { owned: false }));
    fake.seed(claimOf("data-ledger-8", "Bound", { env: "env-other" }));
    fake.seed({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot", metadata: { name: "foreign-snap", namespace: NS }, spec: {} });
  }

  it("retains the StatefulSet, its claims and its snapshots while stateful data is retained", async () => {
    await environment();
    const report = await teardown({ retainStateful: true });
    expect(report.deleted).toEqual([`NetworkPolicy/${NS}/zenith-default-deny-ingress`, `Service/${NS}/ledger`]);
    expect(report.retained).toEqual([
      `Namespace//${NS}`,
      `PersistentVolumeClaim/${NS}/data-ledger-0`,
      `PersistentVolumeClaim/${NS}/data-ledger-1`,
      `StatefulSet/${NS}/ledger`,
      `VolumeSnapshot/${NS}/snap-1`,
    ]);
    expect(report.skipped).toEqual([]);
    expect(report.uncertain).toEqual([]);
    expect(fake.get("StatefulSet", NS, "ledger")).toBeDefined();
    expect(fake.get("PersistentVolumeClaim", NS, "data-ledger-0")).toBeDefined();
    expect(fake.list("VolumeSnapshot", NS)).toHaveLength(2);
  });

  it("deletes the StatefulSet, then its claims, and its snapshots first, only when stateful deletion is allowed", async () => {
    await environment();
    const report = await teardown({ retainStateful: false });
    expect(report.deleted).toEqual([
      `NetworkPolicy/${NS}/zenith-default-deny-ingress`,
      `PersistentVolumeClaim/${NS}/data-ledger-0`,
      `PersistentVolumeClaim/${NS}/data-ledger-1`,
      `Service/${NS}/ledger`,
      `StatefulSet/${NS}/ledger`,
      `VolumeSnapshot/${NS}/snap-1`,
    ]);
    expect(report.retained).toEqual([`Namespace//${NS}`]);
    expect(report.uncertain).toEqual([]);
    const order = deletes().map((r) => r.path.split("/").at(-2));
    expect(order[0]).toBe("volumesnapshots");
    expect(order.indexOf("statefulsets")).toBeLessThan(order.indexOf("persistentvolumeclaims"));
    expect(deletes().every((r) => typeof r.body?.preconditions?.uid === "string")).toBe(true);
  });

  it("never touches a claim or snapshot it does not own, and does not report them", async () => {
    await environment();
    const report = await teardown({ retainStateful: false });
    for (const name of ["data-ledger-9", "data-ledger-8"]) {
      expect(fake.get("PersistentVolumeClaim", NS, name), name).toBeDefined();
      expect(JSON.stringify(report)).not.toContain(name);
    }
    expect(fake.get("VolumeSnapshot", NS, "foreign-snap")).toBeDefined();
    expect(JSON.stringify(report)).not.toContain("foreign-snap");
  });

  it("writes nothing in a dry run, in either mode", async () => {
    await environment();
    const before = fake.writes().length;
    for (const retainStateful of [true, false]) {
      const report = await teardown({ retainStateful, dryRun: true });
      expect(report.uncertain).toEqual([]);
    }
    expect(fake.writes().length).toBe(before);
  });

  it("treats a cluster without the snapshot CRDs as having no snapshots, not as a coverage gap", async () => {
    await deploy([networkNode(), stsNode()]);
    seedClaims(fake, 2);
    fake.setCrds(false);
    const report = await teardown({ retainStateful: true });
    expect(report.uncertain).toEqual([]);
    expect(report.skipped.some((r) => r.startsWith("VolumeSnapshot/"))).toBe(false);
    // the existing behaviour for cert-manager style kinds is unchanged
    expect(report.skipped).toContain(`Certificate/${NS}/*`);
    expect(report.retained).toContain(`PersistentVolumeClaim/${NS}/data-ledger-0`);
  });

  it("retains snapshots in a dry run for retained data, and plans them for deletion otherwise", async () => {
    await environment();
    expect((await teardown({ retainStateful: true, dryRun: true })).retained).toContain(`VolumeSnapshot/${NS}/snap-1`);
    const plan = await teardown({ retainStateful: false, dryRun: true });
    expect(plan.deleted).toContain(`VolumeSnapshot/${NS}/snap-1`);
    expect(plan.deleted).toContain(`PersistentVolumeClaim/${NS}/data-ledger-1`);
  });
});

/* ---------------------------------- CronJob -------------------------------- */

describe("CronJob readback", () => {
  const cron = () => nativeCronNode({ concurrencyPolicy: "Forbid", successfulJobsHistoryLimit: 2, failedJobsHistoryLimit: 2 });
  const read = async (n = cron()) => {
    const c = await ctx();
    const d = driver("k8s:CronJob");
    const observation = await d.observe(c, n);
    const runtime = await d.runtime(c, n);
    return { observation, runtime, verify: await d.verify(c, n, observation, runtime) };
  };
  const job = (name: string, conditions: Record<string, unknown>[], created: string) => {
    const uid = (fake.get("CronJob", NS, "sweeper") as any).metadata.uid;
    fake.seed({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name,
        namespace: NS,
        creationTimestamp: created,
        labels: { [LABEL.name]: "sweeper", [LABEL.partOf]: ENV_ID, [LABEL.managedBy]: "zenith" },
        ownerReferences: [{ apiVersion: "batch/v1", kind: "CronJob", name: "sweeper", uid, controller: true }],
      },
      spec: {},
      status: { conditions },
    });
  };

  it("observes the policy it rendered and verifies without judging a run that has not happened", async () => {
    await deploy([networkNode(), cron()]);
    const { observation, runtime, verify } = await read();
    expect(observation.attributes).toMatchObject({ concurrencyPolicy: { value: "Forbid" }, successfulJobsHistoryLimit: { value: 2 }, failedJobsHistoryLimit: { value: 2 }, suspend: { value: false } });
    expect(runtime).toMatchObject({ health: "unknown", signals: ["never_scheduled"] });
    expect(verify.checks.map((c: any) => c.id)).not.toContain("last_run");
    expect(verify.status).toBe("passed");
  });

  it("is healthy when the latest finished Job succeeded, and says the earlier failure did not matter", async () => {
    await deploy([networkNode(), cron()]);
    fake.setStatus("CronJob", NS, "sweeper", { lastScheduleTime: "2026-09-30T12:00:00Z", lastSuccessfulTime: "2026-09-30T12:00:30Z" });
    job("sweeper-1", [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }], "2026-09-30T11:00:00Z");
    job("sweeper-2", [{ type: "Complete", status: "True" }], "2026-09-30T12:00:00Z");
    const { runtime, verify } = await read();
    expect(runtime.health).toBe("healthy");
    expect(runtime.counts).toMatchObject({ jobs: 2, jobs_succeeded: 1, jobs_failed: 1, jobs_running: 0 });
    expect(verify.checks.find((c: any) => c.id === "last_run")).toMatchObject({ passed: true });
  });

  it("is unhealthy, with a whitelisted reason, when the latest finished Job failed", async () => {
    await deploy([networkNode(), cron()]);
    fake.setStatus("CronJob", NS, "sweeper", { lastScheduleTime: "2026-09-30T12:00:00Z" });
    job("sweeper-1", [{ type: "Complete", status: "True" }], "2026-09-30T11:00:00Z");
    job("sweeper-2", [{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "free text the cluster chose" }], "2026-09-30T12:00:00Z");
    const { runtime, verify } = await read();
    expect(runtime.health).toBe("unhealthy");
    expect(runtime.signals).toEqual(expect.arrayContaining(["last_run_failed", "job_deadline_exceeded"]));
    expect(JSON.stringify(runtime)).not.toContain("free text");
    expect(verify.checks.find((c: any) => c.id === "last_run")).toMatchObject({ passed: false });
    expect(verify.status).toBe("failed");
  });

  it("stays unknown while the first run is still going, and ignores Jobs it does not own", async () => {
    await deploy([networkNode(), cron()]);
    fake.setStatus("CronJob", NS, "sweeper", { lastScheduleTime: "2026-09-30T12:00:00Z" });
    job("sweeper-1", [], "2026-09-30T12:00:00Z");
    fake.seed({ apiVersion: "batch/v1", kind: "Job", metadata: { name: "stranger", namespace: NS, labels: { [LABEL.name]: "sweeper", [LABEL.partOf]: ENV_ID }, ownerReferences: [{ kind: "CronJob", name: "other", uid: "u" }] }, spec: {}, status: { conditions: [{ type: "Failed", status: "True" }] } });
    const { runtime } = await read();
    expect(runtime.health).toBe("unknown");
    expect(runtime.signals).toContain("first_run_in_progress");
    expect(runtime.counts).toMatchObject({ jobs: 1, jobs_running: 1, jobs_failed: 0 });
  });

  it("falls back to the CronJob's own last success when history limit 0 removed the Jobs", async () => {
    const none = nativeCronNode({ successfulJobsHistoryLimit: 0, failedJobsHistoryLimit: 0 });
    await deploy([networkNode(), none]);
    fake.setStatus("CronJob", NS, "sweeper", { lastScheduleTime: "2026-09-30T12:00:00Z", lastSuccessfulTime: "2026-09-30T12:00:05Z" });
    expect((await read(none)).runtime.health).toBe("healthy");
  });

  it("flags a suspended CronJob", async () => {
    const paused = nativeCronNode({ suspend: true });
    await deploy([networkNode(), paused]);
    const { runtime, observation } = await read(paused);
    expect(runtime.signals).toContain("suspended");
    expect(observation.attributes.suspend).toMatchObject({ value: true });
  });

  it("observes and verifies a portable job with an explicit policy", async () => {
    const portable = inNs(cronNode({ cronPolicy: { concurrencyPolicy: "Replace", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 6 } }));
    await deploy([networkNode(), cronNode({ cronPolicy: { concurrencyPolicy: "Replace", successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 6 } })]);
    const c = await ctx();
    const d = driver("k8s:CronJob");
    const obs = await d.observe(c, portable);
    expect(obs.attributes).toMatchObject({ concurrencyPolicy: { value: "Replace" }, failedJobsHistoryLimit: { value: 6 } });
    expect((await d.verify(c, portable, obs, await d.runtime(c, portable))).checks.find((x: any) => x.id === "configuration")).toMatchObject({ passed: true });
  });
});

/* ------------------------------ NetworkPolicy engine ------------------------ */

describe("NetworkPolicy engine detection", () => {
  const daemonSet = (name: string, namespace: string, containers: string[] = [name]) => ({
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name, namespace },
    spec: { template: { spec: { containers: containers.map((c) => ({ name: c, image: "x" })) } } },
  });
  const read = async (namespaces: string[]) => detectPolicyEngine(createK8sClient(await sessionFor(fake, namespaces)));

  it("recognises engines that implement NetworkPolicy", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system" } });
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "calico-system" } });
    fake.seed(daemonSet("calico-node", "calico-system"));
    expect(await read(["kube-system", "calico-system"])).toEqual({ enforcing: true, engine: "calico", evidence: ["calico-node"], readable: true });
    fake.seed(daemonSet("cilium", "kube-system"));
    expect(await read(["kube-system", "calico-system"])).toMatchObject({ enforcing: true, engine: "calico+cilium", evidence: ["calico-node", "cilium"] });
  });

  it("does not call a plugin enforcing because its agent exists: the EKS VPC CNI needs its policy container", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system" } });
    fake.seed(daemonSet("aws-node", "kube-system", ["aws-node"]));
    expect(await read(["kube-system"])).toEqual({ enforcing: false, evidence: [], readable: true });
    fake.remove("DaemonSet", "kube-system", "aws-node");
    fake.seed(daemonSet("aws-node", "kube-system", ["aws-node", "aws-eks-nodeagent"]));
    expect(await read(["kube-system"])).toMatchObject({ enforcing: true, engine: "aws-vpc-cni-network-policy" });
  });

  it("never says not-enforcing for an unrecognised plugin, and reports unreadable outside the session's namespaces", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system" } });
    fake.seed(daemonSet("kindnet", "kube-system"));
    expect(await read(["kube-system"])).toEqual({ enforcing: false, evidence: [], readable: true });
    expect(await read([NS])).toEqual({ enforcing: false, evidence: [], readable: false });
  });

  it("surfaces the reading through the NetworkPolicy driver's runtime and verify", async () => {
    const fw = firewallToDb();
    const nodes = [networkNode(), serviceNode(), dbNode(), fw];
    const { objects } = renderGraph(nodes, { environmentId: ENV_ID });
    await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID, resolveSecret: async () => "v" });
    const d = driver("k8s:NetworkPolicy");
    const node = inNs(fw);
    const unread = await d.runtime(await ctx(), node);
    expect(unread).toMatchObject({ health: "unknown", signals: ["cni_unreadable"], counts: { enforcing: 0, ingress_rules: 1 } });
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system" } });
    const unverified = await d.runtime(await ctx({}, [NS, "kube-system"]), node);
    expect(unverified).toMatchObject({ health: "unknown", signals: ["enforcement_unverified"] });
    fake.seed(daemonSet("calico-node", "kube-system"));
    const c = await ctx({}, [NS, "kube-system"]);
    const runtime = await d.runtime(c, node);
    expect(runtime).toMatchObject({ health: "healthy", signals: ["engine:calico"], counts: { enforcing: 1 } });
    const obs = await d.observe(c, node);
    const verify = await d.verify(c, node, obs, runtime);
    expect(verify.checks.find((x: any) => x.id === "enforcing_cni")).toMatchObject({ passed: true, detail: "calico" });
    expect(verify.status).toBe("passed");
  });
});

/* ------------------- an unserved kind is only absent if discovery says so ------------------- */

describe("discovery of unserved kinds", () => {
  const teardown = async () =>
    teardownKubernetesEnvironment({ workspaceId: "ws-1", environmentId: ENV_ID, session: await sessionFor(fake, []), retainStateful: true } as any);
  const kindAbsent = async (apiVersion: string, kind: string) => createK8sClient(await sessionFor(fake, [NS])).objects.kindAbsent(apiVersion, kind);

  it("answers true only when the group is not served, and false when the kind is served", async () => {
    expect(await kindAbsent("cert-manager.io/v1", "Certificate")).toBe(false);
    fake.setCrds(false);
    expect(await kindAbsent("cert-manager.io/v1", "Certificate")).toBe(true);
    // a served group that lacks the kind is absent too (partial discovery that is positive about the kind)
    expect(await kindAbsent("apps/v1", "NoSuchKind")).toBe(true);
    expect(await kindAbsent("apps/v1", "StatefulSet")).toBe(false);
  });

  it("throws, rather than answering, when discovery fails: a 500, a 403 or a dead connection", async () => {
    fake.setCrds(false);
    for (const status of [500, 403]) {
      fake.clearInjections();
      fake.inject({ match: (r) => r.method === "GET" && r.path === "/apis/cert-manager.io/v1", status, message: "denied" });
      await expect(kindAbsent("cert-manager.io/v1", "Certificate"), String(status)).rejects.toBeDefined();
    }
    fake.clearInjections();
    await fake.close();
    await expect(createK8sClient(await sessionFor(fake, [NS])).objects.kindAbsent("cert-manager.io/v1", "Certificate")).rejects.toBeDefined();
    fake = await startFakeK8s({ snapshotsReady: true });
  });

  it("reports a confirmed-unserved kind as skipped, and a kind whose discovery fails as uncertain", async () => {
    await deploy([networkNode(), stsNode()]);
    fake.setCrds(false);
    const confirmed = await teardown();
    expect(confirmed.skipped).toEqual(expect.arrayContaining([`Certificate/${NS}/*`, `DNSEndpoint/${NS}/*`, `HTTPRoute/${NS}/*`]));
    expect(confirmed.uncertain).toEqual([]);

    const real = RawObjectApi.prototype.kindAbsent;
    vi.spyOn(RawObjectApi.prototype, "kindAbsent").mockImplementation(async function (this: RawObjectApi, apiVersion: string, kind: string) {
      if (kind === "Certificate" || kind === "VolumeSnapshot") throw new Error("discovery timed out");
      return real.call(this, apiVersion, kind);
    });
    const unknown = await teardown();
    expect(unknown.uncertain).toEqual(expect.arrayContaining([`Certificate/${NS}/*`, `VolumeSnapshot/${NS}/*`]));
    expect(unknown.skipped).not.toContain(`Certificate/${NS}/*`);
    // the kinds whose discovery did answer are still plain coverage notes
    expect(unknown.skipped).toEqual(expect.arrayContaining([`DNSEndpoint/${NS}/*`, `HTTPRoute/${NS}/*`]));
  });
});
