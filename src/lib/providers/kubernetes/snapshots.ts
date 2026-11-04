/**
 * Persistent-data protection on Kubernetes: CSI volume snapshots and restores.
 *
 *   `database.snapshot`  one VolumeSnapshot per PersistentVolumeClaim of the
 *                        target (a StatefulSet's claims, or one PVC)
 *   `database.restore`   a NEW PersistentVolumeClaim whose dataSource is a
 *                        Zenith-owned, ready VolumeSnapshot
 *
 * These reuse the catalog's data capabilities, so approval, grants and the
 * operation ledger are the ones every other data operation already has. They
 * are driver operations on the StatefulSet and PersistentVolumeClaim drivers.
 *
 * What is claimed, and what is not:
 *   - Support is a property of the cluster, so it is read, not assumed. A
 *     snapshot is attempted only when the external-snapshotter CRDs are served,
 *     the claim is Bound to a CSI volume, and a VolumeSnapshotClass exists for
 *     that volume's CSI driver. Otherwise the operation REFUSES with
 *     `snapshots_unsupported` and says which of those was missing. Nothing falls
 *     back to copying files, exec-ing a dump or any other mover.
 *   - A snapshot is crash-consistent. Nothing quiesces the application, and the
 *     snapshots of a multi-claim target are taken one after another, not
 *     atomically. For an application-consistent copy use the database's own
 *     backup tooling; that is outside this operation.
 *   - Restore never overwrites. It creates a claim that must not exist yet, so
 *     a restore into a live StatefulSet means scaling it below the ordinal and
 *     deleting the old retained claim deliberately first. Zenith does that for
 *     nobody, and `database.restore` refuses a claim that exists.
 *   - Only objects carrying THIS environment's ownership marks are read as
 *     sources or snapshots. A foreign claim or snapshot is never copied.
 *   - VolumeSnapshots are data. Environment teardown retains them while stateful
 *     data is retained and deletes only owned ones otherwise (`teardown.ts`).
 *
 * Honest limit: exercised against the fake API server (contract) and, when the
 * acceptance harness runs on a cluster with a snapshot-capable CSI driver,
 * against a real one. A kind cluster has no CSI snapshotter; there the
 * acceptance asserts the refusal, which is the supported behaviour.
 */
import { createHash } from "node:crypto";
import type { DriverContext, NativeOperationResult } from "@/lib/drivers/types";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { SNAPSHOT_KINDS, listByKind, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import { loadOwned } from "./ops";
import { serverSideApply } from "./apply";
import { isDnsLabel, labelValue } from "./naming";
import { ANNOTATION, K8sError, LABEL, MANAGED_BY_VALUE, OPS_FIELD_MANAGER, type K8sObject, type SupportedKind } from "./types";
import { dig, isRecord, plain, redactText, truncate } from "./util";

type Ctx = DriverContext<KubernetesSession>;

export const SNAPSHOT_ANNOTATION = {
  sourceClaim: "zenith.dev/source-pvc",
  operation: "zenith.dev/operation",
  restoredFrom: "zenith.dev/restored-from-snapshot",
} as const;

const MAX_CLAIMS = 20;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const POLL_MS = 2000;

const SNAPSHOT_API_GROUP = "snapshot.storage.k8s.io";

/* ------------------------------- cluster support ------------------------------ */

export interface SnapshotClassInfo {
  name: string;
  driver: string;
  isDefault: boolean;
}

export interface SnapshotSupport {
  /** the CRDs are served and at least one class exists */
  available: boolean;
  classes: SnapshotClassInfo[];
  /** stable reason codes for what is missing */
  reasons: string[];
}

const DEFAULT_CLASS_ANNOTATION = "snapshot.storage.kubernetes.io/is-default-class";

/** Read what the cluster can snapshot with. Never creates anything. */
export async function detectSnapshotSupport(client: K8sClient): Promise<SnapshotSupport> {
  const listing = await listByKind(client, SNAPSHOT_KINDS.VolumeSnapshotClass, undefined, { limit: 100, maxPages: 1 });
  if (listing.unavailable) return { available: false, classes: [], reasons: ["snapshot_crds_missing"] };
  const classes = listing.items
    .map((c): SnapshotClassInfo | undefined => {
      const name = dig(c, "metadata", "name");
      const driver = c.driver;
      if (typeof name !== "string" || typeof driver !== "string") return undefined;
      return { name, driver, isDefault: dig(c, "metadata", "annotations", DEFAULT_CLASS_ANNOTATION) === "true" };
    })
    .filter((c): c is SnapshotClassInfo => c !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (classes.length === 0) return { available: false, classes, reasons: ["no_volumesnapshotclass"] };
  return { available: true, classes, reasons: [] };
}

/** The class for a CSI driver: an explicit, matching request; else the default for that driver; else the first by name. */
export function chooseSnapshotClass(classes: readonly SnapshotClassInfo[], csiDriver: string, requested?: string): SnapshotClassInfo | undefined {
  const matching = classes.filter((c) => c.driver === csiDriver).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (requested !== undefined) return matching.find((c) => c.name === requested);
  return matching.find((c) => c.isDefault) ?? matching[0];
}

/* --------------------------------- helpers ------------------------------------ */

const refuse = (summary: string, code: string, data: Record<string, unknown> = {}): NativeOperationResult => ({ ok: false, summary, data: { code, ...data }, simulated: false });

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new K8sError("aborted", "The operation was aborted."));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new K8sError("aborted", "The operation was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function failure(summary: string, e: unknown): NativeOperationResult {
  const err = toK8sError(e);
  return { ok: false, summary: `${summary}: ${err.message}`, data: { code: err.code }, simulated: false };
}

const snapshotName = (opId: string, claim: string): string => `zsnap-${createHash("sha256").update(`${opId}\0${claim}`).digest("hex").slice(0, 16)}`;

function intInput(v: unknown, def: number, min: number, max: number, label: string): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new K8sError("bad_input", `${label} must be an integer between ${min} and ${max}.`);
  return v;
}

/** The PVC names a snapshot target stands for: a PVC itself, or every claim of a StatefulSet. */
export function claimsOf(kind: SupportedKind, live: Record<string, unknown>): string[] {
  if (kind === "PersistentVolumeClaim") return [String(dig(live, "metadata", "name"))];
  const name = String(dig(live, "metadata", "name"));
  const out = new Set<string>();
  const volumes = dig(live, "spec", "template", "spec", "volumes");
  if (Array.isArray(volumes)) {
    for (const v of volumes) {
      const claim = dig(v, "persistentVolumeClaim", "claimName");
      if (typeof claim === "string") out.add(claim);
    }
  }
  const replicasRaw = dig(live, "spec", "replicas");
  const replicas = typeof replicasRaw === "number" ? replicasRaw : 1;
  const templates = dig(live, "spec", "volumeClaimTemplates");
  if (Array.isArray(templates)) {
    for (const t of templates) {
      const tn = dig(t, "metadata", "name");
      if (typeof tn !== "string") continue;
      for (let i = 0; i < replicas; i++) out.add(`${tn}-${name}-${i}`);
    }
  }
  return [...out].sort();
}

/** Managed (zenith) hosting wraps these drivers; a tenant session cannot read cluster-scoped snapshot classes or volumes, and the managed platform offers no snapshots. */
const customerCluster = (ctx: Ctx): boolean => ctx.provider === "kubernetes";

function targetKind(node: ResourceNode): SupportedKind | undefined {
  if (node.nativeType === "k8s:StatefulSet") return "StatefulSet";
  if (node.nativeType === "k8s:PersistentVolumeClaim") return "PersistentVolumeClaim";
  return undefined;
}

/* --------------------------------- snapshot ----------------------------------- */

interface SnapshotOutcome {
  name: string;
  claim: string;
  class: string;
  readyToUse: boolean;
  alreadyExisted: boolean;
  error?: string;
}

async function pollReady(client: K8sClient, namespace: string, name: string, waitMs: number, signal: AbortSignal): Promise<{ ready: boolean; error?: string }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const live = await readObject(client, { apiVersion: SNAPSHOT_KINDS.VolumeSnapshot.apiVersion, kind: "VolumeSnapshot", namespace, name });
    const ready = dig(live, "status", "readyToUse") === true;
    const err = dig(live, "status", "error", "message");
    if (ready) return { ready: true };
    // A reported error can be transient (the controller retries), but it is the honest answer once the wait is over.
    if (Date.now() >= deadline) return { ready: false, ...(typeof err === "string" ? { error: truncate(redactText(err), 200) } : {}) };
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
  }
}

/**
 * `database.snapshot`. Idempotent per operation id: the snapshot names derive
 * from the operation and the claim, so a replay finds the snapshots it already
 * made instead of making a second set.
 */
export async function snapshotData(ctx: Ctx, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  const kind = targetKind(node);
  if (!kind) return refuse(`database.snapshot does not apply to ${node.nativeType}.`, "unsupported");
  if (!customerCluster(ctx)) return refuse("Managed hosting does not offer volume snapshots.", "unsupported");
  try {
    if (input.volumeSnapshotClassName !== undefined && (typeof input.volumeSnapshotClassName !== "string" || !isDnsLabel(input.volumeSnapshotClassName.replace(/\./g, "-")))) {
      throw new K8sError("bad_input", "volumeSnapshotClassName must be a Kubernetes name.");
    }
    const waitSeconds = intInput(input.waitSeconds, DEFAULT_WAIT_SECONDS, 0, MAX_WAIT_SECONDS, "waitSeconds");
    const { client, ref, live } = await loadOwned(ctx, node, kind);
    const namespace = ref.namespace as string;
    const claims = claimsOf(kind, live);
    if (claims.length === 0) return refuse(`${kind} ${ref.name} has no persistent volume claims to snapshot.`, "no_claims");
    if (claims.length > MAX_CLAIMS) return refuse(`${kind} ${ref.name} has ${claims.length} claims; at most ${MAX_CLAIMS} are snapshotted in one operation.`, "too_many_claims");

    const support = await detectSnapshotSupport(client);
    if (!support.available) return refuse(`This cluster cannot take volume snapshots (${support.reasons.join(", ")}). Install the CSI snapshot controller and a VolumeSnapshotClass for the storage driver. Nothing was copied.`, "snapshots_unsupported", { reasons: support.reasons });

    const opId = ctx.operationId ?? `ts-${ctx.now().toISOString()}`;
    // Resolve every claim BEFORE creating anything: either every claim can be snapshotted or none is.
    const plan: { claim: string; className: string }[] = [];
    const reasons = new Set<string>();
    for (const claim of claims) {
      const pvc = await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace, name: claim });
      if (!pvc) return refuse(`Claim ${claim} does not exist; nothing was snapshotted.`, "claim_missing", { claim });
      if (!ownedBy(pvc, ctx.environmentId).owned) return refuse(`Claim ${claim} is not managed by Zenith for this environment; it is never snapshotted.`, "ownership_conflict", { claim });
      if (dig(pvc, "status", "phase") !== "Bound") return refuse(`Claim ${claim} is not Bound; nothing was snapshotted.`, "claim_not_bound", { claim });
      const pvName = dig(pvc, "spec", "volumeName");
      if (typeof pvName !== "string") return refuse(`Claim ${claim} names no volume; nothing was snapshotted.`, "claim_not_bound", { claim });
      const pv = await readObject(client, { apiVersion: "v1", kind: "PersistentVolume", name: pvName });
      const csi = dig(pv, "spec", "csi", "driver");
      if (typeof csi !== "string") {
        reasons.add("volume_not_csi");
        continue;
      }
      const picked = chooseSnapshotClass(support.classes, csi, input.volumeSnapshotClassName as string | undefined);
      if (!picked) {
        reasons.add("no_snapshot_class_for_driver");
        continue;
      }
      plan.push({ claim, className: picked.name });
    }
    if (reasons.size > 0 || plan.length !== claims.length) {
      return refuse(`Not every claim of ${kind} ${ref.name} can be snapshotted (${[...reasons].join(", ") || "unresolved"}). Nothing was snapshotted.`, "snapshots_unsupported", { reasons: [...reasons].sort() });
    }

    const outcomes: SnapshotOutcome[] = [];
    for (const item of plan) {
      const name = snapshotName(opId, item.claim);
      const wanted: K8sObject = {
        apiVersion: SNAPSHOT_KINDS.VolumeSnapshot.apiVersion,
        kind: "VolumeSnapshot",
        metadata: {
          name,
          namespace,
          labels: { [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.partOf]: labelValue(ctx.environmentId) },
          annotations: {
            [ANNOTATION.resource]: node.address,
            [ANNOTATION.environment]: ctx.environmentId,
            [SNAPSHOT_ANNOTATION.sourceClaim]: item.claim,
            [SNAPSHOT_ANNOTATION.operation]: opId,
          },
        },
        spec: { volumeSnapshotClassName: item.className, source: { persistentVolumeClaimName: item.claim } },
      };
      let existed = false;
      const found = await readObject(client, { apiVersion: wanted.apiVersion, kind: "VolumeSnapshot", namespace, name });
      if (found) {
        // A replay: the snapshot must be ours and for this claim, or the name collision is refused.
        if (!ownedBy(found, ctx.environmentId).owned || dig(found, "spec", "source", "persistentVolumeClaimName") !== item.claim) {
          return refuse(`VolumeSnapshot ${name} exists but is not this operation's snapshot of ${item.claim}; refusing to reuse it.`, "ownership_conflict", { snapshot: name });
        }
        existed = true;
      } else {
        if (ctx.signal.aborted) throw new K8sError("aborted", "The operation was aborted.");
        await client.objects.create(plain<K8sObject>(wanted) as never, undefined, undefined, OPS_FIELD_MANAGER);
      }
      const waited = waitSeconds > 0 ? await pollReady(client, namespace, name, waitSeconds * 1000, ctx.signal) : { ready: false };
      outcomes.push({ name, claim: item.claim, class: item.className, readyToUse: waited.ready, alreadyExisted: existed, ...("error" in waited && waited.error ? { error: waited.error } : {}) });
    }
    const allReady = outcomes.every((o) => o.readyToUse);
    return {
      ok: true,
      summary: allReady
        ? `Snapshotted ${outcomes.length} claim(s) of ${kind} ${ref.name}; every snapshot is ready.`
        : `Requested ${outcomes.length} snapshot(s) of ${kind} ${ref.name}; not all are ready yet. Check readyToUse before relying on them.`,
      data: {
        kind,
        name: ref.name,
        namespace,
        consistency: "crash-consistent",
        atomicAcrossClaims: false,
        allReady,
        snapshots: outcomes.map((o) => ({ name: o.name, claim: o.claim, volumeSnapshotClass: o.class, readyToUse: o.readyToUse, alreadyExisted: o.alreadyExisted, ...(o.error ? { error: o.error } : {}) })),
      },
      simulated: false,
    };
  } catch (e) {
    return failure("Snapshot failed", e);
  }
}

/* ---------------------------------- restore ----------------------------------- */

function templateFor(live: Record<string, unknown>, template: string | undefined): Record<string, unknown> | undefined {
  const templates = dig(live, "spec", "volumeClaimTemplates");
  if (!Array.isArray(templates)) return undefined;
  const list = templates.filter(isRecord);
  if (template === undefined) return list.length === 1 ? list[0] : undefined;
  return list.find((t) => dig(t, "metadata", "name") === template);
}

const quantityGi = (q: unknown): number | undefined => {
  if (typeof q !== "string") return undefined;
  const m = /^(\d+)(Gi|Mi|Ti)?$/.exec(q);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === "Ti") return n * 1024;
  if (m[2] === "Mi") return Math.ceil(n / 1024);
  return n;
};

/**
 * `database.restore`: create the claim a StatefulSet ordinal (or a PVC node)
 * needs, populated from a ready, Zenith-owned VolumeSnapshot. It never
 * overwrites and never touches a pod. Input:
 *   snapshot   name of the VolumeSnapshot (required)
 *   ordinal    StatefulSet only: which ordinal's claim to create (default 0)
 *   template   StatefulSet only: which claim template (required if several)
 *   claim      PVC nodes only: name of the new claim
 */
export async function restoreData(ctx: Ctx, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  const kind = targetKind(node);
  if (!kind) return refuse(`database.restore does not apply to ${node.nativeType}.`, "unsupported");
  if (!customerCluster(ctx)) return refuse("Managed hosting does not offer volume restores.", "unsupported");
  try {
    const snapshot = input.snapshot;
    if (typeof snapshot !== "string" || !isDnsLabel(snapshot)) throw new K8sError("bad_input", "snapshot must be the name of a VolumeSnapshot.");
    const { client, ref, live } = await loadOwned(ctx, node, kind);
    const namespace = ref.namespace as string;
    const opId = ctx.operationId ?? `ts-${ctx.now().toISOString()}`;

    let claim: string;
    let accessModes: unknown = ["ReadWriteOnce"];
    let storageClassName: unknown;
    let storage: unknown = "1Gi";
    let labels: Record<string, string> = { [LABEL.managedBy]: MANAGED_BY_VALUE };
    let sourceLabelsFromSts: Record<string, unknown> = {};
    if (kind === "StatefulSet") {
      const ordinal = intInput(input.ordinal, 0, 0, 1000, "ordinal");
      const template = input.template === undefined ? undefined : String(input.template);
      const t = templateFor(live, template);
      if (!t) return refuse(`StatefulSet ${ref.name} has no single claim template to restore into; name one with "template".`, "template_required");
      const replicasRaw = dig(live, "spec", "replicas");
      const replicas = typeof replicasRaw === "number" ? replicasRaw : 1;
      if (ordinal < replicas) return refuse(`Ordinal ${ordinal} is running or scheduled (replicas is ${replicas}). Scale the StatefulSet below ${ordinal} and remove its old claim deliberately first; Zenith never replaces a live claim.`, "scale_down_first", { ordinal, replicas });
      claim = `${String(dig(t, "metadata", "name"))}-${ref.name}-${ordinal}`;
      accessModes = dig(t, "spec", "accessModes") ?? accessModes;
      storageClassName = dig(t, "spec", "storageClassName");
      storage = dig(t, "spec", "resources", "requests", "storage") ?? storage;
      sourceLabelsFromSts = isRecord(dig(live, "spec", "selector", "matchLabels")) ? (dig(live, "spec", "selector", "matchLabels") as Record<string, unknown>) : {};
      const tl = dig(t, "metadata", "labels");
      if (isRecord(tl)) labels = { ...labels, ...(Object.fromEntries(Object.entries(tl).filter(([, v]) => typeof v === "string")) as Record<string, string>) };
    } else {
      if (typeof input.claim !== "string" || !isDnsLabel(input.claim)) throw new K8sError("bad_input", "claim must be a Kubernetes name for the new claim.");
      claim = input.claim;
      accessModes = dig(live, "spec", "accessModes") ?? accessModes;
      storageClassName = dig(live, "spec", "storageClassName");
      storage = dig(live, "spec", "resources", "requests", "storage") ?? storage;
      const pl = dig(live, "metadata", "labels");
      if (isRecord(pl)) labels = { ...labels, ...(Object.fromEntries(Object.entries(pl).filter(([, v]) => typeof v === "string")) as Record<string, string>) };
    }
    for (const [k, v] of Object.entries(sourceLabelsFromSts)) if (typeof v === "string") labels[k] = v;

    const snap = await readObject(client, { apiVersion: SNAPSHOT_KINDS.VolumeSnapshot.apiVersion, kind: "VolumeSnapshot", namespace, name: snapshot }).catch((e: unknown) => {
      if (toK8sError(e).code === "unsupported") return null;
      throw e;
    });
    if (snap === null) return refuse("This cluster does not serve VolumeSnapshots (snapshot_crds_missing); nothing was restored.", "snapshots_unsupported", { reasons: ["snapshot_crds_missing"] });
    if (!snap) return refuse(`VolumeSnapshot ${snapshot} does not exist in ${namespace}.`, "snapshot_missing", { snapshot });
    if (!ownedBy(snap, ctx.environmentId).owned) return refuse(`VolumeSnapshot ${snapshot} is not managed by Zenith for this environment; it is never restored from.`, "ownership_conflict", { snapshot });
    if (dig(snap, "status", "readyToUse") !== true) return refuse(`VolumeSnapshot ${snapshot} is not ready to use yet.`, "snapshot_not_ready", { snapshot });
    const restoreSize = quantityGi(dig(snap, "status", "restoreSize"));
    const wantedSize = quantityGi(storage);
    const requested = restoreSize !== undefined && (wantedSize === undefined || restoreSize > wantedSize) ? `${restoreSize}Gi` : (storage as string);

    const existing = await readObject(client, { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace, name: claim });
    if (existing) {
      const replay = dig(existing, "metadata", "annotations", SNAPSHOT_ANNOTATION.operation) === opId && dig(existing, "spec", "dataSource", "name") === snapshot;
      if (replay && ownedBy(existing, ctx.environmentId).owned) {
        return { ok: true, summary: `Claim ${claim} was already restored from ${snapshot} by this operation.`, data: { claim, snapshot, namespace, alreadyApplied: true }, simulated: false };
      }
      return refuse(`Claim ${claim} already exists. Zenith never overwrites a claim; delete the old one deliberately first.`, "claim_exists", { claim });
    }

    const pvc: K8sObject = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: claim,
        namespace,
        labels,
        annotations: {
          [ANNOTATION.resource]: node.address,
          [ANNOTATION.environment]: ctx.environmentId,
          [SNAPSHOT_ANNOTATION.restoredFrom]: snapshot,
          [SNAPSHOT_ANNOTATION.operation]: opId,
        },
      },
      spec: {
        accessModes,
        resources: { requests: { storage: requested } },
        ...(typeof storageClassName === "string" ? { storageClassName } : {}),
        dataSource: { apiGroup: SNAPSHOT_API_GROUP, kind: "VolumeSnapshot", name: snapshot },
      },
    };
    const report = await serverSideApply([pvc], ctx.session, { environmentId: ctx.environmentId, signal: ctx.signal });
    if (!report.ok) {
      const bad = report.results.find((r) => r.status !== "created" && r.status !== "configured" && r.status !== "unchanged");
      return refuse(`The restored claim was not created (${bad?.status ?? "refused"}${bad?.message ? `: ${truncate(redactText(bad.message), 200)}` : ""}).`, bad?.errorCode ?? "apply_failed");
    }
    return {
      ok: true,
      summary: `Created claim ${claim} from snapshot ${snapshot}. ${kind === "StatefulSet" ? `Scale ${ref.name} up past its ordinal to bind it.` : "Mount it from a workload to use it."}`,
      data: { claim, snapshot, namespace, requestedStorage: requested, alreadyApplied: false },
      simulated: false,
    };
  } catch (e) {
    return failure("Restore failed", e);
  }
}

/* --------------------------------- teardown ----------------------------------- */

/** Owned VolumeSnapshots in a namespace, for teardown. `unavailable` means the cluster has no snapshot CRDs. */
export async function listOwnedSnapshots(client: K8sClient, namespace: string, environmentId: string): Promise<{ items: Record<string, unknown>[]; unavailable: boolean; truncated: boolean }> {
  const listing = await listByKind(client, SNAPSHOT_KINDS.VolumeSnapshot, namespace, { labelSelector: `${LABEL.managedBy}=${MANAGED_BY_VALUE}` });
  return { items: listing.items.filter((i) => ownedBy(i, environmentId).owned), unavailable: listing.unavailable, truncated: listing.truncated };
}
