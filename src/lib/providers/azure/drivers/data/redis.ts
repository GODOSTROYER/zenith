/**
 * `azure:redis_cache` — portable `redis` on Azure Cache for Redis (C family).
 *
 *   - TLS ONLY: `non_ssl_port_enabled = false` (6380 is the only listener),
 *     `minimum_tls_version = 1.2`.
 *   - PRIVATE ONLY: `public_network_access_enabled = false` plus a private
 *     endpoint in the landing zone's endpoint subnet, registered in the
 *     `privatelink.redis.cache.windows.net` zone.
 *   - AUTH: Entra ID authentication is enabled next to access keys. The keys
 *     exist in Azure but are never referenced by compiled config, so they are
 *     not in tofu state; `redis_configuration.authentication_enabled` (which
 *     would turn authentication OFF) is never set.
 *   - SKU: Basic C-family, or Standard when `highAvailability` (replicated).
 *     Capacity by size: nano C0, small C1, standard C2, performance C3.
 *   - NOT realized: `spec.backup`. Azure Cache for Redis persistence needs the
 *     Premium tier plus a storage account; Basic/Standard have none. The
 *     expansion's backup intent is reported here, not silently dropped.
 *   - Deletion: `prevent_destroy` + `CanNotDelete` lock unless `allow`.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { RedisSpec } from "@/lib/resources/specs";
import { block, fragment, mergeBlocks, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, pick, props, type RuntimeRead } from "@/lib/providers/azure/kit";
import type { ArmResource } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { API, REDIS_CAPACITY_BY_SIZE } from "@/lib/providers/azure/platform";
import { deletionLock, privateEndpoint, protectFromDestroy } from "@/lib/providers/azure/drivers/data/private-endpoint";

export const REDIS = { type: "Microsoft.Cache/redis", apiVersion: API.redis } as const;

export const redisSku = (spec: RedisSpec): "Basic" | "Standard" => (spec.highAvailability ? "Standard" : "Basic");
export const redisCapacity = (spec: RedisSpec): number => REDIS_CAPACITY_BY_SIZE[spec.size] ?? REDIS_CAPACITY_BY_SIZE.small;

export function compileRedis(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<RedisSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const L = tfLabel(a, "redis");
  const id = `\${azurerm_redis_cache.${L}.id}`;
  const resource = mergeBlocks(
    block("azurerm_redis_cache", L, {
      name: cloudName(ctx, a, { max: 63, suffix: "redis" }),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      family: "C",
      capacity: redisCapacity(spec),
      sku_name: redisSku(spec),
      non_ssl_port_enabled: false,
      minimum_tls_version: "1.2",
      public_network_access_enabled: false,
      redis_configuration: { active_directory_authentication_enabled: true },
      tags: azureTags(ctx, node),
      lifecycle: { prevent_destroy: protectFromDestroy(spec.deletionPolicy) },
    }),
    privateEndpoint({ node, ctx, network: net, targetId: id, subresource: "redisCache", zone: "dns_redis_id" }),
    deletionLock(node, id, spec.deletionPolicy)
  );
  return fragment({ resource, locals: exportLocals(a, { id, name: `\${azurerm_redis_cache.${L}.name}`, fqdn: `\${azurerm_redis_cache.${L}.hostname}` }) });
}

export function expectedRedis(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<RedisSpec>(node);
  return { sku: redisSku(spec), capacity: redisCapacity(spec), tlsOnly: true, minimumTls: "1.2", publicNetworkAccess: "Disabled" };
}

function readRedis(res: ArmResource): Record<string, unknown> {
  const p = props(res);
  const nonSsl = pick<boolean>(p, "enableNonSslPort");
  return {
    sku: pick<string>(p, "sku", "name"),
    capacity: pick<number>(p, "sku", "capacity"),
    tlsOnly: nonSsl === undefined ? undefined : nonSsl === false,
    minimumTls: pick<string>(p, "minimumTlsVersion"),
    publicNetworkAccess: pick<string>(p, "publicNetworkAccess"),
  };
}

export const redisDriver = defineAzureDriver({
  id: "azure.redis_cache@1",
  kind: "redis",
  nativeType: "azure:redis_cache",
  arm: REDIS,
  compile: compileRedis,
  expected: expectedRedis,
  read: readRedis,
  native: (res) => ({ provisioningState: props(res).provisioningState, hostName: props(res).hostName, sslPort: props(res).sslPort, redisVersion: props(res).redisVersion }),
  runtime: async (_ctx, _node, res): Promise<RuntimeRead> => {
    const state = pick<string>(props(res), "provisioningState") ?? "Unknown";
    return { health: state === "Succeeded" ? "healthy" : ["Creating", "Updating", "Scaling", "Provisioning"].includes(state) ? "degraded" : state === "Failed" ? "unhealthy" : "unknown", counts: {}, signals: [`provisioning:${state}`] };
  },
  serving: true,
});
