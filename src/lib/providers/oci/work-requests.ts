/**
 * OCI work requests as independent receipts of accepted asynchronous work.
 *
 * A work request is OCI's own record that a create/delete/update was accepted,
 * is in flight, or finished. Zenith treats it as EVIDENCE, never as authority:
 *
 *   - an id arrives from the provider's response (`opc-work-request-id`, kept in
 *     the runner's durable receipt journal) or from a compartment listing;
 *   - reading one is a read-only GET that cannot re-execute anything, so a
 *     replacement runner that inherits the journal (or any runner with the
 *     compartment read capability) can resume watching in-flight work;
 *   - a SUCCEEDED work request alone never proves deletion; the resource's own
 *     readback does (deletion-evidence.ts);
 *   - a lost response is NOT a failed request: absence of an id means "unknown",
 *     never "did not run".
 *
 * Shapes follow the OCI API reference for each service's WorkRequest object and
 * were not exercised against a live tenancy. Anything that does not match the
 * expected identity or shape is `unknown`, never a guess.
 *
 * Honest limit: the OCI runner binds every OCID it is asked about to a trusted
 * compartment. A work-request OCID can only be bound by the runner's own
 * receipt journal (container-instance migrations), so by-id reads exist only
 * for those; every other family is read through the compartment-scoped listing
 * (`?compartmentId=`), filtered by the resource identifier the work request names.
 */
import { asRecord, asString, listAll, type OciContext } from "./observe-kit";
import { isOcid, ociPath, type OciServiceId } from "./services";
import { ociCall } from "./transport";

export type WorkRequestState = "in_flight" | "succeeded" | "failed" | "canceled" | "unknown";

export interface WorkRequestReceipt {
  id: string;
  /** raw OCI status, bounded */
  status: string;
  state: WorkRequestState;
  operationType: string;
  /** OCIDs of the resources the work request names */
  resourceIds: string[];
  /** `DELETED` / `CREATED` / ... per OCI's WorkRequestResource.actionType, when present */
  actionTypes: string[];
  percentComplete?: number;
  timeAccepted?: string;
}

/** How one service exposes work requests; undefined for a family without them. */
export interface WorkRequestApi {
  service: OciServiceId;
  /** by-id path, only usable for ids in the runner's receipt journal */
  byId?(id: string): string;
  /** compartment listing path */
  list: string;
}

/**
 * Services whose resources are deleted through a work request AND whose listing
 * the runner can bind by `compartmentId`. Core (VCN, subnet, volume, instance),
 * DNS, certificates, artifacts, vault, identity and Object Storage have no work
 * request that this module reads; their deletion is proved by readback alone.
 * Load Balancer work requests are addressed per load balancer id and cannot be
 * bound by the runner, so the load balancer is readback-only too.
 */
export const WORK_REQUEST_APIS: Readonly<Partial<Record<OciServiceId, WorkRequestApi>>> = {
  containerinstances: { service: "containerinstances", byId: (id) => ociPath("containerinstances", "workRequests", id), list: ociPath("containerinstances", "workRequests") },
  postgresql: { service: "postgresql", list: ociPath("postgresql", "workRequests") },
  redis: { service: "redis", list: ociPath("redis", "workRequests") },
  containerengine: { service: "containerengine", list: ociPath("containerengine", "workRequests") },
  queue: { service: "queue", list: ociPath("queue", "workRequests") },
  logging: { service: "logging", list: ociPath("logging", "workRequests") },
};

const IN_FLIGHT = new Set(["ACCEPTED", "IN_PROGRESS", "WAITING", "CANCELING"]);

export function stateOfStatus(status: string): WorkRequestState {
  const s = status.toUpperCase();
  if (IN_FLIGHT.has(s)) return "in_flight";
  if (s === "SUCCEEDED") return "succeeded";
  if (s === "FAILED") return "failed";
  if (s === "CANCELED" || s === "CANCELLED") return "canceled";
  return "unknown";
}

/**
 * Strict parse of one WorkRequest / WorkRequestSummary. Returns undefined for
 * a malformed object, a foreign compartment or (when given) a different id.
 */
export function parseWorkRequest(value: unknown, ctx: { compartmentOcid: string }, expectedId?: string): WorkRequestReceipt | undefined {
  const r = asRecord(value);
  if (!r) return undefined;
  const id = asString(r.id);
  const status = asString(r.status);
  if (!id || !isOcid(id) || !status || status.length > 40) return undefined;
  if (expectedId !== undefined && id !== expectedId) return undefined;
  // A work request in another compartment is never evidence for this one. A
  // body without the field is tolerated (some summaries omit it); a wrong one is not.
  if (r.compartmentId !== undefined && r.compartmentId !== ctx.compartmentOcid) return undefined;
  const operationType = asString(r.operationType) ?? "";
  if (operationType.length > 80 || !/^[A-Za-z0-9_]*$/.test(operationType)) return undefined;
  const resources = Array.isArray(r.resources) ? r.resources : [];
  if (!resources.every((x) => asRecord(x) !== undefined)) return undefined;
  const resourceIds: string[] = [];
  const actionTypes: string[] = [];
  for (const raw of resources) {
    const res = asRecord(raw)!;
    const identifier = asString(res.identifier);
    if (identifier) resourceIds.push(identifier);
    const action = asString(res.actionType);
    if (action && /^[A-Z_]{1,40}$/.test(action)) actionTypes.push(action);
  }
  const percent = typeof r.percentComplete === "number" && Number.isFinite(r.percentComplete) ? r.percentComplete : undefined;
  const accepted = asString(r.timeAccepted);
  return {
    id, status: status.toUpperCase(), state: stateOfStatus(status), operationType,
    resourceIds: resourceIds.slice(0, 20), actionTypes: [...new Set(actionTypes)].slice(0, 10),
    ...(percent !== undefined ? { percentComplete: percent } : {}),
    ...(accepted && Number.isFinite(Date.parse(accepted)) ? { timeAccepted: accepted } : {}),
  };
}

export type WorkRequestRead =
  | { ok: true; receipt: WorkRequestReceipt; requestIds: string[] }
  | { ok: false; reason: "not_readable" | "malformed" | "not_found" | "denied" | "unavailable"; requestIds: string[] };

/** One by-id read (journal-owned ids only). Never throws; never retries a write. */
export async function readWorkRequest(ctx: OciContext, api: WorkRequestApi, id: string, opts: { migrationKey?: string } = {}): Promise<WorkRequestRead> {
  if (!api.byId || !isOcid(id)) return { ok: false, reason: "not_readable", requestIds: [] };
  const r = await ociCall(ctx, { service: api.service, region: ctx.region, method: "GET", path: api.byId(id), ...(opts.migrationKey ? { migrationKey: opts.migrationKey } : {}) });
  const requestIds = r.requestId ? [r.requestId] : [];
  if (!r.ok) return { ok: false, reason: r.outcome === "not_found" ? "not_found" : r.outcome === "denied" ? "denied" : "unavailable", requestIds };
  const receipt = parseWorkRequest(r.body, ctx.session, id);
  return receipt ? { ok: true, receipt, requestIds } : { ok: false, reason: "malformed", requestIds };
}

export type WorkRequestListing =
  | { ok: true; receipts: WorkRequestReceipt[]; truncated: boolean; requestIds: string[] }
  | { ok: false; reason: "malformed" | "denied" | "unavailable"; requestIds: string[] };

/** Compartment listing, filtered to work requests that name `resourceId`. A malformed row fails the whole listing. */
export async function listWorkRequestsFor(ctx: OciContext, api: WorkRequestApi, resourceId: string): Promise<WorkRequestListing> {
  if (!isOcid(resourceId)) return { ok: false, reason: "malformed", requestIds: [] };
  const listed = await listAll(ctx, { service: api.service, region: ctx.region, method: "GET", path: api.list, query: { compartmentId: ctx.session.compartmentOcid } }, (body) => {
    const items = Array.isArray(body) ? body : asRecord(body)?.items;
    if (!Array.isArray(items)) throw new Error("invalid work request collection");
    return items;
  });
  if (!listed.ok) return { ok: false, reason: listed.failure.outcome === "denied" ? "denied" : listed.failure.outcome === "error" ? "malformed" : "unavailable", requestIds: listed.requestIds };
  const receipts: WorkRequestReceipt[] = [];
  for (const raw of listed.items) {
    const receipt = parseWorkRequest(raw, ctx.session);
    if (!receipt) return { ok: false, reason: "malformed", requestIds: listed.requestIds };
    if (receipt.resourceIds.includes(resourceId)) receipts.push(receipt);
  }
  // newest first; ties keep a stable order by id so the choice is deterministic
  receipts.sort((a, b) => (b.timeAccepted ?? "").localeCompare(a.timeAccepted ?? "") || a.id.localeCompare(b.id));
  return { ok: true, receipts, truncated: listed.truncated, requestIds: listed.requestIds };
}

export interface AwaitOptions {
  /** poll interval; injected so tests do not sleep */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  maxPolls?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * Poll a journal-owned work request until it is terminal. Resuming after a
 * runner replacement is exactly this call: it only reads. A cancelled signal,
 * an exhausted bound or an unreadable work request leaves the state
 * `in_flight` / `unknown`, never a conclusion.
 */
export async function awaitWorkRequest(ctx: OciContext, api: WorkRequestApi, id: string, opts: AwaitOptions & { migrationKey?: string } = {}): Promise<WorkRequestRead> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxPolls = Math.max(1, Math.min(opts.maxPolls ?? 30, 600));
  let last: WorkRequestRead = { ok: false, reason: "unavailable", requestIds: [] };
  for (let i = 0; i < maxPolls; i++) {
    last = await readWorkRequest(ctx, api, id, { migrationKey: opts.migrationKey });
    if (!last.ok || last.receipt.state !== "in_flight") return last;
    if (i === maxPolls - 1) break;
    try { await sleep(opts.intervalMs ?? 2000, ctx.signal); } catch { return last; }
  }
  return last;
}

/** Narrow a runner receipt-query body to its work request ids (shape-checked OCIDs only). */
export function receiptWorkRequestIds(body: unknown): { create?: string; delete?: string } {
  const r = asRecord(body);
  const out: { create?: string; delete?: string } = {};
  if (isOcid(r?.createWorkRequest)) out.create = r.createWorkRequest as string;
  if (isOcid(r?.deleteWorkRequest)) out.delete = r.deleteWorkRequest as string;
  return out;
}
