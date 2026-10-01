/**
 * `aws:iam_role` driver (kind `identity`): one least-privilege workload role.
 *
 * Compile:
 *   aws_iam_role          trust for the workload's service principal
 *                         (`ecs-tasks` for container services and scheduled
 *                         jobs, `lambda`, `codebuild`, `ec2`), constrained to
 *                         this account (`aws:SourceAccount`), and
 *                         `permissions_boundary` = the bootstrap
 *                         `ZenithWorkloadBoundary` policy
 *   aws_iam_role_policy   ONE inline policy compiled from
 *                         `IdentitySpec.grants` (see `iam-grants.ts`): exact
 *                         actions on exact ARNs, no wildcard action, no
 *                         `Resource: "*"`; compilation FAILS rather than emit one
 *   data sources          `aws_caller_identity`, `aws_partition` and the two
 *                         `aws_iam_policy_document`s (trust, grants)
 *
 * Permissions boundary: the workspace assembler cannot declare tofu
 * `variable`s (`TofuFragment` has no variable member), so the boundary ARN is
 * assembled in the fragment as
 * `arn:<partition>:iam::<account>:policy/ZenithWorkloadBoundary` from two data
 * sources instead of the `workload_permissions_boundary_arn` variable the
 * design named. The name is the platform convention (DRIVER-CONVENTIONS); the
 * policy is assumed to sit at path `/`. When the assembler grows a variable
 * channel only `boundaryArn()` below changes. The bootstrap template is not in
 * this repository, so the boundary's existence is NOT verified here.
 *
 * Observe: GetRole, ListRolePolicies + GetRolePolicy (policy documents are
 * URL-decoded and normalized to sorted actions), ListAttachedRolePolicies.
 * Reported: the trust principals, the boundary's policy NAME, the sorted set of
 * actions in Allow statements, whether any Allow statement uses a wildcard
 * action or resource, and the number of attached managed policies (Zenith
 * attaches none, so anything above 0 widened access outside Zenith).
 *
 * Honest limits: resource ARNs inside the policy are not compared (the desired
 * ARNs are tofu references, unknown without a plan), so a swapped resource
 * with the same actions is not reported as drift by `expectedAttributes`; the
 * action set, wildcard check, boundary and attachments are. `contract` evidence
 * only.
 */
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
  type Role,
} from "@aws-sdk/client-iam";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { IdentityGrant, IdentitySpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  cloudName,
  DriverCompileError,
  FragmentBuilder,
  isArnOf,
  nodeKindPrefix,
  nodeName,
  paginate,
  parseArn,
  REF,
  resourceTags,
  tfLabel,
} from "./_shared";
import {
  compileGrantStatements,
  expectedGrantActions,
  type AccountRefs,
  type PolicyStatement,
} from "./iam-grants";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  call,
  candidate,
  EMPTY_FRAGMENT,
  failAttributes,
  findByTags,
  guardObserve,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  safeTags,
  scalars,
  tagMap,
  verificationOf,
  type AwsDriverContext,
  type ReadResult,
} from "./support";

export const IAM_ROLE_SOURCE = "aws.iam_role@1";
export const PERMISSIONS_BOUNDARY_NAME = "ZenithWorkloadBoundary";
/** IAM caps the aggregate size of a role's inline policies at 10,240 characters (whitespace excluded). */
const MAX_INLINE_POLICY_CHARS = 10_000;

/** Service principal by the workload's node kind. */
export const TRUST_PRINCIPAL_BY_WORKLOAD: Readonly<Record<string, string>> = {
  container_service: "ecs-tasks.amazonaws.com",
  scheduled_job: "ecs-tasks.amazonaws.com",
  function: "lambda.amazonaws.com",
  build_pipeline: "codebuild.amazonaws.com",
  compute_instance: "ec2.amazonaws.com",
};

/** Trust principals that accept an `aws:SourceAccount` confused-deputy condition. */
const SOURCE_ACCOUNT_CAPABLE = new Set(["ecs-tasks.amazonaws.com", "lambda.amazonaws.com", "codebuild.amazonaws.com"]);

const ROLE_NAME = /^[\w+=,.@-]{1,64}$/;

export function readIdentitySpec(node: ResourceNode): IdentitySpec {
  const raw = node.spec as Partial<IdentitySpec>;
  if (typeof raw.workload !== "string" || raw.workload === "") throw new DriverCompileError("invalid_spec", node.address, "spec.workload must name the workload node this identity is for.");
  if (!Array.isArray(raw.grants)) throw new DriverCompileError("invalid_spec", node.address, "spec.grants must be a list.");
  for (const g of raw.grants) {
    if (g === null || typeof g !== "object" || typeof g.target !== "string" || !Array.isArray(g.access) || g.access.some((a) => typeof a !== "string")) {
      throw new DriverCompileError("invalid_spec", node.address, "each grant needs a target address and a list of access verbs.");
    }
  }
  return { principal: "workload", workload: raw.workload, grants: raw.grants as IdentityGrant[] };
}

/** The service principal that may assume the role, from the workload node's kind (or its address prefix). */
export function trustPrincipalFor(node: ResourceNode, ctx: Pick<CompileContext, "node">, workload: string): string {
  const kind = ctx.node(workload)?.kind ?? nodeKindPrefix(workload);
  const principal = TRUST_PRINCIPAL_BY_WORKLOAD[kind];
  if (!principal) throw new DriverCompileError("unsupported", node.address, `no trust principal is defined for a ${kind} workload (${workload}).`);
  return principal;
}

export const roleNameFor = (ctx: Pick<CompileContext, "namePrefix">, address: string): string => cloudName(ctx.namePrefix, `${nodeName(address)}-role`, 64);

/** The boundary policy ARN as a tofu template (see the module comment for why it is not a variable). */
function boundaryArn(acct: AccountRefs): string {
  return `arn:${acct.partition}:iam::${acct.accountId}:policy/${PERMISSIONS_BOUNDARY_NAME}`;
}

/** Characters an inline policy will occupy, estimated generously (40 per unresolved ARN). */
function estimatePolicyChars(statements: readonly PolicyStatement[]): number {
  let n = 40;
  for (const s of statements) {
    n += 80 + s.sid.length;
    for (const a of s.actions) n += a.length + 4;
    for (const r of s.resources) n += (r.includes("${") ? 130 : r.length) + 4;
  }
  return n;
}

export function compileIamRole(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const spec = readIdentitySpec(node);
  const label = tfLabel(node.address);
  const name = roleNameFor(ctx, node.address);
  const principal = trustPrincipalFor(node, ctx, spec.workload);
  const acct: AccountRefs = {
    partition: `\${data.aws_partition.${label}_partition.partition}`,
    accountId: `\${data.aws_caller_identity.${label}_account.account_id}`,
  };
  const statements = compileGrantStatements(node, ctx, spec.grants, acct);
  if (estimatePolicyChars(statements) > MAX_INLINE_POLICY_CHARS) {
    throw new DriverCompileError("unsupported", node.address, `the compiled inline policy would exceed IAM's ${MAX_INLINE_POLICY_CHARS}-character role limit (${statements.length} statements); split the workload.`);
  }

  const b = new FragmentBuilder(node.address);
  // Primary resource first: `addresses[0]` is what `ctx.ref` falls back to.
  b.resource("aws_iam_role", label, {
    name,
    description: `Zenith workload role for ${node.address.replace(/[^A-Za-z0-9/_.-]/g, "-")}`,
    assume_role_policy: `\${data.aws_iam_policy_document.${label}_trust.json}`,
    permissions_boundary: boundaryArn(acct),
    force_detach_policies: true,
    tags: safeTags(resourceTags(ctx.tags, node.address)),
  });
  if (statements.length > 0) {
    b.resource("aws_iam_role_policy", `${label}_grants`, {
      name: "zenith-grants",
      role: `\${aws_iam_role.${label}.id}`,
      policy: `\${data.aws_iam_policy_document.${label}_grants.json}`,
    });
  }
  b.data("aws_caller_identity", `${label}_account`, {});
  b.data("aws_partition", `${label}_partition`, {});
  b.data("aws_iam_policy_document", `${label}_trust`, {
    statement: [
      {
        sid: "AssumeByWorkload",
        effect: "Allow",
        actions: ["sts:AssumeRole"],
        principals: [{ type: "Service", identifiers: [principal] }],
        ...(SOURCE_ACCOUNT_CAPABLE.has(principal) ? { condition: [{ test: "StringEquals", variable: "aws:SourceAccount", values: [acct.accountId] }] } : {}),
      },
    ],
  });
  if (statements.length > 0) {
    b.data("aws_iam_policy_document", `${label}_grants`, {
      statement: statements.map((s) => ({ sid: s.sid, effect: "Allow", actions: s.actions, resources: s.resources })),
    });
  }

  b.expose(REF.arn, `aws_iam_role.${label}.arn`);
  b.expose(REF.id, `aws_iam_role.${label}.id`);
  b.expose("name", `aws_iam_role.${label}.name`);
  b.output(`${label}_arn`, `\${aws_iam_role.${label}.arn}`);
  b.output(`${label}_name`, `\${aws_iam_role.${label}.name}`);
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["permissionsBoundaryName", "trustPrincipals", "inlinePolicyActions", "wildcardAccess", "attachedPolicyCount"] as const;
const INFORMATIONAL_NAMES = ["inlinePolicyCount"] as const;
export const IAM_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedIamAttributes(node: ResourceNode): Record<string, unknown> {
  if (!isManaged(node)) return {};
  const out: Record<string, unknown> = { permissionsBoundaryName: PERMISSIONS_BOUNDARY_NAME, wildcardAccess: false, attachedPolicyCount: 0 };
  try {
    const spec = readIdentitySpec(node);
    out.inlinePolicyActions = expectedGrantActions(node.address, spec.grants);
    const workloadKind = nodeKindPrefix(spec.workload);
    const principal = TRUST_PRINCIPAL_BY_WORKLOAD[workloadKind];
    if (principal) out.trustPrincipals = [principal];
  } catch (err) {
    // An invalid spec has no defined action set; drift then compares only the fixed attributes instead of failing for every node.
    if (!(err instanceof DriverCompileError)) throw err;
  }
  return out;
}

export interface NormalizedStatement {
  effect: string;
  actions: string[];
  resources: string[];
  hasCondition: boolean;
  /** NotAction / NotResource make a statement broader than it reads; treated as wildcard access */
  negated: boolean;
}

const toList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** URL-decode (IAM returns documents percent-encoded), parse and normalize a policy document; `undefined` when unparseable. */
export function normalizePolicyDocument(raw: string | undefined): NormalizedStatement[] | undefined {
  if (raw === undefined) return undefined;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // not percent-encoded
  }
  try {
    const doc = JSON.parse(text) as { Statement?: unknown };
    const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    return list.map((s) => {
      const st = s as Record<string, unknown>;
      return {
        effect: typeof st.Effect === "string" ? st.Effect : "",
        actions: toList(st.Action).sort(),
        resources: toList(st.Resource).sort(),
        hasCondition: st.Condition !== undefined,
        negated: st.NotAction !== undefined || st.NotResource !== undefined,
      };
    });
  } catch {
    return undefined;
  }
}

export function summarizePolicies(docs: readonly NormalizedStatement[][]): { actions: string[]; wildcard: boolean } {
  const actions = new Set<string>();
  let wildcard = false;
  for (const doc of docs) {
    for (const s of doc) {
      if (s.effect !== "Allow") continue;
      for (const a of s.actions) {
        actions.add(a);
        if (/[*?]/.test(a)) wildcard = true;
      }
      if (s.resources.some((r) => r === "*") || s.negated) wildcard = true;
    }
  }
  return { actions: [...actions].sort(), wildcard };
}

/** Service principals in a trust policy document, sorted. */
export function trustPrincipalsOf(raw: string | undefined): string[] | undefined {
  const statements = normalizedTrust(raw);
  if (statements === undefined) return undefined;
  return [...new Set(statements)].sort();
}

function normalizedTrust(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // not percent-encoded
  }
  try {
    const doc = JSON.parse(text) as { Statement?: unknown };
    const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    const out: string[] = [];
    for (const s of list) {
      const st = s as { Effect?: string; Principal?: unknown };
      if (st.Effect !== "Allow" || st.Principal === undefined) continue;
      if (st.Principal === "*") {
        out.push("*");
        continue;
      }
      const p = st.Principal as { Service?: unknown; AWS?: unknown; Federated?: unknown };
      for (const svc of toList(p.Service)) out.push(svc);
      for (const other of [...toList(p.AWS), ...toList(p.Federated)]) out.push(other);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** ARN or bare name to the role name IAM calls take. */
export function roleNameOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    if (!isArnOf(externalId, "iam", "role")) return undefined;
    const last = (parseArn(externalId)?.resource ?? "").split("/").pop();
    return last && ROLE_NAME.test(last) ? last : undefined;
  }
  return ROLE_NAME.test(externalId) ? externalId : undefined;
}

async function resolveRoleName(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<{ name: string } | "missing" | { ambiguous: string }> {
  const name = roleNameOf(externalId);
  if (externalId !== undefined && externalId !== "" && name === undefined) return { ambiguous: "externalId is not an IAM role ARN or name" };
  if (name !== undefined) return { name };
  // IAM is global; its tagging index lives in us-east-1.
  const { matches } = await findByTags(ctx, node, "iam:role", { region: "us-east-1" });
  const names = matches.flatMap((m) => {
    const n = roleNameOf(m.arn);
    return n ? [n] : [];
  });
  if (names.length === 0) return "missing";
  if (names.length > 1) return { ambiguous: `${names.length} roles carry the Zenith tags for ${node.address}; refusing to choose one` };
  return { name: names[0] };
}

const MAX_INLINE_POLICIES = 10;

async function observeRole(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    IAM_ROLE_SOURCE,
    IAM_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const found = await resolveRoleName(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      const RoleName = found.name;
      const iam = ctx.session.client(IAMClient);

      const { Role: role } = await call(ctx, (o) => iam.send(new GetRoleCommand({ RoleName }), o));
      if (!role) return { kind: "missing", detail: "GetRole returned no role" };

      const a = new Attributes(ctx);
      const boundary = role.PermissionsBoundary?.PermissionsBoundaryArn;
      a.set("permissionsBoundaryName", boundary ? (boundary.split("/").pop() ?? "") : "none");
      const trust = trustPrincipalsOf(role.AssumeRolePolicyDocument);
      if (trust) a.set("trustPrincipals", trust);
      else a.unknown("trustPrincipals", "error", "the trust policy could not be parsed");

      const policyDocs: NormalizedStatement[][] = [];
      let inlineNames: string[] = [];
      try {
        const list = await call(ctx, (o) => iam.send(new ListRolePoliciesCommand({ RoleName }), o));
        inlineNames = (list.PolicyNames ?? []).slice(0, MAX_INLINE_POLICIES);
        let unparseable = false;
        for (const PolicyName of inlineNames) {
          const got = await call(ctx, (o) => iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }), o));
          const norm = normalizePolicyDocument(got.PolicyDocument);
          if (norm) policyDocs.push(norm);
          else unparseable = true;
        }
        if (unparseable || (list.PolicyNames?.length ?? 0) > MAX_INLINE_POLICIES || list.IsTruncated) {
          for (const n of ["inlinePolicyActions", "wildcardAccess"]) a.unknown(n, "error", "an inline policy could not be fully read");
        } else {
          const summary = summarizePolicies(policyDocs);
          a.set("inlinePolicyActions", summary.actions);
          a.set("wildcardAccess", summary.wildcard);
        }
        a.set("inlinePolicyCount", list.PolicyNames?.length ?? 0);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        failAttributes(a.out, ["inlinePolicyActions", "wildcardAccess", "inlinePolicyCount"], f);
      }

      try {
        const attached = await call(ctx, (o) => iam.send(new ListAttachedRolePoliciesCommand({ RoleName }), o));
        a.set("attachedPolicyCount", attached.AttachedPolicies?.length ?? 0);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        failAttributes(a.out, ["attachedPolicyCount"], f);
      }

      return {
        kind: "present",
        externalId: role.Arn ?? externalId ?? "",
        attributes: a.finish(IAM_ATTRIBUTE_NAMES),
        native: {
          roleName: role.RoleName ?? RoleName,
          path: role.Path,
          tags: tagMap(role.Tags),
          permissionsBoundaryArn: boundary,
          inlinePolicyNames: inlineNames,
          // Normalized, sorted statements; bounded and dropped first if the native bag is too large.
          inlinePolicies: policyDocs.map((d) => d.map((s) => ({ effect: s.effect, actions: s.actions, resources: s.resources }))),
        },
      };
    },
    ["tags", "roleName", "permissionsBoundaryArn"]
  );
}

/* -------------------------------- discover --------------------------------- */

const SKIPPED_ROLE = /^\/(aws-service-role|service-role|aws-reserved)\//;

async function discoverRoles(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const iam = ctx.session.client(IAMClient);
  const { items } = await paginate(
    async (marker) => {
      const out = await call(ctx, (o) => iam.send(new ListRolesCommand({ MaxItems: 100, ...(marker ? { Marker: marker } : {}) }), o));
      return { items: out.Roles ?? [], next: out.IsTruncated ? out.Marker : undefined };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  const roles = items.filter((r: Role) => r.RoleName && r.Arn && !SKIPPED_ROLE.test(r.Path ?? "/") && !r.RoleName.startsWith("AWSReservedSSO_"));
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const r of roles) {
    let tags: Record<string, string> | undefined;
    if (reads < MAX_TAG_READS) {
      reads++;
      try {
        tags = tagMap((await call(ctx, (o) => iam.send(new ListRoleTagsCommand({ RoleName: r.RoleName }), o))).Tags);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
      }
    }
    found.push(
      candidate(ctx, {
        kind: "identity",
        nativeType: "aws:iam_role",
        externalId: r.Arn as string,
        name: r.RoleName as string,
        // IAM is global; the region is the session's.
        ...(tags ? { tags } : {}),
        attributes: scalars({ path: r.Path, tagsRead: tags !== undefined, hasBoundary: r.PermissionsBoundary?.PermissionsBoundaryArn !== undefined }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const iamRoleDriver: ResourceDriver<AwsSession> = {
  id: IAM_ROLE_SOURCE,
  provider: "aws",
  kind: "identity",
  nativeType: "aws:iam_role",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileIamRole,
  observe: observeRole,
  expectedAttributes: expectedIamAttributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "boundary_attached", `the ${PERMISSIONS_BOUNDARY_NAME} permissions boundary is attached`, "permissionsBoundaryName", (v) => v === PERMISSIONS_BOUNDARY_NAME),
      attrCheck(observation, "no_wildcard_access", "no Allow statement uses a wildcard action or resource", "wildcardAccess", (v) => v === false),
      attrCheck(observation, "no_managed_policies", "no managed policy is attached outside Zenith's grants", "attachedPolicyCount", (v) => v === 0),
      matchesExpectedCheck(expectedIamAttributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverRoles,
};

