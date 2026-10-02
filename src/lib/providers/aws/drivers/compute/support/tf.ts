/**
 * Fragment-building helpers shared by the compute drivers.
 *
 * Why this exists: a `.tf.json` string is an HCL *template*. `${…}` inside it
 * is an interpolation, so any manifest-derived text that reaches a fragment
 * unescaped is executable configuration. The assembler refuses the worst
 * (file(), path.*), but the only safe rule is structural:
 *
 *   - every plain string in a fragment body is escaped (`${` → `$${`,
 *     `%{` → `%%{`) by `render()`;
 *   - the ONLY way to put an interpolation into a body is a `TfRef` (a
 *     reference built from `ctx.ref(...)` or a label this module's callers
 *     computed from a node address), or a `TfCat` that mixes text and refs.
 *
 * So a driver cannot forget to escape: bodies go through `render()` once, in
 * `FragmentBuilder`. JSON documents that tofu receives as a string (ECS
 * `container_definitions`, IAM policies, ECR lifecycle policies) are built as
 * plain objects and serialized with `renderJsonText()`, which renders first
 * and stringifies second.
 *
 * Limits: a `TfRef` embedded in JSON TEXT must evaluate to something with no
 * quote, backslash or newline (ARNs, names, ids — true for every reference the
 * compute drivers make); that is asserted for the expression itself, not for
 * its value.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import { AWS_ROLE_BOUNDARIES, trustedAwsBoundaryArn, type AwsRoleFamily } from "@/lib/credentials/aws/naming";
import type { ResourceNode } from "@/lib/resources/types";
import { bareExpr, tfLiteral, FragmentBuilder as SharedFragmentBuilder } from "@/lib/providers/aws/drivers/shared";

export class ComputeCompileError extends Error {
  readonly code: "invalid_spec" | "missing_neighbour" | "unsupported" | "invalid_reference";
  constructor(code: ComputeCompileError["code"], message: string) {
    super(message);
    this.name = "ComputeCompileError";
    this.code = code;
  }
}

/* ------------------------------ escaping / refs --------------------------- */

/** Escape text so HCL renders it literally. */
// Replacer FUNCTIONS, not strings: in a replacement string `$$` means one literal `$`,
// so `"$${"` would silently turn `${` into `${` again and escape nothing.
export const escapeTemplate = tfLiteral;

/**
 * Template text that has ALREADY been rendered (a JSON document with its
 * interpolations in place). `render` passes it through untouched: rendering it
 * a second time would escape the interpolations and turn every reference into
 * literal text.
 */
export class TfText {
  constructor(readonly text: string) {}
}

/** A reference: an HCL expression that is meant to be evaluated, not printed. */
export class TfRef {
  constructor(readonly expr: string) {}
}

/** Text mixed with references: `cat("arn:", partition, ":logs:…")`. */
export class TfCat {
  constructor(readonly parts: readonly (string | TfRef)[]) {}
}

const SAFE_EXPR = /^[A-Za-z0-9_.\-\[\]*()"', /:?<>=!&|+%]+$/;

/** A generator-owned expression. Refuses template openers, newlines and anything outside a conservative alphabet. */
export function rawRef(expr: string): TfRef {
  if (!SAFE_EXPR.test(expr) || expr.includes("${") || expr.includes("%{") || expr.includes("\n")) {
    throw new ComputeCompileError("invalid_reference", `Refusing expression "${expr.slice(0, 80)}": not a plain reference.`);
  }
  return new TfRef(expr);
}

export const cat = (...parts: (string | TfRef)[]): TfCat => new TfCat(parts);

/**
 * `ctx.ref(address, attribute)` normalized to a bare expression. The context
 * may return `aws_x.y.attr` or `${aws_x.y.attr}`; both come out as a `TfRef`.
 */
export function refOf(ctx: CompileContext, address: string, attribute: string): TfRef {
  return rawRef(bareExpr(ctx.ref(address, attribute).trim()).trim());
}

/** `depends_on` wants a whole object (`aws_x.y`), not an attribute path. */
export function dependsOnTarget(ref: TfRef): string {
  const parts = ref.expr.split(".");
  if (parts[0] === "data") return parts.slice(0, 3).join(".");
  return parts.slice(0, 2).join(".");
}

function interpolation(ref: TfRef, json: boolean): string {
  // Inside JSON TEXT a value with a quote or backslash would break the document.
  if (json && /["\\]/.test(ref.expr)) throw new ComputeCompileError("invalid_reference", `Expression "${ref.expr.slice(0, 80)}" cannot be embedded in JSON text.`);
  return `\${${ref.expr}}`;
}

/** Deep-render a value: text is escaped, refs become `${expr}`, `undefined` members are dropped. */
export function render(value: unknown, json = false): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return escapeTemplate(value);
  if (value instanceof TfText) return value.text;
  if (value instanceof TfRef) return interpolation(value, json);
  if (value instanceof TfCat) return value.parts.map((p) => (typeof p === "string" ? escapeTemplate(p) : interpolation(p, json))).join("");
  if (Array.isArray(value)) return value.map((v) => render(v, json) ?? null);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = render(v, json);
      if (r !== undefined) out[escapeTemplate(k)] = r;
    }
    return out;
  }
  throw new ComputeCompileError("invalid_spec", `Cannot render a ${typeof value} into a tofu fragment.`);
}

/**
 * A JSON document handed to tofu as a string. Refs inside become
 * interpolations, so they must not evaluate to text containing quotes.
 */
export function renderJsonText(value: unknown): TfText {
  return new TfText(JSON.stringify(render(value, true)));
}

/* ---------------------------------- tags ---------------------------------- */

/** Tags for a taggable resource: `ctx.tags` + `zenith:resource` (+ `Name`), keys sorted. */
export function tagsFor(ctx: CompileContext, node: ResourceNode, name?: string): Record<string, string> {
  // Raw values on purpose: `render()` escapes every string in a body exactly once. The shared
  // `resourceTags` now escapes template text itself (for builders that do not render), which
  // would escape a hostile value twice here.
  const tags: Record<string, string> = { ...ctx.tags, "zenith:resource": node.address, ...(name !== undefined ? { Name: name } : {}) };
  return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/* ----------------------------- fragment builder --------------------------- */

/**
 * Wraps the shared `FragmentBuilder` (shared/fragment.ts: primary address
 * first, locals for published attributes) with the rendering layer above:
 * bodies are escaped and refs interpolated exactly once, here.
 */
export class Frag {
  readonly inner: SharedFragmentBuilder;
  constructor(readonly nodeAddress: string) {
    this.inner = new SharedFragmentBuilder(nodeAddress);
  }

  resource(type: string, label: string, body: Record<string, unknown>): TfRef {
    this.inner.resource(type, label, render(body) as Record<string, unknown>);
    return new TfRef(`${type}.${label}`);
  }

  data(type: string, label: string, body: Record<string, unknown>): TfRef {
    this.inner.data(type, label, render(body) as Record<string, unknown>);
    return new TfRef(`data.${type}.${label}`);
  }

  output(name: string, value: unknown, opts: { sensitive?: boolean; description?: string } = {}): void {
    this.inner.output(name, render(value), opts);
  }

  /** Publish an attribute of this node for other nodes' `ctx.ref(address, attribute)`. */
  expose(attribute: string, value: TfRef): void {
    this.inner.expose(attribute, value.expr);
  }

  /**
   * `primary` is moved to the front of `addresses`: the orchestrator may
   * resolve a native attribute (`id`, `arn`) on `addresses[0]` (shared/refs.ts).
   */
  build(primary: TfRef): TofuFragment {
    const fragment = this.inner.build();
    const first = primary.expr;
    if (!fragment.addresses.includes(first)) throw new ComputeCompileError("invalid_spec", `primary address ${first} is not defined by ${this.nodeAddress}.`);
    return { ...fragment, addresses: [first, ...fragment.addresses.filter((a) => a !== first)] };
  }
}

/** `aws_x.y` + `.attr` as a ref. */
export const attr = (of: TfRef, name: string): TfRef => new TfRef(`${of.expr}.${name}`);

/* ------------------------------- IAM policies ----------------------------- */

export interface PolicyStatement {
  Sid?: string;
  Effect: "Allow";
  /** resource policies only (bucket policies) */
  Principal?: Record<string, unknown>;
  Action: string[];
  Resource: (string | TfRef | TfCat)[];
  Condition?: Record<string, Record<string, unknown>>;
  /**
   * Why a `*` appears in a Resource. Stripped from the rendered policy.
   * Unset means the statement must contain no wildcard at all.
   */
  wildcard?: "registry_token" | "log_stream" | "object_keys";
}

/** The one statement AWS requires a bare `"*"` resource for. */
export const ECR_TOKEN_ACTION = "ecr:GetAuthorizationToken";

const textOf = (r: string | TfRef | TfCat): string => {
  if (typeof r === "string") return r;
  if (r instanceof TfRef) return `\${${r.expr}}`;
  return r.parts.map((p) => (typeof p === "string" ? p : `\${${p.expr}}`)).join("");
};

/**
 * Least-privilege self-check run at compile time, so a regression fails the
 * plan rather than shipping a wildcard policy:
 *   - no action contains `*`;
 *   - a resource containing `*` needs a declared reason;
 *   - a bare `"*"` resource is allowed ONLY for ecr:GetAuthorizationToken, the
 *     one IAM action AWS defines no resource-level permission for;
 *   - `log_stream` / `object_keys` wildcards must be a trailing suffix pattern
 *     (`…:log-stream:ecs/web/*`, `arn…/source/*`), never an interior or bare `*`.
 */
export function assertLeastPrivilege(statements: readonly PolicyStatement[], where: string): void {
  for (const st of statements) {
    for (const a of st.Action) {
      if (a.includes("*")) throw new ComputeCompileError("invalid_spec", `${where}: wildcard action "${a}" is not allowed.`);
    }
    for (const res of st.Resource) {
      const t = textOf(res);
      if (!t.includes("*")) continue;
      if (t === "*") {
        if (st.wildcard !== "registry_token" || st.Action.length !== 1 || st.Action[0] !== ECR_TOKEN_ACTION) {
          throw new ComputeCompileError("invalid_spec", `${where}: bare "*" resource is only allowed for ${ECR_TOKEN_ACTION}.`);
        }
        continue;
      }
      if (!st.wildcard || st.wildcard === "registry_token") throw new ComputeCompileError("invalid_spec", `${where}: resource "${t}" contains an undeclared wildcard.`);
      if (t.indexOf("*") !== t.length - 1) throw new ComputeCompileError("invalid_spec", `${where}: wildcard must be the trailing suffix of "${t}".`);
    }
  }
}

/** Render statements to the JSON text of an IAM policy document (after the least-privilege check). */
export function policyJson(statements: readonly PolicyStatement[], where: string): TfText {
  assertLeastPrivilege(statements, where);
  return renderJsonText({
    Version: "2012-10-17",
    Statement: statements.map(({ wildcard: _w, ...st }) => ({
      ...st,
      Resource: st.Resource.length === 1 ? st.Resource[0] : st.Resource,
      Action: st.Action.length === 1 ? st.Action[0] : st.Action,
    })),
  });
}

/** Trust policy text for a service principal. */
export function assumeRoleJson(servicePrincipal: string): TfText {
  return renderJsonText({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: servicePrincipal }, Action: "sts:AssumeRole" }],
  });
}

/* ------------------------------- environment ------------------------------ */

/**
 * The `aws_caller_identity` / `aws_partition` data sources every compute
 * fragment needs to build exact ARNs (log groups, task definitions) and the
 * permissions-boundary ARN. One pair per node: labels are node-scoped because
 * the assembler refuses a data address defined by two fragments.
 */
export interface Env {
  partition: TfRef;
  account: TfRef;
  region: string;
}

export function environmentData(b: Frag, label: string, region: string): Env {
  const partition = b.data("aws_partition", label, {});
  const account = b.data("aws_caller_identity", label, {});
  return { partition: attr(partition, "partition"), account: attr(account, "account_id"), region };
}

/** The permissions boundary every role Zenith creates carries (DRIVER-CONVENTIONS.md, IAM). */
export const boundaryArn = (env: Env, family: AwsRoleFamily = "app", ctx?: Pick<CompileContext, "awsBootstrap">): TfCat | string =>
  trustedAwsBoundaryArn(ctx?.awsBootstrap, family) ?? cat("arn:", env.partition, ":iam::", env.account, `:policy/${AWS_ROLE_BOUNDARIES[family].policyName}`);

/** `arn:<partition>:<service>:<region>:<account>:<resource>` */
export const arnOf = (env: Env, service: string, resource: string | (string | TfRef)[], opts: { region?: boolean } = {}): TfCat =>
  cat("arn:", env.partition, `:${service}:`, opts.region === false ? "" : env.region, ":", env.account, ":", ...(Array.isArray(resource) ? resource : [resource]));
