/**
 * `oci:redis_cluster` — portable `redis` on OCI (OCI Cache), MINIMAL.
 *
 * Compile-only-minimal by design; this is the least-validated data driver:
 *   - private subnet + its own NSG (clients get tcp/6379 through firewall nodes);
 *   - `cluster_mode` NONSHARDED, software REDIS_7_0 (OCI Cache enforces TLS);
 *   - `node_count` 3 when `highAvailability`, else 1;
 *   - memory per node from `size` (nano/small 2 GB, standard 4, performance 8).
 * NOT realized: scheduled backups (OCI Cache only has manual backups, so
 * `spec.backup` other than "none" is NOT honoured and the node says so in
 * its observed `backup` attribute as unknown), sharding, parameter sets,
 * users. Redis is a cache in most manifests; do not keep the only copy of
 * data here.
 *
 * Observe reads node count and state; runtime maps the lifecycle state to
 * health. The memory mapping and node-count bounds are taken from the provider
 * schema and docs, not from a live service.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { RedisSpec } from "@/lib/resources/specs";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, networkOf, nodeCloudName, zenithTags } from "../../naming";
import { arrayOrItems, asNumber, asRecord, asString, attributesOf, discoverWith, locate, observationOf, runtimeOf, verifyWith, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";

export const REDIS_NATIVE_TYPE = "oci:redis_cluster";
const ID = ociDriverId(REDIS_NATIVE_TYPE);
const MEMORY_GB: Record<string, number> = { nano: 2, small: 2, standard: 4, performance: 8 };

export function compileRedis(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<RedisSpec>(node);
  const memory = MEMORY_GB[String(spec.size)];
  if (memory === undefined) throw new OciCompileError(`${node.address}: unknown size "${String(spec.size)}".`);
  const compartment = compartmentOf(ctx);
  const placement = networkOf(ctx, node, "private");
  const tags = zenithTags(ctx, node);
  const name = nodeCloudName(ctx, node, 100);
  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const cluster = res("oci_redis_redis_cluster", node);
  return {
    resource: {
      oci_core_network_security_group: { [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${name}-nsg`, freeform_tags: tags } },
      oci_redis_redis_cluster: {
        [cluster.label]: {
          compartment_id: compartment,
          display_name: name,
          cluster_mode: "NONSHARDED",
          node_count: spec.highAvailability === true ? 3 : 1,
          node_memory_in_gbs: memory,
          software_version: "REDIS_7_0",
          subnet_id: ctx.ref(placement.subnets[0], "id"),
          nsg_ids: [interp(`${nsg.address}.id`)],
          freeform_tags: tags,
          ...protectFromDestroy(spec),
        },
      },
    },
    locals: { [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`) },
    addresses: addressList(cluster.address, [nsg.address]),
  };
}

export const redisExpected = (node: ResourceNode): Record<string, unknown> => ({ nodeCount: specOf<RedisSpec>(node).highAvailability === true ? 3 : 1 });

const locateDef: LocateDef = {
  service: "redis",
  get: (id) => ({ path: ociPath("redis", "redisClusters", id) }),
  list: (compartmentId) => ({ path: ociPath("redis", "redisClusters"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeRedis(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  return observationOf(ctx, node, ID, located, attributesOf(at, { nodeCount: asNumber(item.nodeCount) }), {
    lifecycleState: item.lifecycleState,
    softwareVersion: item.softwareVersion,
    nodeMemoryInGBs: item.nodeMemoryInGBs ?? null,
  });
}

export async function runtimeRedis(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return runtimeOf(ctx, node, ID, "unknown", {}, [`presence:${located.presence}`]);
  const state = asString(located.item.lifecycleState);
  const nodeCount = asNumber(located.item.nodeCount);
  const health: HealthState = state === "ACTIVE" ? "healthy" : state === "FAILED" || state === "DELETED" ? "unhealthy" : state ? "degraded" : "unknown";
  return runtimeOf(ctx, node, ID, health, nodeCount === undefined ? {} : { nodes: nodeCount }, state ? [`state:${state}`] : []);
}

export const redisDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "redis",
  nativeType: REDIS_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true }),
  compile: compileRedis,
  observe: observeRedis,
  runtime: runtimeRedis,
  expectedAttributes: redisExpected,
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: redisExpected(node), runtime, now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "redis",
      nativeType: REDIS_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "redis",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "" }),
    }),
};
