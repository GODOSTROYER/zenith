/**
 * `gcp:memorystore_instance` — Memorystore for Redis (`google_redis_instance`).
 *
 * Why this product: it is real Redis (7.2), it reuses the Private Service
 * Access connection the network node already owns for Cloud SQL, and the
 * tofu engine already classifies `google_redis_instance` as stateful.
 * Memorystore for Redis Cluster / Valkey (`google_memorystore_instance`) offer
 * IAM authentication but are cluster-mode and connect through Private Service
 * Connect (a per-network service connection policy, more moving parts); that
 * is a different driver, not a flag here.
 *
 * Security posture (decided, and stated because it differs from "AUTH on"):
 *   - transit encryption: `SERVER_AUTHENTICATION` (TLS) — always;
 *   - `auth_enabled = false`. Memorystore for Redis has no IAM authentication;
 *     enabling AUTH would put a generated AUTH string in tofu state and force
 *     Zenith to copy it into Secret Manager (a secret value flowing through
 *     state and plan), which the platform's "references only" rule avoids.
 *     Access control is instead (1) private connectivity only — the instance
 *     is reachable from the authorized VPC through PSA and has no public
 *     endpoint, (2) TLS, and (3) the network-wide egress deny to the PSA range
 *     plus per-source allow rules (`gcp:firewall_rule`), so only declared
 *     client workloads can open a connection. AUTH can be enabled later via the
 *     provider-native escape hatch.
 *   - persistence: `backup` none → off; daily → RDB every 24 h; hourly → RDB
 *     every hour (both tiers support RDB snapshots);
 *   - tier `STANDARD_HA` when `highAvailability`, else `BASIC`;
 *   - `deletion_protection` + `deletion_policy = PREVENT` unless `deletionPolicy`
 *     is `allow`.
 * Size → memory: nano 1 GB, small 2 GB, standard 5 GB, performance 10 GB;
 * `instanceClass` of the form `5gb`/`memory-5gb` overrides.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { RedisSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, nodeLabels, tfLabel } from "../../naming";
import { contractCapabilities, deletionGuard, managedOnly, nameResolver, specOf } from "../../driver-util";
import { dataFragment, depsOfKind, expr, lastSegment, lit, ref, safeRegion } from "../../hcl";
import { makeReaders, num, rec, str, tail, type ReadSpec } from "../../read-kit";
import { psaConnectionAddress } from "../network/vpc-network";

export const DRIVER_ID = "gcp.memorystore_instance@1";
const REDIS = "https://redis.googleapis.com/v1";
const MEMORY_GB: Record<string, number> = { nano: 1, small: 2, standard: 5, performance: 10 };
const SNAPSHOT: Record<string, string> = { daily: "TWENTY_FOUR_HOURS", hourly: "ONE_HOUR" };

export function redisMemoryGb(s: Pick<RedisSpec, "size" | "instanceClass">, where: string): number {
  if (s.instanceClass) {
    const m = /^(?:memory-)?(\d{1,3})(?:\s?gb)?$/i.exec(s.instanceClass.trim());
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 300) throw new GcpCompileError("invalid_spec", `${where}: instanceClass "${lit(s.instanceClass).slice(0, 24)}" is not a memory size such as 5gb.`);
    return Number(m[1]);
  }
  return MEMORY_GB[s.size] ?? MEMORY_GB.small;
}

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<RedisSpec>(node);
  return {
    tier: s.highAvailability ? "STANDARD_HA" : "BASIC",
    memorySizeGb: redisMemoryGb(s, node.address),
    redisVersion: "REDIS_7_2",
    transitEncryptionMode: "SERVER_AUTHENTICATION",
    authEnabled: false,
    connectMode: "PRIVATE_SERVICE_ACCESS",
    persistenceMode: s.backup === "none" ? "DISABLED" : "RDB",
  };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_redis_instance", L, { name: lastSegment(node.externalRef, node.address), region: safeRegion(node.region) });
  }
  safeRegion(ctx.region);
  const s = specOf<RedisSpec>(node);
  if (s.engine !== "redis") throw new GcpCompileError("unsupported_engine", `${node.address}: this driver realizes redis only.`);
  const network = depsOfKind(node, ctx, "network")[0];
  if (!network) throw new GcpCompileError("missing_network", `${node.address}: a private-only Redis instance needs a network node among its dependencies.`);
  const guard = deletionGuard(s);
  const body: Record<string, unknown> = {
    name: cloudName(ctx.namePrefix, node.address, { max: 40, suffix: "redis" }),
    region: ctx.region,
    display_name: `Zenith ${lit(node.address).slice(0, 60)}`,
    tier: s.highAvailability ? "STANDARD_HA" : "BASIC",
    memory_size_gb: redisMemoryGb(s, node.address),
    redis_version: "REDIS_7_2",
    authorized_network: ref(ctx, network.address, "id"),
    connect_mode: "PRIVATE_SERVICE_ACCESS",
    transit_encryption_mode: "SERVER_AUTHENTICATION",
    auth_enabled: false,
    labels: nodeLabels(ctx.tags, node),
    deletion_protection: guard.protect,
    deletion_policy: guard.policy,
    depends_on: [psaConnectionAddress(network.address)],
  };
  if (s.backup !== "none") body.persistence_config = [{ persistence_mode: "RDB", rdb_snapshot_period: SNAPSHOT[s.backup] }];
  return {
    resource: { google_redis_instance: { [L]: body } },
    output: {
      [`${L}_host`]: { value: expr(`google_redis_instance.${L}.host`), description: "private IP of the instance" },
      [`${L}_port`]: { value: expr(`google_redis_instance.${L}.port`), description: "TLS port" },
    },
    addresses: [`google_redis_instance.${L}`],
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:memorystore_instance",
  kind: "redis",
  attributes: ["tier", "memorySizeGb", "redisVersion", "transitEncryptionMode", "authEnabled", "connectMode", "persistenceMode"],
  resolve: nameResolver((p) => `projects/${p}/locations/[a-z0-9-]{2,40}/instances/[a-z][a-z0-9-]{0,39}`, REDIS, "Memorystore instance"),
  list: {
    url: (ctx) => `${REDIS}/projects/${ctx.session.projectId}/locations/${ctx.region}/instances?pageSize=100`,
    itemsKey: "instances",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    return {
      externalId: name,
      name: tail(name),
      attributes: {
        tier: str(o.tier),
        memorySizeGb: num(o.memorySizeGb),
        redisVersion: str(o.redisVersion),
        transitEncryptionMode: str(o.transitEncryptionMode) ?? "DISABLED",
        authEnabled: o.authEnabled === true,
        connectMode: str(o.connectMode),
        persistenceMode: str(rec(o.persistenceConfig).persistenceMode) ?? "DISABLED",
      },
      native: { state: str(o.state), port: num(o.port), hasHost: !!str(o.host), replicaCount: num(o.replicaCount), locationId: str(o.locationId), rdbSnapshotPeriod: str(rec(o.persistenceConfig).rdbSnapshotPeriod) },
    };
  },
  runtime(o) {
    const state = str(o.state);
    const health = state === "READY" ? "healthy" : state === "DELETING" ? "unhealthy" : state && state !== "STATE_UNSPECIFIED" ? "degraded" : "unknown";
    const counts: Record<string, number> = {};
    const replicas = num(o.replicaCount);
    if (replicas !== undefined) counts.replicaCount = replicas;
    return { health, counts, signals: state ? [`state:${state.replace(/[^A-Z_]/g, "").slice(0, 32)}`] : [] };
  },
};

const readers = makeReaders(spec, expectedAttributes, { serving: true });

export const memorystoreInstanceDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "redis",
  nativeType: "gcp:memorystore_instance",
  capabilities: contractCapabilities({ runtime: true, discover: true }),
  compile,
  observe: readers.observe,
  runtime: readers.runtime,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
