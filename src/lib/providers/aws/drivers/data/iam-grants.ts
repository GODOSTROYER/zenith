/**
 * `IdentitySpec.grants` → exact IAM statements (ADR least privilege).
 *
 * A grant names ONE target node and explicit, portable verbs
 * (`read`, `write`, `list`, `delete`, `publish`, `consume`, `pull`, `logs`,
 * `read_credentials`, `connect`). This module turns each (target kind, verb)
 * into explicit IAM actions on the target's exact ARN(s), through one table
 * (`GRANT_RULES`) the tests walk row by row.
 *
 * Non-negotiables, enforced at compile time (a violation throws
 * `DriverCompileError`, it is never downgraded):
 *   - no wildcard action (`*`, `s3:*`, `s3:Get*`), ever;
 *   - no `Resource: "*"`, and no ARN whose only specific part is a wildcard
 *     (`arn:aws:s3:::*`); the ONLY wildcards emitted are the intrinsic suffixes
 *     of one resource's own sub-resources (`<bucket arn>/*` for its objects,
 *     `<log group arn>:*` for its streams);
 *   - an unknown verb for a target kind, a target that is not in the graph, or a
 *     `referenced` target whose ARN cannot be determined, is refused rather
 *     than approximated.
 *
 * Resource ARNs come from `ctx.ref(target, "arn")` (the target's driver
 * publishes it) for nodes Zenith manages, and from the node's `externalRef`
 * (validated as a wildcard-free ARN) for `referenced` ones.
 *
 * Known gap, by design: `ecr:GetAuthorizationToken` cannot be scoped to a
 * resource, so it would need `Resource: "*"`, which this compiler forbids. A
 * `pull` grant therefore yields the repository-scoped image actions only; the
 * ECS task execution role (owned by the compute driver) performs the
 * registry login.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { IdentityGrant } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { bareExpr, DriverCompileError, isArnOf, nodeKindPrefix, parseArn, refExpr, REF } from "@/lib/providers/aws/drivers/shared";
import { configOf, interp } from "./support";

export type GrantTargetKind = "object_store" | "queue" | "secret" | "log_group" | "container_registry" | "postgres" | "mysql" | "redis";

/** Where on the target an action applies. */
export type ResourceShape =
  | "self" //              the resource's own ARN
  | "objects" //           `<arn>/*`: objects inside a bucket
  | "streams" //           `<arn>:*`: log streams inside a log group
  | "group_and_streams" // both `<arn>` and `<arn>:*`
  | "master_secret" //     the RDS-managed master credential's secret ARN
  | "db_user" //           `rds-db` dbuser ARN for IAM database authentication
  | "cache_connect"; //    the replication group ARN and the IAM user ARN

export interface GrantRule {
  /** statement id fragment, alphanumeric */
  sid: string;
  actions: readonly string[];
  on: ResourceShape;
}

const SECRET_READ = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"] as const;

/**
 * The mapping table: target kind → verb → rules. Every action is explicit;
 * `tests/providers/aws/drivers/data/iam-role.test.ts` asserts the table has no
 * wildcard and that compiled policies equal it.
 */
export const GRANT_RULES: Readonly<Record<GrantTargetKind, Readonly<Record<string, readonly GrantRule[]>>>> = {
  object_store: {
    read: [{ sid: "ReadObjects", actions: ["s3:GetObject"], on: "objects" }],
    list: [{ sid: "ListBucket", actions: ["s3:ListBucket"], on: "self" }],
    write: [{ sid: "WriteObjects", actions: ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObject"], on: "objects" }],
    delete: [{ sid: "DeleteObjects", actions: ["s3:DeleteObject"], on: "objects" }],
  },
  queue: {
    publish: [{ sid: "Publish", actions: ["sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"], on: "self" }],
    consume: [{ sid: "Consume", actions: ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ReceiveMessage"], on: "self" }],
  },
  secret: {
    read: [{ sid: "ReadSecret", actions: SECRET_READ, on: "self" }],
  },
  log_group: {
    write: [{ sid: "WriteLogs", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], on: "streams" }],
    logs: [{ sid: "ReadLogs", actions: ["logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents"], on: "group_and_streams" }],
  },
  container_registry: {
    pull: [{ sid: "PullImages", actions: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], on: "self" }],
  },
  postgres: {
    read_credentials: [{ sid: "ReadMasterCredential", actions: SECRET_READ, on: "master_secret" }],
    connect: [{ sid: "ConnectIamAuth", actions: ["rds-db:connect"], on: "db_user" }],
  },
  mysql: {
    read_credentials: [{ sid: "ReadMasterCredential", actions: SECRET_READ, on: "master_secret" }],
    connect: [{ sid: "ConnectIamAuth", actions: ["rds-db:connect"], on: "db_user" }],
  },
  redis: {
    connect: [{ sid: "ConnectIamAuth", actions: ["elasticache:Connect"], on: "cache_connect" }],
  },
};

export const GRANT_TARGET_KINDS = Object.keys(GRANT_RULES) as GrantTargetKind[];
const isTargetKind = (k: string): k is GrantTargetKind => Object.prototype.hasOwnProperty.call(GRANT_RULES, k);

/** The IAM database user the `connect` grant names; the user itself is created in the database (`database.migrate`), not here. */
export const DEFAULT_IAM_DB_USER = "zenith_app";
const DB_USER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export interface PolicyStatement {
  sid: string;
  actions: string[];
  /** literal ARNs or `${…}` templates built from `ctx.ref` */
  resources: string[];
}

/** Account and partition expressions the identity fragment defines as data sources. */
export interface AccountRefs {
  partition: string;
  accountId: string;
}

const WILDCARD_CHARS = /[*?]/;
/** `arn:aws:s3:::*`-style: a whole resource type wildcarded. */
const BARE_SERVICE_WILDCARD = /^arn:[^:]*:[^:]*:[^:]*:[^:]*:\*$/;

function refuse(address: string, message: string): never {
  throw new DriverCompileError("policy_refused", address, message);
}

/** Throws unless every statement has explicit actions and a non-wildcard resource list. */
export function assertNoWildcards(address: string, statements: readonly PolicyStatement[]): void {
  for (const s of statements) {
    if (s.actions.length === 0) refuse(address, `statement ${s.sid} has no actions.`);
    if (s.resources.length === 0) refuse(address, `statement ${s.sid} has no resources.`);
    for (const a of s.actions) if (WILDCARD_CHARS.test(a)) refuse(address, `statement ${s.sid} has the wildcard action "${a}"; grants compile to explicit actions only.`);
    for (const r of s.resources) {
      if (r === "*" || BARE_SERVICE_WILDCARD.test(r)) refuse(address, `statement ${s.sid} has the wildcard resource "${r}"; grants compile to exact ARNs only.`);
    }
  }
}

/** The kind of a grant target: the node's own kind when it is in the graph, else the address prefix. */
function targetKindOf(identity: ResourceNode, ctx: CompileContext, grant: IdentityGrant): { node: ResourceNode; kind: GrantTargetKind } {
  if (typeof grant.target !== "string" || grant.target === "" || WILDCARD_CHARS.test(grant.target)) {
    refuse(identity.address, `a grant target must be one exact node address, got "${String(grant.target).slice(0, 40)}".`);
  }
  const node = ctx.node(grant.target);
  if (!node) throw new DriverCompileError("missing_node", identity.address, `grant target ${grant.target} is not in the graph.`);
  const kind = node.kind === "provider_native" ? nodeKindPrefix(node.address) : node.kind;
  if (!isTargetKind(kind)) {
    throw new DriverCompileError("unsupported", identity.address, `grants to ${grant.target} (kind ${node.kind}) are not supported: no IAM mapping exists for that kind.`);
  }
  return { node, kind };
}

/**
 * The characters an exact ARN of an AWS resource can contain. Deliberately
 * excludes `$ { } % * ? " \` and whitespace: an `externalRef` is user-supplied
 * text that lands inside an HCL template, so anything that could open an
 * interpolation, widen a policy or break out of a string is refused.
 */
const EXACT_ARN = /^arn:[a-z-]+:[a-z0-9-]+:[a-z0-9-]*:(?:\d{12})?:[A-Za-z0-9_+=,.@:/!-]+$/;

/** A `referenced` node's ARN, validated as an exact, template-safe, wildcard-free ARN of `service`. */
function literalArn(identity: ResourceNode, target: ResourceNode, service: string): string {
  const ref = target.externalRef;
  if (ref === undefined || !EXACT_ARN.test(ref) || !isArnOf(ref, service) || parseArn(ref) === undefined) {
    throw new DriverCompileError("missing_node", identity.address, `${target.address} is ${target.ownership} and its externalRef is not an exact ${service} ARN, so a grant to it cannot be compiled.`);
  }
  return ref;
}

const SERVICE_OF: Record<GrantTargetKind, string> = {
  object_store: "s3",
  queue: "sqs",
  secret: "secretsmanager",
  log_group: "logs",
  container_registry: "ecr",
  postgres: "rds",
  mysql: "rds",
  redis: "elasticache",
};

/** `${expr}` for the target's ARN: a tofu reference when managed, the validated literal otherwise. */
function arnOf(identity: ResourceNode, ctx: CompileContext, target: ResourceNode, kind: GrantTargetKind): string {
  if (target.ownership === "managed") return refExpr(ctx.ref(target.address, REF.arn));
  return literalArn(identity, target, SERVICE_OF[kind]);
}

function resourcesFor(on: ResourceShape, identity: ResourceNode, ctx: CompileContext, target: ResourceNode, kind: GrantTargetKind, acct: AccountRefs): string[] {
  switch (on) {
    case "self":
      return [arnOf(identity, ctx, target, kind)];
    case "objects":
      return [`${arnOf(identity, ctx, target, kind)}/*`];
    case "streams":
    case "group_and_streams": {
      // A log group ARN may or may not carry a trailing `:*` depending on provider version and source; normalize.
      const arn = arnOf(identity, ctx, target, kind);
      const base = arn.startsWith("${") ? interp(`trimsuffix(${bareExpr(arn)}, ":*")`) : arn.replace(/:\*$/, "");
      return on === "streams" ? [`${base}:*`] : [base, `${base}:*`];
    }
    case "master_secret":
      if (target.ownership !== "managed") {
        throw new DriverCompileError("unsupported", identity.address, `${target.address} is ${target.ownership}: its master credential's secret ARN is unknown, so read_credentials cannot be compiled. Grant the secret node directly.`);
      }
      return [refExpr(ctx.ref(target.address, "master_user_secret_arn"))];
    case "db_user": {
      if (target.ownership !== "managed") {
        throw new DriverCompileError("unsupported", identity.address, `${target.address} is ${target.ownership}: its DBI resource id is unknown, so an rds-db:connect grant cannot be compiled.`);
      }
      if (!/^[a-z0-9-]{3,40}$/.test(target.region)) throw new DriverCompileError("invalid_spec", target.address, "the node's region is not a region name.");
      const user = configOf(target).iamDbUser;
      const dbUser = typeof user === "string" ? user : DEFAULT_IAM_DB_USER;
      if (!DB_USER.test(dbUser)) throw new DriverCompileError("invalid_spec", target.address, "config.iamDbUser is not a valid database user name.");
      return [`arn:${acct.partition}:rds-db:${target.region}:${acct.accountId}:dbuser:${refExpr(ctx.ref(target.address, "resource_id"))}/${dbUser}`];
    }
    case "cache_connect": {
      if (target.ownership !== "managed") {
        throw new DriverCompileError("unsupported", identity.address, `${target.address} is ${target.ownership}: its IAM user ARN is unknown, so an elasticache:Connect grant cannot be compiled.`);
      }
      return [refExpr(ctx.ref(target.address, REF.arn)), refExpr(ctx.ref(target.address, "iam_user_arn"))];
    }
  }
}

const pascal = (s: string): string =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");

/**
 * All statements for an identity's grants, deterministic: grants sorted by
 * target, verbs sorted, rules of one (target, shape) merged, statements sorted
 * by id. Throws `DriverCompileError` on anything it cannot express exactly.
 */
export function compileGrantStatements(identity: ResourceNode, ctx: CompileContext, grants: readonly IdentityGrant[], acct: AccountRefs): PolicyStatement[] {
  const out: PolicyStatement[] = [];
  const usedSids = new Set<string>();
  for (const grant of [...grants].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))) {
    const { node: target, kind } = targetKindOf(identity, ctx, grant);
    const verbs = [...new Set(grant.access)].sort();
    if (verbs.length === 0) refuse(identity.address, `the grant to ${grant.target} lists no access verbs.`);
    const rules = GRANT_RULES[kind];
    const byShape = new Map<ResourceShape, { sids: string[]; actions: Set<string> }>();
    for (const verb of verbs) {
      const matched = Object.prototype.hasOwnProperty.call(rules, verb) ? rules[verb] : undefined;
      if (!matched) {
        throw new DriverCompileError("unsupported", identity.address, `the verb "${String(verb).slice(0, 30)}" is not supported on ${kind} (${grant.target}); supported: ${Object.keys(rules).join(", ")}.`);
      }
      for (const rule of matched) {
        const slot = byShape.get(rule.on) ?? { sids: [], actions: new Set<string>() };
        slot.sids.push(rule.sid);
        for (const a of rule.actions) slot.actions.add(a);
        byShape.set(rule.on, slot);
      }
    }
    for (const [shape, slot] of [...byShape.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      let sid = `${pascal(grant.target)}${slot.sids.map(pascal).join("")}`.slice(0, 100);
      for (let n = 2; usedSids.has(sid); n++) sid = `${sid.replace(/\d+$/, "")}${n}`;
      usedSids.add(sid);
      out.push({ sid, actions: [...slot.actions].sort(), resources: resourcesFor(shape, identity, ctx, target, kind, acct) });
    }
  }
  out.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  assertNoWildcards(identity.address, out);
  return out;
}

/**
 * The action set a grant list compiles to, from the spec alone (no graph, no
 * refs): the drift-comparable summary of the inline policy. Target kinds come
 * from address prefixes (`object_store/uploads`). Throws `DriverCompileError`
 * for an unsupported verb or kind, like compile does.
 */
export function expectedGrantActions(address: string, grants: readonly IdentityGrant[]): string[] {
  const actions = new Set<string>();
  for (const grant of grants) {
    const kind = nodeKindPrefix(String(grant.target));
    if (!isTargetKind(kind)) throw new DriverCompileError("unsupported", address, `grants to ${String(grant.target)} are not supported.`);
    for (const verb of grant.access) {
      const rules = GRANT_RULES[kind];
      const matched = Object.prototype.hasOwnProperty.call(rules, verb) ? rules[verb] : undefined;
      if (!matched) throw new DriverCompileError("unsupported", address, `the verb "${String(verb).slice(0, 30)}" is not supported on ${kind}.`);
      for (const rule of matched) for (const a of rule.actions) actions.add(a);
    }
  }
  return [...actions].sort();
}
