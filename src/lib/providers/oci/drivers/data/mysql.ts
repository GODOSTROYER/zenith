/**
 * HeatWave MySQL configuration/runtime reads, contract evidence only.
 * IMPORTANT: no compile method. The pinned oracle/oci 9.7.1 resource accepts
 * admin_password, not PostgreSQL's VAULT_SECRET password_details. Fetching a
 * Vault bundle into admin_password would persist the password in plans/state.
 * The checked-in oracle/oci 9.7.1 schema lists no admin_password_wo argument
 * or provider-side Vault reference. The fixture is a projection, without
 * sensitivity/write-only metadata: a suffix or successful validate alone is
 * not proof that a password stays out of plans/state. OpenTofu requires an
 * explicitly write-only sink for an ephemeral password. Keep CREATE disabled
 * until the real pinned schema and plan/state behaviour prove a safe path.
 * See mysql.test.ts for fixture checks, gated live-schema verification and
 * ephemeral persistence negative controls. Real cloud apply is unverified.
 * MySQL's scheduled backups are daily; hourly is never claimed as achieved.
 * Runner reads require the mysql service entry in the Go endpoint fixture.
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { strictArrayOrItems, asRecord, asString, attributesOf, discoverWith, locate, observationOf, runtimeOf, verifyWith, type LocateDef } from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";

const NATIVE = "oci:mysql_db_system";
const ID = ociDriverId(NATIVE);
const def: LocateDef = {
  service: "mysql", get: (id) => ({ path: ociPath("mysql", "dbSystems", id) }),
  list: (compartmentId) => ({ path: ociPath("mysql", "dbSystems"), query: { compartmentId } }),
  items: strictArrayOrItems, idOf: (i) => asString(asRecord(i)?.id),
};
const expected = (node: ResourceNode) => ({ version: node.spec.version, highAvailability: node.spec.highAvailability, backup: node.spec.backup });
export const mysqlDriver: ResourceDriver<OciSession> = {
  id: ID, provider: "oci", kind: "mysql", nativeType: NATIVE,
  capabilities: ociCapabilities({ observe: true, runtime: true, verify: true, discover: true }),
  expectedAttributes: expected,
  observe: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    if (found.presence !== "present" || !found.externalId) return observationOf(ctx, node, ID, found);
    const r = await ociCall(ctx, { service: "mysql", region: node.region || ctx.region, method: "GET", ...def.get!(found.externalId) });
    if (r.requestId) found.requestIds.push(r.requestId);
    const full = r.ok ? asRecord(r.body) : undefined;
    const enabled = asRecord(full?.backupPolicy)?.isEnabled;
    return observationOf(ctx, node, ID, found, attributesOf(ctx.now().toISOString(), {
      version: asString(full?.mysqlVersion), highAvailability: typeof full?.isHighlyAvailable === "boolean" ? full.isHighlyAvailable : undefined,
      backup: typeof enabled === "boolean" ? enabled ? "daily" : "none" : undefined,
    }), { lifecycleState: full?.lifecycleState, shape: full?.shapeName });
  },
  runtime: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    const state = found.presence === "present" ? asString(found.item?.lifecycleState) : undefined;
    const health = state === "ACTIVE" ? "healthy" : ["FAILED", "INACTIVE", "DELETED"].includes(state ?? "") ? "unhealthy" : ["CREATING", "UPDATING", "DELETING"].includes(state ?? "") ? "degraded" : "unknown";
    return runtimeOf(ctx, node, ID, health, {}, state ? [`state:${state}`] : [`presence:${found.presence}`]);
  },
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: expected(node), runtime, now: ctx.now() }),
  discover: (ctx) => discoverWith(ctx, { ...def, kind: "mysql", nativeType: NATIVE, nameOf: (i) => asString(i.displayName) ?? "mysql", attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", version: asString(i.mysqlVersion) ?? "" }) }),
};
