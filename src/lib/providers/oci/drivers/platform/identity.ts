/**
 * `oci:dynamic_group` — portable `identity` on OCI: a workload principal.
 *
 * `identity/<svc>` is "the workload `<svc>` may do THESE verbs to THESE exact
 * targets" (IdentitySpec.grants). On OCI it compiles to two resources:
 *
 *   oci_identity_dynamic_group   (lives in the TENANCY)
 *     ALL {resource.type='computecontainerinstance',
 *          resource.compartment.id='<compartment>',
 *          tag.zenith_environment.value='<env>',
 *          tag.zenith_resource.value='<workload address>'}
 *     i.e. exactly the container instances Zenith created for this workload in
 *     this environment and compartment. Matching by tag is what lets the group
 *     exist BEFORE the instances (expansion orders identity before the
 *     workload). Honest limit: anyone who may create or tag a container
 *     instance in the compartment could put the tag on a foreign instance;
 *     restrict that right with your own policy (deploy/oci does).
 *
 *   oci_identity_policy          (in the compartment)
 *     one statement per grant, each scoped `in compartment id <ocid>` AND to
 *     the exact target with a `where` clause. Never `manage all-resources`,
 *     never a bare resource family without a target condition:
 *
 *       object_store  read/list/write/delete → inspect|read|manage objects
 *                     where target.bucket.name = '<bucket>'
 *                     (`manage` is the lowest OCI verb that can CREATE an
 *                     object, so a write grant also admits delete; the
 *                     manifest's blob binding grants both anyway)
 *       queue         publish → use queue-push, consume → use queue-pull
 *                     where target.queue.id = '<queue>'
 *       secret        read → read secret-bundles where target.secret.id = …
 *       postgres      read_credentials → read secret-bundles where
 *                     target.secret.id = '<the DB admin password secret>'
 *       log_group     write → use log-content where target.loggroup.id = …
 *       container_registry  pull → read repos where target.repo.name = …
 *
 * Fail closed: an unknown target kind, an unknown verb, or a wildcard target
 * throws instead of widening the policy. The one soft case is a SECRET target
 * that is not an OCI Vault secret this environment can name (for example an
 * AWS ARN): it cannot be scoped, so NO statement is written for it and its
 * address is listed in the output `<label>_ungranted_targets` (a cross-cloud
 * secret is unreadable by an OCI principal anyway; the gap is reported, not
 * papered over).
 *
 * Honest limits: OCI policy changes can take minutes to propagate and new
 * dynamic-group rules up to an hour; a container that starts before then sees
 * 401/404 from the services it calls. Policy statement syntax and the `where`
 * variable names follow the public IAM policy reference and were not exercised
 * against a tenancy.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { IdentityGrant, IdentitySpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf, tenancyOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxRef, cloudName, interp, nameOf, TAG_ENV, TAG_RESOURCE, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asRecord,
  asString,
  attributesOf,
  isGone,
  listAll,
  locate,
  observationOf,
  tagsOf,
  unreadableObservation,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { isOcid, ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const DYNAMIC_GROUP_NATIVE_TYPE = "oci:dynamic_group";
const ID = ociDriverId(DYNAMIC_GROUP_NATIVE_TYPE);

const SAFE_TOKEN = /^[A-Za-z0-9_./:-]{1,200}$/;
const kindOfAddress = (address: string): string => address.slice(0, Math.max(0, address.indexOf("/")));

/* ------------------------------- policy shapes ------------------------------ */

type ValueSource = "ref_name" | "ref_id" | "admin_secret_id" | "ref_display_name" | "secret";
interface Shape {
  verb: "inspect" | "read" | "use" | "manage";
  resource: string;
  variable: string;
  source: ValueSource;
}

const ALLOWED: Record<string, readonly string[]> = {
  object_store: ["delete", "list", "read", "write"],
  queue: ["publish", "consume"],
  secret: ["read"],
  postgres: ["read_credentials"],
  log_group: ["write"],
  container_registry: ["pull"],
};

/** The OCI statements one grant expands to, without any resolved value. Pure. */
export function shapesOf(grant: IdentityGrant): Shape[] {
  if (grant.target.includes("*")) throw new OciCompileError(`identity grant target "${grant.target}" contains a wildcard; grants must name one exact target.`);
  const kind = kindOfAddress(grant.target);
  const allowed = ALLOWED[kind];
  if (!allowed) throw new OciUnsupportedError(`identity grant target "${grant.target}" (${kind || "unknown kind"}) has no OCI policy mapping; refusing to guess a wider policy.`);
  const verbs = [...new Set(grant.access)].sort();
  if (verbs.length === 0) throw new OciCompileError(`identity grant on ${grant.target} lists no access verbs.`);
  const bad = verbs.filter((v) => !allowed.includes(v));
  if (bad.length) throw new OciCompileError(`identity grant on ${grant.target}: verb(s) ${bad.join(", ")} are not valid for ${kind} (allowed: ${allowed.join(", ")}).`);

  switch (kind) {
    case "object_store": {
      const verb = verbs.includes("write") || verbs.includes("delete") ? "manage" : verbs.includes("read") ? "read" : "inspect";
      return [{ verb, resource: "objects", variable: "target.bucket.name", source: "ref_name" }];
    }
    case "queue":
      return verbs.map((v) => ({ verb: "use" as const, resource: v === "publish" ? "queue-push" : "queue-pull", variable: "target.queue.id", source: "ref_id" as const }));
    case "secret":
      return [{ verb: "read", resource: "secret-bundles", variable: "target.secret.id", source: "secret" }];
    case "postgres":
      return [{ verb: "read", resource: "secret-bundles", variable: "target.secret.id", source: "admin_secret_id" }];
    case "log_group":
      return [{ verb: "use", resource: "log-content", variable: "target.loggroup.id", source: "ref_id" }];
    default:
      return [{ verb: "read", resource: "repos", variable: "target.repo.name", source: "ref_display_name" }];
  }
}

export const statementCount = (spec: IdentitySpec): number => spec.grants.reduce((n, g) => n + shapesOf(g).length, 0);

/** The expression a statement's `where` compares against, or `undefined` when a secret cannot be scoped to an OCI secret OCID. */
function valueFor(source: ValueSource, ctx: CompileContext, grant: IdentityGrant): string | undefined {
  switch (source) {
    case "ref_name":
      return ctx.ref(grant.target, "name");
    case "ref_id":
      return ctx.ref(grant.target, "id");
    case "ref_display_name":
      return ctx.ref(grant.target, "display_name");
    case "admin_secret_id":
      return auxRef(grant.target, "admin_secret_id");
    case "secret": {
      const target = ctx.node(grant.target);
      if (target?.ownership === "managed") return auxRef(grant.target, "id");
      if (isOcid(target?.externalRef)) return target!.externalRef as string; // a reference to the customer's own secret
      return undefined;
    }
  }
}

function assertSafe(what: string, value: string): string {
  if (!SAFE_TOKEN.test(value) || value.includes("'")) throw new OciCompileError(`${what} "${value.slice(0, 60)}" contains characters that are not allowed in a dynamic group rule.`);
  return value;
}

export function compileIdentity(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<IdentitySpec>(node);
  if (spec.principal !== "workload") throw new OciUnsupportedError(`${node.address}: only workload principals are supported on OCI.`);
  const compartment = compartmentOf(ctx);
  const tenancy = tenancyOf(ctx);
  const workload = assertSafe("workload address", spec.workload);
  const environment = assertSafe("environment id", ctx.environmentId);

  const dg = res("oci_identity_dynamic_group", node);
  const policy = res("oci_identity_policy", node, "_policy");
  const dgName = cloudName(ctx.namePrefix, `workload-${nameOf(node.address)}`, 100);
  const tags = zenithTags(ctx, node);

  const statements: string[] = [];
  const ungranted: string[] = [];
  for (const grant of [...spec.grants].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))) {
    for (const s of shapesOf(grant)) {
      const value = valueFor(s.source, ctx, grant);
      if (value === undefined) {
        // A secret that is not an OCI Vault secret this environment can name cannot be scoped: grant nothing, say so.
        if (!ungranted.includes(grant.target)) ungranted.push(grant.target);
        continue;
      }
      statements.push(`Allow dynamic-group ${interp(`${dg.address}.name`)} to ${s.verb} ${s.resource} in compartment id ${compartment} where ${s.variable} = '${value}'`);
    }
  }

  const resource: NonNullable<TofuFragment["resource"]> = {
    oci_identity_dynamic_group: {
      [dg.label]: {
        compartment_id: tenancy,
        name: dgName,
        description: `Zenith workload identity for ${workload} (${environment})`,
        matching_rule: `ALL {resource.type='computecontainerinstance', resource.compartment.id='${compartment}', tag.${TAG_ENV}.value='${environment}', tag.${TAG_RESOURCE}.value='${workload}'}`,
        freeform_tags: tags,
      },
    },
  };
  if (statements.length > 0) {
    resource.oci_identity_policy = {
      [policy.label]: {
        compartment_id: compartment,
        name: dgName,
        description: `Least-privilege grants for ${workload}; generated by Zenith`,
        statements,
        freeform_tags: tags,
      },
    };
  }
  return {
    resource,
    ...(ungranted.length
      ? { output: { [`${dg.label}_ungranted_targets`]: { value: ungranted, description: `Grant targets of ${workload} that are secrets outside OCI Vault (or not resolvable to a secret OCID); NO access was granted to them.` } } }
      : {}),
    addresses: addressList(dg.address, statements.length ? [policy.address] : []),
  };
}

export function identityExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<IdentitySpec>(node);
  return { workload: spec.workload, wildcardPolicy: false };
}

/* --------------------------------- observe --------------------------------- */

const dgLocate: LocateDef = {
  service: "identity",
  get: (id) => ({ path: ociPath("identity", "dynamicGroups", id) }),
  list: (compartmentId, session) => ({ path: ociPath("identity", "dynamicGroups"), query: { compartmentId: session.tenancyOcid ?? compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

const WORKLOAD_IN_RULE = new RegExp(`tag\\.${TAG_RESOURCE}\\.value\\s*=\\s*'([^']+)'`);
const MANAGE_ALL = /\bmanage\s+all-resources\b/i;
const ANY_ALL_RESOURCES = /\bto\s+\w+\s+all-resources\b/i;

export async function observeIdentity(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  if (!externalId && !ctx.session.tenancyOcid) return unreadableObservation(ctx, node, ID, "The session carries no tenancy OCID, and dynamic groups are listed per tenancy.");
  const located = await locate(ctx, node, externalId, dgLocate);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const at = ctx.now().toISOString();
  const rule = asString(located.item.matchingRule);
  const workload = rule ? WORKLOAD_IN_RULE.exec(rule)?.[1] : undefined;

  // the policy that carries the statements (found by this node's tags in the compartment)
  let count: number | undefined;
  let wildcard: boolean | undefined;
  const listed = await listAll(ctx, { service: "identity", region: node.region || ctx.region, method: "GET", path: ociPath("identity", "policies"), query: { compartmentId: ctx.session.compartmentOcid } }, arrayOrItems);
  if (listed.ok && !listed.truncated) {
    const mine = listed.items.filter((p) => !isGone(p) && tagsOf(p)[TAG_ENV] === ctx.environmentId && tagsOf(p)[TAG_RESOURCE] === node.address);
    const statements = mine.flatMap((p) => asArray(asRecord(p)?.statements)).filter((s): s is string => typeof s === "string");
    count = statements.length;
    wildcard = statements.some((s) => MANAGE_ALL.test(s) || ANY_ALL_RESOURCES.test(s));
  }
  return observationOf(ctx, node, ID, located, attributesOf(at, { workload, statementCount: count, wildcardPolicy: wildcard }), { name: located.item.name, lifecycleState: located.item.lifecycleState });
}

export const identityDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "identity",
  nativeType: DYNAMIC_GROUP_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true }),
  compile: compileIdentity,
  observe: observeIdentity,
  expectedAttributes: identityExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: identityExpected(node), now: ctx.now() }),
};
