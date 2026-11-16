/**
 * Independent OCI deletion-completion evidence, per resource family.
 *
 * Zenith never deletes OCI objects through these reads: OpenTofu (or the
 * receipt-guarded migration cleanup) issues the delete. This module only answers
 * "is it really gone?" from reads that do not depend on the writer's say-so:
 *
 *   1. READBACK (authoritative): GET by id until the object is `TERMINATED` /
 *      `DELETED`, or until OCI answers 404 AND a complete compartment listing no
 *      longer contains it. OCI answers 404 `NotAuthorizedOrNotFound` for
 *      unauthorized reads too, so a bare 404 is never absence.
 *   2. WORK REQUESTS (corroborating): the newest delete work request that names
 *      the resource. In-flight means "not done"; FAILED/CANCELED means the delete
 *      did not complete. A SUCCEEDED work request with the object still present
 *      is NOT deletion.
 *
 * Verdicts: `deleted` needs positive absence from (1) and no in-flight delete in
 * (2). `unknown`, `inaccessible`, `unsupported` and simulated reads never prove
 * deletion. OCI MySQL is explicitly `unsupported`: Zenith cannot create it (no
 * safe secret sink, drivers/data/mysql.ts) and therefore never claims to have
 * deleted it.
 *
 * Contract evidence only: paths follow the OCI API reference and are not
 * verified against a live tenancy.
 */
import type { Observation, Presence, ResourceNode } from "@/lib/resources/types";
import { asRecord, asString, isGone, listAll, MAX_LIST_PAGES, stateOf, type OciContext } from "./observe-kit";
import { isOcid, ociPath, type OciServiceId } from "./services";
import { ociCall } from "./transport";
import { awaitWorkRequest, listWorkRequestsFor, WORK_REQUEST_APIS, type AwaitOptions, type WorkRequestReceipt } from "./work-requests";

export type DeletionState = "deleted" | "deleting" | "present" | "failed" | "unknown" | "inaccessible" | "unsupported";

export interface DeletionEvidence {
  address: string;
  nativeType: string;
  state: DeletionState;
  /** machine-readable reasons, e.g. `get:TERMINATED`, `get:404+list:absent`, `work_request:SUCCEEDED` */
  basis: string[];
  requestIds: string[];
  /** fixed, bounded text for humans; never provider output */
  detail: string;
}

interface Family {
  /** GET by OCID, when the object has an OCID-addressed GET */
  get?(id: string): { service: OciServiceId; path: string };
  /** compartment listing used to corroborate a 404 */
  list?: { service: OciServiceId; path: string; query?: Record<string, string> };
  /** service whose work requests may name this resource (WORK_REQUEST_APIS) */
  workRequests?: OciServiceId;
  /** reads only through the driver's own observe (no OCID-addressed object) */
  observeOnly?: boolean;
}

export const MYSQL_NATIVE_TYPE = "oci:mysql_db_system";
const MYSQL_REASON = "OCI MySQL is unsupported: Zenith cannot create it without a safe secret sink, so it never claims its deletion.";

/** One entry per OCI native type the drivers register. */
export const DELETION_FAMILIES: Readonly<Record<string, Family>> = {
  "oci:compute_instance": { get: (id) => ({ service: "core", path: ociPath("core", "instances", id) }), list: { service: "core", path: ociPath("core", "instances") } },
  "oci:container_instance": { get: (id) => ({ service: "containerinstances", path: ociPath("containerinstances", "containerInstances", id) }), list: { service: "containerinstances", path: ociPath("containerinstances", "containerInstances") }, workRequests: "containerinstances" },
  "oci:oke_cluster": { get: (id) => ({ service: "containerengine", path: ociPath("containerengine", "clusters", id) }), list: { service: "containerengine", path: ociPath("containerengine", "clusters") }, workRequests: "containerengine" },
  "oci:block_volume": { get: (id) => ({ service: "core", path: ociPath("core", "volumes", id) }), list: { service: "core", path: ociPath("core", "volumes") } },
  "oci:queue": { get: (id) => ({ service: "queue", path: ociPath("queue", "queues", id) }), list: { service: "queue", path: ociPath("queue", "queues") }, workRequests: "queue" },
  "oci:redis_cluster": { get: (id) => ({ service: "redis", path: ociPath("redis", "redisClusters", id) }), list: { service: "redis", path: ociPath("redis", "redisClusters") }, workRequests: "redis" },
  "oci:postgresql_db_system": { get: (id) => ({ service: "postgresql", path: ociPath("postgresql", "dbSystems", id) }), list: { service: "postgresql", path: ociPath("postgresql", "dbSystems") }, workRequests: "postgresql" },
  "oci:load_balancer": { get: (id) => ({ service: "loadbalancer", path: ociPath("loadbalancer", "loadBalancers", id) }), list: { service: "loadbalancer", path: ociPath("loadbalancer", "loadBalancers") } },
  "oci:certificate": { get: (id) => ({ service: "certificates", path: ociPath("certificates", "certificates", id) }), list: { service: "certificates", path: ociPath("certificates", "certificates") } },
  "oci:vcn": { get: (id) => ({ service: "core", path: ociPath("core", "vcns", id) }), list: { service: "core", path: ociPath("core", "vcns") } },
  "oci:subnet": { get: (id) => ({ service: "core", path: ociPath("core", "subnets", id) }), list: { service: "core", path: ociPath("core", "subnets") } },
  "oci:container_repository": { get: (id) => ({ service: "artifacts", path: ociPath("artifacts", "container", "repositories", id) }), list: { service: "artifacts", path: ociPath("artifacts", "container", "repositories") } },
  "oci:dynamic_group": { get: (id) => ({ service: "identity", path: ociPath("identity", "dynamicGroups", id) }), list: { service: "identity", path: ociPath("identity", "dynamicGroups") } },
  "oci:log_group": { get: (id) => ({ service: "logging", path: ociPath("logging", "logGroups", id) }), list: { service: "logging", path: ociPath("logging", "logGroups") }, workRequests: "logging" },
  "oci:vault_secret": { get: (id) => ({ service: "vault", path: ociPath("vault", "secrets", id) }), list: { service: "vault", path: ociPath("vault", "secrets") } },
  // No OCID-addressed GET: the driver's observe (zone readable + empty rrset, bucket list) is the only read.
  "oci:dns_rrset": { observeOnly: true },
  "oci:dns_zone": { observeOnly: true },
  "oci:object_storage_bucket": { observeOnly: true },
  "oci:security_list_rule": { observeOnly: true },
};

const DELETING = new Set(["DELETING", "SCHEDULING_DELETION", "PENDING_DELETION", "TERMINATING"]);
const DELETE_OP = /DELETE|TERMINATE|DESTROY/i;

const evidence = (node: Pick<ResourceNode, "address" | "nativeType">, state: DeletionState, basis: string[], requestIds: string[], detail: string): DeletionEvidence =>
  ({ address: node.address, nativeType: node.nativeType, state, basis: [...new Set(basis)].slice(0, 12), requestIds: requestIds.slice(0, 8), detail });

/** The delete work requests among those naming a resource, newest first. */
export function deleteWorkRequests(receipts: readonly WorkRequestReceipt[]): WorkRequestReceipt[] {
  return receipts.filter((r) => DELETE_OP.test(r.operationType) || r.actionTypes.includes("DELETED"));
}

interface Probe {
  presence: Presence;
  lifecycle?: string;
  basis: string[];
  requestIds: string[];
}

/** GET by id, corroborating a 404 with a complete compartment listing. */
async function probe(ctx: OciContext, node: ResourceNode, family: Family, id: string, migrationKey?: string): Promise<Probe> {
  const region = node.region || ctx.region;
  const requestIds: string[] = [];
  if (!family.get || !isOcid(id)) return { presence: "unknown", basis: ["id:not_addressable"], requestIds };
  const target = family.get(id);
  const r = await ociCall(ctx, { service: target.service, region, method: "GET", path: target.path, ...(migrationKey ? { migrationKey } : {}) });
  if (r.requestId) requestIds.push(r.requestId);
  if (r.ok) {
    const item = asRecord(r.body);
    if (!item || (asString(item.id) !== undefined && item.id !== id)) return { presence: "unknown", basis: ["get:malformed"], requestIds };
    const lifecycle = stateOf(item);
    if (isGone(item)) return { presence: "missing", lifecycle, basis: [`get:${lifecycle}`], requestIds };
    return { presence: "present", lifecycle, basis: [`get:${lifecycle ?? "present"}`], requestIds };
  }
  if (r.outcome === "denied") return { presence: "inaccessible", basis: ["get:denied"], requestIds };
  if (r.outcome !== "not_found") return { presence: "unknown", basis: [`get:${r.outcome}`], requestIds };
  // 404 is ambiguous: only a complete listing that lacks the id corroborates absence.
  if (!family.list) return { presence: "unknown", basis: ["get:404", "list:unavailable"], requestIds };
  const listed = await listAll(ctx, { service: family.list.service, region, method: "GET", path: family.list.path, query: { compartmentId: ctx.session.compartmentOcid, ...(family.list.query ?? {}) } }, (body) => {
    const items = Array.isArray(body) ? body : asRecord(body)?.items;
    if (!Array.isArray(items) || items.some((i) => asRecord(i) === undefined)) throw new Error("invalid collection");
    return items;
  }, MAX_LIST_PAGES);
  requestIds.push(...listed.requestIds);
  if (!listed.ok) return { presence: listed.failure.outcome === "denied" ? "inaccessible" : "unknown", basis: ["get:404", `list:${listed.failure.outcome}`], requestIds };
  if (listed.truncated) return { presence: "unknown", basis: ["get:404", "list:truncated"], requestIds };
  const still = listed.items.map((i) => asRecord(i)!).find((i) => i.id === id && !isGone(i));
  if (still) return { presence: "present", lifecycle: stateOf(still), basis: ["get:404", "list:present"], requestIds };
  return { presence: "missing", basis: ["get:404", "list:absent"], requestIds };
}

export interface ReadDeletionOptions {
  /** the driver's own observation, when the caller already took one (verify path) */
  observation?: Observation;
  /**
   * Runner receipt selector for a receipt-guarded one-off (migration cleanup) and the
   * delete work-request id recorded in the runner's journal. With these the work request
   * is read by id (resumable by any runner that holds the journal); without them it is
   * found by compartment listing.
   */
  migrationKey?: string;
  workRequestId?: string;
  wait?: AwaitOptions;
}

/**
 * Independent deletion verdict for one managed OCI node. Never throws; every
 * unreadable, ambiguous, simulated or unsupported case is a non-`deleted` state.
 */
export async function readDeletionEvidence(ctx: OciContext, node: ResourceNode, externalId: string | undefined, opts: ReadDeletionOptions = {}): Promise<DeletionEvidence> {
  try {
    if (node.nativeType === MYSQL_NATIVE_TYPE) return evidence(node, "unsupported", ["family:mysql_refused"], [], MYSQL_REASON);
    const family = DELETION_FAMILIES[node.nativeType];
    if (!family) return evidence(node, "unsupported", ["family:unregistered"], [], "No OCI deletion evidence is defined for this resource type.");
    const basis: string[] = [];
    const requestIds: string[] = [];

    const obs = opts.observation;
    if (obs?.simulated) return evidence(node, "unknown", ["observation:simulated"], [], "A simulated observation cannot prove deletion.");
    let presence: Presence;
    let lifecycle: string | undefined;
    if (family.observeOnly) {
      if (!obs) return evidence(node, "unknown", ["observation:absent"], [], "This resource type is verified only through its driver observation, which was not supplied.");
      presence = obs.presence;
      basis.push(`observe:${obs.presence}`);
    } else {
      const id = externalId ?? obs?.externalId;
      if (id) {
        const p = await probe(ctx, node, family, id, opts.migrationKey);
        presence = p.presence; lifecycle = p.lifecycle; basis.push(...p.basis); requestIds.push(...p.requestIds);
        // An observation that says "present" is never overridden by a probe that could not read.
        if (obs?.presence === "present" && presence !== "present") { presence = "present"; basis.push("observe:present"); }
      } else if (obs) {
        // No recorded id: only the driver's tag-scoped locate can say anything.
        presence = obs.presence;
        basis.push(`observe:${obs.presence}`);
      } else {
        return evidence(node, "unknown", ["id:absent"], [], "No recorded identifier and no observation; deletion cannot be concluded.");
      }
    }

    // Work requests: corroboration only, and only where the family has one and an id is known.
    const wrApi = family.workRequests ? WORK_REQUEST_APIS[family.workRequests] : undefined;
    const id = externalId ?? obs?.externalId;
    let latestDelete: WorkRequestReceipt | undefined;
    if (wrApi && opts.workRequestId && wrApi.byId) {
      const read = await awaitWorkRequest(ctx, wrApi, opts.workRequestId, { ...opts.wait, ...(opts.migrationKey ? { migrationKey: opts.migrationKey } : {}) });
      requestIds.push(...read.requestIds);
      if (read.ok) { latestDelete = read.receipt; basis.push(`work_request:${read.receipt.status}`); }
      else basis.push(`work_request:${read.reason}`);
    } else if (!opts.migrationKey && wrApi && id && isOcid(id)) {
      const listing = await listWorkRequestsFor(ctx, wrApi, id);
      requestIds.push(...listing.requestIds);
      if (listing.ok) {
        latestDelete = deleteWorkRequests(listing.receipts)[0];
        if (latestDelete) basis.push(`work_request:${latestDelete.status}`);
        else basis.push("work_request:none");
      } else basis.push(`work_request:${listing.reason}`);
    }

    if (presence === "inaccessible") return evidence(node, "inaccessible", basis, requestIds, "OCI would not let Zenith read this resource; absence cannot be concluded.");
    if (presence === "unknown") return evidence(node, "unknown", basis, requestIds, "OCI readback did not give a definite answer.");
    if (presence === "present") {
      if (lifecycle && DELETING.has(lifecycle)) return evidence(node, "deleting", basis, requestIds, "OCI reports the resource is being deleted.");
      if (latestDelete?.state === "in_flight") return evidence(node, "deleting", basis, requestIds, "A delete work request is still in flight.");
      if (latestDelete && (latestDelete.state === "failed" || latestDelete.state === "canceled")) return evidence(node, "failed", basis, requestIds, "The newest delete work request did not complete and the resource still exists.");
      return evidence(node, "present", basis, requestIds, "The resource still exists.");
    }
    // presence === "missing": positive absence from readback.
    if (latestDelete?.state === "in_flight") return evidence(node, "deleting", basis, requestIds, "The resource reads as absent but a delete work request is still in flight.");
    return evidence(node, "deleted", basis, requestIds, "Independent readback shows the resource is gone.");
  } catch {
    return evidence(node, "unknown", ["error"], [], "OCI deletion evidence could not be read.");
  }
}

/** Presence for the destroy verifier: `missing` only for a `deleted` verdict. */
export function presenceOfDeletion(e: DeletionEvidence): "missing" | "present" | "unknown" {
  if (e.state === "deleted") return "missing";
  if (e.state === "present" || e.state === "failed" || e.state === "deleting") return "present";
  return "unknown";
}
