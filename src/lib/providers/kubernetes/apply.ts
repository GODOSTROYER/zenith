/**
 * Server-side apply with explicit ownership (ADR-0015).
 *
 *   serverSideApply(objects, session, opts)   apply rendered objects
 *   diff(objects, session, opts)              server dry-run, changed field paths only
 *   pruneOrphans(input, session, opts)        delete what Zenith owns and no longer wants
 *   waitForRollout / rollback                 see `rollout.ts` (re-exported)
 *
 * The rules, in the order they bind:
 *   1. Field manager `zenith`, `force: false`, always. A field-manager conflict
 *      (another actor owns a field we want to change) is REPORTED with the
 *      field paths and the other manager; it is never forced.
 *   2. OWNERSHIP GUARD. Before any write, every object is read. A live object
 *      that lacks `app.kubernetes.io/managed-by: zenith` or whose
 *      `zenith.dev/environment` differs from the desired one is an
 *      `ownership_conflict`. The WHOLE batch is then refused and nothing is
 *      applied: Zenith never modifies, re-labels or adopts an object it does
 *      not own (adoption is an explicit import, not an apply side effect).
 *   3. Namespace allowlist on every namespaced object (`client.ts`).
 *   4. Only the kinds Zenith renders are accepted; anything else is refused.
 *   5. Secrets: the rendered Secret has no data. Values come from the injected
 *      `resolveSecret(ref)`, are merged into the REQUEST BODY in memory only,
 *      and appear in no result, log line or error (errors are scrubbed of the
 *      resolved values). A Secret that cannot be resolved refuses the batch.
 *
 * Honest limits: apply is sequential and not transactional across objects; an
 * abort or API failure midway leaves earlier objects applied (they are
 * reported as such). Field-manager conflict detection and the `unchanged`
 * determination depend on the API server's answers. Contract suites and gated
 * disposable-kind acceptance cover them; managed cloud acceptance is separate.
 */
import { PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { applyOrder } from "./render";
import { conflictsFrom, createK8sClient, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import { diffPaths, normalizeForDiff } from "./diff";
import { immutableViolations } from "./immutability";
import { isDnsLabel } from "./naming";
import { validateRbac, validateRbacCompanions } from "./rbac";
import {
  ANNOTATION,
  FIELD_MANAGER,
  K8sError,
  KIND_INFO,
  LABEL,
  MANAGED_BY_VALUE,
  OPS_FIELD_MANAGER,
  SECRET_DATA_KEY,
  isSupportedKind,
  refKey,
  refOf,
  type ApplyItemResult,
  type ApplyReport,
  type K8sObject,
  type ObjectRef,
} from "./types";
import { isRecord, plain, scrubValues } from "./util";

export type SecretResolver = (ref: string) => Promise<string | null | undefined>;

export interface ApplyOptions {
  /** `zenith` (default) for declarative apply; `zenith-ops` exists for day-two operations */
  fieldManager?: typeof FIELD_MANAGER | typeof OPS_FIELD_MANAGER;
  /** never true: Zenith does not take fields from other managers */
  force?: false;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** cross-check: every object must be annotated with this environment */
  environmentId?: string;
  /** resolves a Secret's `zenith.dev/secret-ref` to its value, in memory, at apply time */
  resolveSecret?: SecretResolver;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
}

interface Prepared {
  obj: K8sObject;
  ref: ObjectRef;
  environment: string;
  live?: Record<string, unknown>;
  secretValue?: string;
}

const short = (r: ObjectRef) => `${r.kind}/${r.name}${r.namespace ? ` in ${r.namespace}` : ""}`;

/* ------------------------------ validation -------------------------------- */

function validate(obj: K8sObject, expectEnv: string | undefined): { ref: ObjectRef; environment: string } {
  if (!isRecord(obj) || typeof obj.kind !== "string" || typeof obj.apiVersion !== "string" || !isRecord(obj.metadata) || typeof obj.metadata.name !== "string") {
    throw new K8sError("invalid_object", "Object needs apiVersion, kind and metadata.name.");
  }
  if (!isSupportedKind(obj.kind) || KIND_INFO[obj.kind].apiVersion !== obj.apiVersion) {
    throw new K8sError("invalid_object", `Zenith does not apply ${obj.apiVersion} ${obj.kind}.`);
  }
  const info = KIND_INFO[obj.kind];
  if (!isDnsLabel(obj.metadata.name)) throw new K8sError("invalid_object", `${obj.kind} name "${obj.metadata.name.slice(0, 70)}" is not a valid DNS label.`);
  if (info.namespaced && !(typeof obj.metadata.namespace === "string" && isDnsLabel(obj.metadata.namespace))) {
    throw new K8sError("invalid_object", `${obj.kind}/${obj.metadata.name} needs an explicit, valid namespace.`);
  }
  if (!info.namespaced && obj.metadata.namespace !== undefined) throw new K8sError("invalid_object", `${obj.kind} is cluster-scoped and must not name a namespace.`);
  if (obj.metadata.labels?.[LABEL.managedBy] !== MANAGED_BY_VALUE) throw new K8sError("invalid_object", `${obj.kind}/${obj.metadata.name} is missing ${LABEL.managedBy}=${MANAGED_BY_VALUE}.`);
  const environment = obj.metadata.annotations?.[ANNOTATION.environment];
  if (typeof environment !== "string" || environment === "") throw new K8sError("invalid_object", `${obj.kind}/${obj.metadata.name} is missing ${ANNOTATION.environment}.`);
  if (expectEnv !== undefined && environment !== expectEnv) throw new K8sError("invalid_object", `${obj.kind}/${obj.metadata.name} belongs to a different environment than this apply.`);
  if (typeof obj.metadata.annotations?.[ANNOTATION.resource] !== "string") throw new K8sError("invalid_object", `${obj.kind}/${obj.metadata.name} is missing ${ANNOTATION.resource}.`);
  if (obj.kind === "Secret" && ("data" in obj || "stringData" in obj)) throw new K8sError("invalid_object", "A Secret must be rendered without data; values are merged at apply time.");
  validateRbac(obj, "invalid_object");
  return { ref: refOf(obj), environment };
}

/* ------------------------------ secret merge ------------------------------- */

/** The request body for an object; for Secrets, the resolved value is merged in memory only. */
function bodyFor(p: Prepared): K8sObject {
  if (p.obj.kind !== "Secret" || p.secretValue === undefined) return p.obj;
  return { ...p.obj, data: { [SECRET_DATA_KEY]: Buffer.from(p.secretValue, "utf8").toString("base64") } };
}

function secretValueChanged(live: Record<string, unknown> | undefined, value: string | undefined): boolean {
  if (value === undefined) return false;
  const data = isRecord(live?.data) ? live.data : {};
  const got = data[SECRET_DATA_KEY];
  return typeof got !== "string" || Buffer.from(got, "base64").toString("utf8") !== value;
}

/* -------------------------------- preflight -------------------------------- */

interface PreflightOutcome {
  prepared: Prepared[];
  failures: ApplyItemResult[];
  secretValues: string[];
}

async function preflight(client: K8sClient, objects: readonly K8sObject[], opts: ApplyOptions, environmentId: string | undefined): Promise<PreflightOutcome> {
  const prepared: Prepared[] = [];
  const failures: ApplyItemResult[] = [];
  const secretValues: string[] = [];

  for (const obj of applyOrder(objects)) {
    let v: { ref: ObjectRef; environment: string };
    try {
      v = validate(obj, environmentId);
      validateRbacCompanions(obj, objects);
    } catch (e) {
      const err = toK8sError(e);
      failures.push({ ref: refOf(obj ?? {}), status: "error", errorCode: err.code, message: err.message });
      continue;
    }
    const p: Prepared = { obj, ref: v.ref, environment: v.environment };
    try {
      if (p.ref.kind !== "Namespace") await client.guard.assert(p.ref.namespace as string);
      p.live = await readObject(client, p.ref);
    } catch (e) {
      const err = toK8sError(e);
      failures.push({ ref: p.ref, status: "error", errorCode: err.code, message: err.message });
      continue;
    }
    if (p.live) {
      if (isRecord((p.live.metadata as Record<string, unknown> | undefined)) && (p.live.metadata as Record<string, unknown>).deletionTimestamp) {
        failures.push({ ref: p.ref, status: "error", errorCode: "api_error", message: `${short(p.ref)} is being deleted; retry after it is gone.` });
        continue;
      }
      const own = ownedBy(p.live, p.environment);
      if (!own.owned) {
        failures.push({
          ref: p.ref,
          status: "ownership_conflict",
          errorCode: "ownership_conflict",
          message: `${short(p.ref)} exists and is not managed by Zenith for this environment (${own.reason}). Zenith never modifies or adopts it; import it explicitly or choose another name.`,
        });
        continue;
      }
      const immutable = immutableViolations(p.live, p.obj);
      if (immutable.length > 0) {
        failures.push({
          ref: p.ref,
          status: "error",
          errorCode: "invalid",
          message: `${short(p.ref)}: ${immutable.join(", ")} cannot change on an existing object. Nothing was applied; create a new resource name, or expand the claims in place with the storage class's own tooling.`,
        });
        continue;
      }
    }
    if (p.ref.kind === "Namespace") client.guard.registerZenithCreated(p.ref.name);
    if (p.ref.kind === "Secret") {
      const ref = p.obj.metadata.annotations?.[ANNOTATION.secretRef];
      try {
        if (typeof ref !== "string" || ref === "") throw new K8sError("secret_unresolved", `${short(p.ref)} has no ${ANNOTATION.secretRef} annotation.`);
        if (!opts.resolveSecret) throw new K8sError("secret_unresolved", `${short(p.ref)} needs a secret resolver; none was provided.`);
        const value = await opts.resolveSecret(ref);
        if (value === null || value === undefined) throw new K8sError("secret_unresolved", `Secret reference ${ref} could not be resolved.`);
        p.secretValue = value;
        secretValues.push(value);
      } catch (e) {
        const err = toK8sError(e, secretValues);
        failures.push({ ref: p.ref, status: "error", errorCode: err.code === "api_error" ? "secret_unresolved" : err.code, message: err.message });
        continue;
      }
    }
    prepared.push(p);
  }
  return { prepared, failures, secretValues };
}

/* --------------------------------- apply ----------------------------------- */

interface AppliedOne {
  result: ApplyItemResult;
  /** the server's answer (dry-run: the projected object); internal, never returned publicly */
  applied?: Record<string, unknown>;
  /** a Secret whose resolved value differs from the live one (value itself is never kept) */
  secretChanged?: boolean;
}

async function applyOne(client: K8sClient, p: Prepared, opts: ApplyOptions, secretValues: readonly string[]): Promise<AppliedOne> {
  const manager = opts.fieldManager ?? FIELD_MANAGER;
  try {
    // KubernetesObjectApi.patch mutates its argument (defaults namespace/apiVersion); hand it a copy
    const body = plain<K8sObject>(bodyFor(p));
    const got = plain<Record<string, unknown>>(
      await client.objects.patch(body as KubernetesObject, undefined, opts.dryRun ? "All" : undefined, manager, false, PatchStrategy.ServerSideApply)
    );
    const meta = isRecord(got.metadata) ? got.metadata : {};
    const secretChanged = p.obj.kind === "Secret" && secretValueChanged(p.live, p.secretValue);
    let status: ApplyItemResult["status"];
    if (!p.live) status = "created";
    else {
      // Controllers can update status, revisions or managedFields between the
      // preflight read and apply. resourceVersion then changes even for a no-op.
      // Compare the defaulted server objects, just as the dry-run diff does.
      const changed = diffPaths(normalizeForDiff(p.live), normalizeForDiff(got)).length > 0 || secretChanged;
      status = changed ? "configured" : "unchanged";
    }
    return {
      result: {
        ref: p.ref,
        status,
        uid: typeof meta.uid === "string" ? meta.uid : undefined,
        resourceVersion: typeof meta.resourceVersion === "string" ? meta.resourceVersion : undefined,
        generation: typeof meta.generation === "number" ? meta.generation : undefined,
      },
      applied: got,
      secretChanged,
    };
  } catch (e) {
    const conflicts = conflictsFrom(e);
    if (conflicts.length > 0) {
      const who = [...new Set(conflicts.map((c) => c.manager).filter(Boolean))].join(", ") || "another manager";
      return {
        result: {
          ref: p.ref,
          status: "conflict",
          errorCode: "field_conflict",
          conflicts,
          message: `${short(p.ref)}: ${conflicts.length} field(s) are owned by ${who} with a different value (${conflicts.map((c) => c.field).slice(0, 8).join(", ")}). Zenith does not force; resolve the ownership first.`,
        },
      };
    }
    const err = toK8sError(e, secretValues);
    return { result: { ref: p.ref, status: err.code === "aborted" ? "skipped" : "error", errorCode: err.code, message: scrubValues(err.message, secretValues) } };
  }
}

function assertNoForce(opts: ApplyOptions): void {
  if ((opts as { force?: unknown }).force === true) throw new K8sError("bad_input", "Zenith never forces server-side apply (ADR-0015).");
  if (opts.fieldManager !== undefined && opts.fieldManager !== FIELD_MANAGER && opts.fieldManager !== OPS_FIELD_MANAGER) {
    throw new K8sError("bad_input", "Only Zenith's own field managers may be used.");
  }
}

interface RunOutcome {
  report: ApplyReport;
  applied: Map<string, Record<string, unknown>>;
  lives: Map<string, Record<string, unknown> | undefined>;
  secretChanged: Set<string>;
}

/**
 * The environment a batch acts for: the caller's, else the one every object
 * names. A batch that names several and is not told which is refused, so the
 * namespace guard and ownership checks are never bound to "whatever the
 * objects say".
 */
function batchEnvironment(objects: readonly K8sObject[], given: string | undefined): string | undefined {
  if (given !== undefined) return given;
  const envs = new Set<string>();
  for (const o of objects) {
    const e = o?.metadata?.annotations?.[ANNOTATION.environment];
    if (typeof e === "string" && e !== "") envs.add(e);
  }
  if (envs.size > 1) throw new K8sError("invalid_object", "Objects belong to several environments; pass environmentId to say which one this apply is for.");
  return envs.size === 1 ? [...envs][0] : undefined;
}

async function run(objects: readonly K8sObject[], session: KubernetesSession, opts: ApplyOptions): Promise<RunOutcome> {
  assertNoForce(opts);
  const dryRun = opts.dryRun === true;
  const environmentId = batchEnvironment(objects, opts.environmentId);
  const client = createK8sClient(session, { signal: opts.signal, environmentId, requestTimeoutMs: opts.requestTimeoutMs });
  const pre = await preflight(client, objects, opts, environmentId);
  const applied = new Map<string, Record<string, unknown>>();
  const lives = new Map<string, Record<string, unknown> | undefined>();
  const secretChanged = new Set<string>();
  for (const p of pre.prepared) lives.set(refKey(p.ref), p.live);

  if (pre.failures.length > 0) {
    const refusedNote = "Batch refused: nothing was applied.";
    const results: ApplyItemResult[] = [
      ...pre.failures,
      ...pre.prepared.map((p): ApplyItemResult => ({ ref: p.ref, status: "skipped", message: refusedNote })),
    ];
    opts.log?.(`kubernetes apply refused: ${pre.failures.length} preflight failure(s)`);
    return { report: { ok: false, dryRun, refused: true, results }, applied, lives, secretChanged };
  }

  const results: ApplyItemResult[] = [];
  let stopped: string | undefined;
  for (const p of pre.prepared) {
    if (stopped) {
      results.push({ ref: p.ref, status: "skipped", message: stopped });
      continue;
    }
    if (opts.signal?.aborted) {
      stopped = "Aborted before this object was applied.";
      results.push({ ref: p.ref, status: "skipped", message: stopped });
      continue;
    }
    const one = await applyOne(client, p, opts, pre.secretValues);
    results.push(one.result);
    // A binding must never activate stale rules after its Role failed to apply.
    if (p.obj.kind === "Role" && !["created", "configured", "unchanged"].includes(one.result.status)) {
      stopped = "Stopped because a Role failed to apply; dependent bindings were not activated.";
    }
    if (one.applied) applied.set(refKey(p.ref), one.applied);
    if (one.secretChanged) secretChanged.add(refKey(p.ref));
    opts.log?.(`kubernetes ${dryRun ? "dry-run " : ""}apply ${short(p.ref)}: ${one.result.status}`);
    if (one.result.status === "conflict" || one.result.status === "error" || one.result.status === "skipped") {
      stopped = `Not applied because ${short(p.ref)} did not apply (${one.result.status}).`;
    }
  }
  const ok = results.every((r) => r.status === "created" || r.status === "configured" || r.status === "unchanged");
  return { report: { ok, dryRun, refused: false, results }, applied, lives, secretChanged };
}

/** Apply rendered objects with server-side apply. See the module comment for the rules. */
export async function serverSideApply(objects: readonly K8sObject[], session: KubernetesSession, opts: ApplyOptions = {}): Promise<ApplyReport> {
  return (await run(objects, session, opts)).report;
}

/* ---------------------------------- diff ----------------------------------- */

export interface DiffItem {
  ref: ObjectRef;
  action: "create" | "update" | "none" | "conflict" | "ownership_conflict" | "error";
  /** field paths that would change; never values */
  changedPaths: string[];
  message?: string;
}

/**
 * What applying `objects` would change, via a server-side dry-run compared to
 * the live objects. Dry-run applies with the same field manager and the same
 * ownership guard; nothing is persisted. Secret VALUES are never compared or
 * shown: a changed value is reported as `data.value`.
 */
export async function diff(objects: readonly K8sObject[], session: KubernetesSession, opts: Omit<ApplyOptions, "dryRun"> = {}): Promise<DiffItem[]> {
  const out = await run(objects, session, { ...opts, dryRun: true });
  return out.report.results.map((r): DiffItem => {
    const key = refKey(r.ref);
    if (r.status === "ownership_conflict") return { ref: r.ref, action: "ownership_conflict", changedPaths: [], message: r.message };
    if (r.status === "conflict") return { ref: r.ref, action: "conflict", changedPaths: (r.conflicts ?? []).map((c) => c.field), message: r.message };
    if (r.status === "error" || r.status === "skipped") return { ref: r.ref, action: "error", changedPaths: [], message: r.message };
    const live = out.lives.get(key);
    const projected = out.applied.get(key);
    if (!live) return { ref: r.ref, action: "create", changedPaths: [] };
    const paths = diffPaths(normalizeForDiff(live), projected ? normalizeForDiff(projected) : {});
    if (out.secretChanged.has(key)) paths.push(`data.${SECRET_DATA_KEY}`);
    paths.sort();
    return { ref: r.ref, action: paths.length > 0 ? "update" : "none", changedPaths: paths };
  });
}

export { pruneOrphans, type PruneInput, type PruneReport } from "./prune";
export { waitForRollout, rollback, type RolloutOptions, type RolloutResult, type RollbackOptions, type RollbackResult } from "./rollout";
