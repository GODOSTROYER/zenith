/**
 * `oci:log_group` — portable `log_group` on OCI.
 *
 * OCI Logging keeps RETENTION on the individual log, not the group, so a node
 * compiles to `oci_logging_log_group` plus one CUSTOM log
 * (`<label>_app`, `is_enabled`, `retention_duration = N`). The workload writes
 * to the custom log through the Logging ingestion API using its resource
 * principal; the identity node grants it `use log-content` scoped to this
 * group (`target.loggroup.id`).
 *
 * Retention: OCI accepts 30, 60, …, 180 days. `retentionDays` is rounded UP to
 * the next multiple of 30 (never retaining less than asked); more than 180 is
 * refused rather than silently shortened.
 *
 * Honest limit: Container Instances do not ship stdout to Logging by
 * themselves. Until the application (or a sidecar) calls PutLogs, the group is
 * empty; `logs.read` through the runner is a follow-up and is NOT implemented.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { LogGroupSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, TAG_ENV, TAG_RESOURCE, zenithTags } from "../../naming";
import { arrayOrItems, asNumber, asRecord, asString, attributesOf, discoverWith, isGone, listAll, locate, observationOf, tagsOf, verifyWith, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const LOG_GROUP_NATIVE_TYPE = "oci:log_group";
const ID = ociDriverId(LOG_GROUP_NATIVE_TYPE);

export function retentionFor(node: ResourceNode, days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 1) throw new OciCompileError(`${node.address}: retentionDays must be a positive number.`);
  const rounded = Math.max(30, Math.ceil(days / 30) * 30);
  if (rounded > 180) throw new OciUnsupportedError(`${node.address}: OCI Logging retains at most 180 days; ${days} was requested.`);
  return rounded;
}

export function compileLogGroup(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<LogGroupSpec>(node);
  const retention = retentionFor(node, spec.retentionDays);
  const group = res("oci_logging_log_group", node);
  const log = res("oci_logging_log", node, "_app");
  const name = nodeCloudName(ctx, node, 90);
  const tags = zenithTags(ctx, node);
  return {
    resource: {
      oci_logging_log_group: { [group.label]: { compartment_id: compartmentOf(ctx), display_name: name, description: `Logs for ${spec.workload}`.slice(0, 250), freeform_tags: tags } },
      oci_logging_log: {
        [log.label]: { log_group_id: interp(`${group.address}.id`), display_name: `${name}-app`, log_type: "CUSTOM", is_enabled: true, retention_duration: retention, freeform_tags: tags },
      },
    },
    locals: { [auxName(node.address, "app_log_id")]: interp(`${log.address}.id`) },
    addresses: addressList(group.address, [log.address]),
  };
}

export function logGroupExpected(node: ResourceNode): Record<string, unknown> {
  return { retentionDays: retentionFor(node, specOf<LogGroupSpec>(node).retentionDays) };
}

const locateDef: LocateDef = {
  service: "logging",
  get: (id) => ({ path: ociPath("logging", "logGroups", id) }),
  list: (compartmentId) => ({ path: ociPath("logging", "logGroups"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeLogGroup(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item || !located.externalId) return observationOf(ctx, node, ID, located);
  const at = ctx.now().toISOString();
  let retentionDays: number | undefined;
  const logs = await listAll(ctx, { service: "logging", region: node.region || ctx.region, method: "GET", path: ociPath("logging", "logGroups", located.externalId, "logs") }, arrayOrItems);
  if (logs.ok) {
    const mine = logs.items.find((l) => !isGone(l) && tagsOf(l)[TAG_ENV] === ctx.environmentId && tagsOf(l)[TAG_RESOURCE] === node.address);
    retentionDays = asNumber(asRecord(mine)?.retentionDuration);
  }
  return observationOf(ctx, node, ID, located, attributesOf(at, { retentionDays }), { lifecycleState: located.item.lifecycleState, displayName: located.item.displayName });
}

export const logGroupDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "log_group",
  nativeType: LOG_GROUP_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileLogGroup,
  observe: observeLogGroup,
  expectedAttributes: logGroupExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: logGroupExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "log_group",
      nativeType: LOG_GROUP_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "log group",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "" }),
    }),
};
