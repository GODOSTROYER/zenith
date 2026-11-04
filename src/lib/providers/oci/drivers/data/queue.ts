/**
 * `oci:queue` — portable `queue` on OCI (OCI Queue).
 *
 * Settings come from the manifest's `config` when present and valid, else OCI
 * Queue's own defaults are pinned explicitly so a provider default change
 * cannot silently alter behaviour:
 *   retentionSeconds   10 … 604800, default 345600 (4 days)
 *   visibilitySeconds  0 … 43200,   default 30
 * Messages are encrypted at rest with an Oracle-managed key (no custom key is
 * attached); stateful queues carry `prevent_destroy` unless `deletionPolicy`
 * is "allow".
 *
 * Runtime reads the queue's DATA PLANE stats endpoint (`messagesEndpoint` from
 * the control-plane object): visible / in-flight / dead-letter counts. A
 * non-empty dead-letter queue is `degraded`.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { QueueSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asNumber,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  locate,
  observationOf,
  runtimeOf,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";

export const QUEUE_NATIVE_TYPE = "oci:queue";
const ID = ociDriverId(QUEUE_NATIVE_TYPE);

const DEFAULT_RETENTION = 345_600;
const DEFAULT_VISIBILITY = 30;

function setting(node: ResourceNode, config: QueueSpec["config"], key: string, def: number, min: number, max: number): number {
  const raw = config?.[key];
  if (raw === undefined) return def;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) throw new OciCompileError(`${node.address}: config.${key} must be an integer in ${min}..${max}.`);
  return raw;
}

export const queueSettings = (node: ResourceNode) => {
  const spec = specOf<QueueSpec>(node);
  return {
    retentionSeconds: setting(node, spec.config, "retentionSeconds", DEFAULT_RETENTION, 10, 604_800),
    visibilitySeconds: setting(node, spec.config, "visibilitySeconds", DEFAULT_VISIBILITY, 0, 43_200),
  };
};

export function compileQueue(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<QueueSpec>(node);
  const s = queueSettings(node);
  const queue = res("oci_queue_queue", node);
  return {
    resource: {
      oci_queue_queue: {
        [queue.label]: {
          compartment_id: compartmentOf(ctx),
          display_name: nodeCloudName(ctx, node, 100),
          retention_in_seconds: s.retentionSeconds,
          visibility_in_seconds: s.visibilitySeconds,
          freeform_tags: zenithTags(ctx, node),
          ...protectFromDestroy(spec),
        },
      },
    },
    locals: { [auxName(node.address, "id")]: interp(`${queue.address}.id`) },
    addresses: addressList(queue.address, []),
  };
}

export const queueExpected = (node: ResourceNode): Record<string, unknown> => queueSettings(node);

const locateDef: LocateDef = {
  service: "queue",
  get: (id) => ({ path: ociPath("queue", "queues", id) }),
  list: (compartmentId) => ({ path: ociPath("queue", "queues"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

/** Control-plane object with full attributes: list summaries omit retention/visibility. */
async function fullQueue(ctx: OciContext, node: ResourceNode, id: string, requestIds: string[]): Promise<Record<string, unknown> | undefined> {
  const r = await ociCall(ctx, { service: "queue", region: node.region || ctx.region, method: "GET", path: ociPath("queue", "queues", id) });
  if (r.requestId) requestIds.push(r.requestId);
  return r.ok ? asRecord(r.body) : undefined;
}

export async function observeQueue(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) return observationOf(ctx, node, ID, located);
  const full = (await fullQueue(ctx, node, located.externalId, located.requestIds)) ?? located.item;
  const at = ctx.now().toISOString();
  const attributes = attributesOf(at, { retentionSeconds: asNumber(full.retentionInSeconds), visibilitySeconds: asNumber(full.visibilityInSeconds) });
  return observationOf(ctx, node, ID, located, attributes, {
    lifecycleState: full.lifecycleState,
    messagesEndpoint: full.messagesEndpoint ?? null,
    deadLetterQueueDeliveryCount: full.deadLetterQueueDeliveryCount ?? null,
  });
}

const OCI_HOST = /^[a-z0-9.-]+\.oraclecloud\.com$/i;

export async function runtimeQueue(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const src = ID;
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.externalId) return runtimeOf(ctx, node, src, "unknown", {}, [`presence:${located.presence}`]);
  const full = (await fullQueue(ctx, node, located.externalId, located.requestIds)) ?? located.item;
  const state = asString(full?.lifecycleState);
  const signals: string[] = state ? [`state:${state}`] : [];
  const endpoint = asString(full?.messagesEndpoint);
  let host: string | undefined;
  try {
    host = endpoint ? new URL(endpoint).hostname : undefined;
  } catch {
    host = undefined;
  }
  if (state !== "ACTIVE") return runtimeOf(ctx, node, src, state === "FAILED" || state === "DELETED" ? "unhealthy" : "degraded", {}, signals);
  if (!host || !OCI_HOST.test(host)) return runtimeOf(ctx, node, src, "unknown", {}, [...signals, "no_messages_endpoint"]);

  const r = await ociCall(ctx, { service: "queue-data", region: node.region || ctx.region, method: "GET", endpointHost: host, path: ociPath("queue-data", "queues", located.externalId, "stats") });
  if (!r.ok) return runtimeOf(ctx, node, src, "unknown", {}, [...signals, `stats:${r.outcome}`]);
  const body = asRecord(r.body);
  const q = asRecord(body?.queue);
  const dlq = asRecord(body?.dlq);
  const counts: Record<string, number> = {};
  const put = (k: string, v: unknown) => {
    const n = asNumber(v);
    if (n !== undefined) counts[k] = n;
  };
  put("visible", q?.visibleMessages);
  put("inFlight", q?.inFlightMessages);
  put("dlqVisible", dlq?.visibleMessages);
  if ((counts.dlqVisible ?? 0) > 0) signals.push(`dead_letter:${counts.dlqVisible}`);
  return runtimeOf(ctx, node, src, (counts.dlqVisible ?? 0) > 0 ? "degraded" : "healthy", counts, signals);
}

export const queueDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "queue",
  nativeType: QUEUE_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true }),
  compile: compileQueue,
  observe: observeQueue,
  runtime: runtimeQueue,
  expectedAttributes: queueExpected,
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: queueExpected(node), runtime, now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "queue",
      nativeType: QUEUE_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "queue",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "" }),
    }),
};
