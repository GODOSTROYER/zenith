/**
 * `aws:route53_zone` (kind `dns_zone`, ownership `referenced`): a customer's
 * existing public hosted zone. Zenith NEVER creates, changes or deletes a zone.
 *
 * Compile: only `data "aws_route53_zone"` looked up by NAME with
 * `private_zone = false` (never by id: the manifest names zones, not ids). A
 * `managed` dns_zone node is refused. Published: `zone_id`, `id`, `name_servers`
 * (as `name_servers`), `arn`.
 *
 * Observe: ListHostedZonesByName(DNSName, MaxItems 5). The zone must match the
 * name exactly and be public. Two public zones with the same name are reported
 * as `unknown` (ambiguous — tofu's data source refuses them too), not resolved
 * by picking one. `externalId` is the hosted-zone id (`Z…`, without the
 * `/hostedzone/` prefix); the name servers go in `native` so a user can
 * delegate the domain.
 *
 * Evidence: `contract` only (mocked Route 53 client).
 */
import { ListHostedZonesByNameCommand, ListHostedZonesCommand, ListTagsForResourceCommand, Route53Client, type HostedZone } from "@aws-sdk/client-route-53";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { DnsZoneSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  DriverCompileError,
  FragmentBuilder,
  REF,
  attempt,
  attributesOf,
  boundNative,
  classifyAwsError,
  failedObservation,
  fromAwsTagList,
  nowIso,
  paginate,
  standardVerification,
  tfLabel,
  unknownAttributes,
} from "../shared";

const SOURCE = "aws.route53_zone@1";
const ATTRIBUTES = ["name", "private"] as const;
/** a DNS name: labels of letters, digits and hyphens, no empty labels */
const ZONE_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Canonical zone name: lowercase, no trailing dot. `undefined` when it is not a DNS name. */
export function normalizeZoneName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const n = name.toLowerCase().replace(/\.$/, "");
  return ZONE_NAME.test(n) ? n : undefined;
}

export function compileZone(node: ResourceNode, _ctx: CompileContext): TofuFragment {
  if (node.ownership === "managed") {
    throw new DriverCompileError("policy_refused", node.address, "Zenith never creates a customer's hosted zone: a dns_zone node must be referenced.");
  }
  const name = normalizeZoneName((node.spec as Partial<DnsZoneSpec>).name);
  if (!name) throw new DriverCompileError("invalid_spec", node.address, `spec.name must be a DNS zone name, got ${JSON.stringify((node.spec as Partial<DnsZoneSpec>).name)}.`);
  if ((node.spec as { private?: boolean }).private === true) throw new DriverCompileError("unsupported", node.address, "private hosted zones are not supported; Zenith looks up public zones only.");
  const L = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  b.data("aws_route53_zone", L, { name, private_zone: false });
  b.expose(REF.zoneId, `data.aws_route53_zone.${L}.zone_id`);
  b.expose(REF.id, `data.aws_route53_zone.${L}.id`);
  b.expose(REF.arn, `data.aws_route53_zone.${L}.arn`);
  b.expose("name_servers", `data.aws_route53_zone.${L}.name_servers`);
  return b.build();
}

export function expectedZoneAttributes(node: ResourceNode): Record<string, unknown> {
  const name = normalizeZoneName((node.spec as Partial<DnsZoneSpec>).name);
  return name ? { name, private: false } : {};
}

/** Route 53 returns ids as `/hostedzone/Z123`; Zenith carries `Z123`. */
export const bareZoneId = (id: string): string => id.replace(/^\/hostedzone\//, "");

/** Public zones whose name is exactly `zoneName`, from a bounded ListHostedZonesByName. */
export async function findPublicZones(ctx: AwsDriverContext, r53: Route53Client, zoneName: string): Promise<HostedZone[]> {
  const r = await r53.send(new ListHostedZonesByNameCommand({ DNSName: zoneName, MaxItems: 10 }), { abortSignal: ctx.signal });
  return (r.HostedZones ?? []).filter((z) => normalizeZoneName(z.Name) === zoneName && z.Config?.PrivateZone !== true);
}

async function observeZone(ctx: AwsDriverContext, node: ResourceNode): Promise<Observation> {
  const base = { address: node.address, observedAt: nowIso(ctx), source: SOURCE, simulated: false };
  const name = normalizeZoneName((node.spec as Partial<DnsZoneSpec>).name);
  if (!name) return { ...base, presence: "unknown", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", "spec.name is not a DNS name"), error: "invalid zone spec" };
  const r53 = ctx.session.client(Route53Client);
  let zones: HostedZone[];
  try {
    zones = await findPublicZones(ctx, r53, name);
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, ATTRIBUTES, failure);
  }
  if (zones.length === 0) return { ...base, presence: "missing", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", "no public hosted zone has this name") };
  if (zones.length > 1) {
    return {
      ...base,
      presence: "unknown",
      attributes: unknownAttributes(ATTRIBUTES, "error", "more than one public hosted zone has this name"),
      native: boundNative({ zoneIds: zones.map((z) => z.Id && bareZoneId(z.Id)) }),
      error: `${zones.length} public hosted zones are named ${name}; refusing to pick one.`,
    };
  }
  const zone = zones[0];
  const zoneId = zone.Id ? bareZoneId(zone.Id) : undefined;
  // Tags are a separate call and a customer zone is usually untagged. A failed read omits `tags` (unknown) instead of claiming none.
  const tagRead = zoneId
    ? await attempt(async () => fromAwsTagList((await r53.send(new ListTagsForResourceCommand({ ResourceType: "hostedzone", ResourceId: zoneId }), { abortSignal: ctx.signal })).ResourceTagSet?.Tags), ctx.signal)
    : undefined;
  return {
    ...base,
    externalId: zoneId,
    presence: "present",
    attributes: attributesOf(ctx, ATTRIBUTES, { name: normalizeZoneName(zone.Name), private: zone.Config?.PrivateZone === true }),
    native: boundNative(
      { zoneId, recordSetCount: zone.ResourceRecordSetCount, comment: zone.Config?.Comment, ...(tagRead?.ok ? { tags: tagRead.value } : {}) },
      { priority: ["zoneId", "tags"] }
    ),
  };
}

async function discoverZones(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const r53 = ctx.session.client(Route53Client);
  const { items } = await paginate(
    async (m) => {
      const r = await r53.send(new ListHostedZonesCommand({ Marker: m, MaxItems: 100 }), { abortSignal: ctx.signal });
      return { items: r.HostedZones ?? [], next: r.IsTruncated ? r.NextMarker : undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  return items
    .filter((z): z is HostedZone & { Id: string } => typeof z.Id === "string")
    .map((z) => ({
      provider: "aws" as const,
      kind: "dns_zone" as const,
      nativeType: "aws:route53_zone",
      externalId: bareZoneId(z.Id),
      name: normalizeZoneName(z.Name) ?? z.Id,
      region: ctx.region,
      // Zenith never tags a customer's zone, so a discovered zone is never "Zenith created".
      zenithTagged: false,
      attributes: { private: z.Config?.PrivateZone === true, recordSets: z.ResourceRecordSetCount ?? 0 },
    }));
}

export const route53ZoneDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "dns_zone",
  nativeType: "aws:route53_zone",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileZone,
  observe: observeZone,
  expectedAttributes: expectedZoneAttributes,
  async verify(ctx, node, observation) {
    return standardVerification(ctx, node, observation, expectedZoneAttributes(node), "the hosted zone");
  },
  discover: discoverZones,
};
