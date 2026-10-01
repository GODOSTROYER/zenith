/**
 * A small CloudFormation reader/evaluator for the static checks on
 * `deploy/aws/zenith-connection.cfn.yaml`.
 *
 * `loadTemplate` parses YAML with the CloudFormation short-form tags (!Ref,
 * !Sub, !GetAtt, !If, …) mapped to their long forms. `evaluate` resolves the
 * intrinsic functions this template actually uses (Ref, Fn::Sub, Fn::GetAtt,
 * Fn::Join, Fn::If, Fn::Equals, Fn::Not, Fn::And, Fn::Or, Condition) against a
 * chosen set of parameter values, so tests can inspect the exact IAM policy
 * documents CloudFormation would send to IAM — for several parameter sets.
 *
 * It is deliberately NOT a general CloudFormation engine: an intrinsic it
 * does not implement throws, so an unsupported construct fails a test loudly
 * instead of being silently skipped.
 */
import fs from "node:fs";
import yaml from "js-yaml";

const TAGS = [
  "Ref", "Sub", "GetAtt", "If", "Join", "Equals", "Not", "And", "Or", "Select", "Split", "FindInMap",
  "Condition", "ImportValue", "Base64", "Cidr", "GetAZs", "Transform", "Length", "ToJsonString",
] as const;

const long = (tag: string): string => (tag === "Ref" || tag === "Condition" ? tag : `Fn::${tag}`);

const types = TAGS.flatMap((tag) =>
  (["scalar", "sequence", "mapping"] as const).map(
    (kind) =>
      new yaml.Type(`!${tag}`, {
        kind,
        construct: (data: unknown) => {
          if (tag === "GetAtt" && typeof data === "string") {
            const dot = data.indexOf(".");
            return { "Fn::GetAtt": [data.slice(0, dot), data.slice(dot + 1)] };
          }
          return { [long(tag)]: data };
        },
      })
  )
);

export const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend(types);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export interface Template {
  Parameters: Record<string, { Type: string; Default?: string; AllowedPattern?: string; AllowedValues?: string[] }>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string }>;
  Outputs: Record<string, { Value: unknown; Condition?: string }>;
  Rules?: Record<string, unknown>;
  [k: string]: unknown;
}

export function loadTemplate(path: string): Template {
  return yaml.load(fs.readFileSync(path, "utf8"), { schema: CFN_SCHEMA }) as Template;
}

export const NOVALUE = Symbol("AWS::NoValue");

export interface EvalOptions {
  params?: Record<string, string | string[]>;
  /** pseudo parameters */
  pseudo?: { partition: string; accountId: string; region: string; urlSuffix?: string };
  /** force a condition's value (used when generating the OpenTofu templates) */
  forceConditions?: Record<string, boolean>;
  /** override what `Ref`/`GetAtt` return for a resource (used when generating the OpenTofu templates) */
  resourceOverrides?: Record<string, { ref?: string; attrs?: Record<string, string> }>;
  /** parameter overrides that bypass defaults with raw tokens (used when generating the OpenTofu templates) */
  tokenParams?: Record<string, string>;
}

export interface Evaluator {
  evaluate(node: unknown): unknown;
  condition(name: string): boolean;
  resourceRef(name: string): string;
}

const DEFAULT_PSEUDO = { partition: "aws", accountId: "123456789012", region: "ap-south-1" };

export function makeEvaluator(template: Template, options: EvalOptions = {}): Evaluator {
  const pseudo = options.pseudo ?? DEFAULT_PSEUDO;
  const params: Record<string, string | string[]> = {};
  for (const [name, def] of Object.entries(template.Parameters)) {
    const raw = options.params?.[name] ?? def.Default ?? "";
    params[name] = def.Type === "CommaDelimitedList" && typeof raw === "string" ? raw.split(",").map((s) => s.trim()) : raw;
  }
  for (const [name, token] of Object.entries(options.tokenParams ?? {})) params[name] = token;

  const conditionCache = new Map<string, boolean>();
  const resourceRefs = new Map<string, string>();
  const resourceAttrs = new Map<string, Record<string, string>>();

  const ev: Evaluator = { evaluate, condition, resourceRef };

  function pseudoValue(name: string): string | typeof NOVALUE {
    switch (name) {
      case "AWS::Partition":
        return pseudo.partition;
      case "AWS::AccountId":
        return pseudo.accountId;
      case "AWS::Region":
        return pseudo.region;
      case "AWS::URLSuffix":
        return options.pseudo?.urlSuffix ?? (pseudo.partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com");
      case "AWS::NoValue":
        return NOVALUE;
      default:
        throw new Error(`Unsupported pseudo parameter ${name}`);
    }
  }

  function condition(name: string): boolean {
    if (options.forceConditions && name in options.forceConditions) return options.forceConditions[name];
    const hit = conditionCache.get(name);
    if (hit !== undefined) return hit;
    const def = template.Conditions[name];
    if (def === undefined) throw new Error(`Unknown condition ${name}`);
    const v = truthy(evaluate(def));
    conditionCache.set(name, v);
    return v;
  }

  function truthy(v: unknown): boolean {
    if (typeof v !== "boolean") throw new Error(`Condition did not evaluate to a boolean: ${String(v)}`);
    return v;
  }

  function resourceRef(name: string): string {
    if (options.resourceOverrides?.[name]?.ref !== undefined) return options.resourceOverrides[name].ref!;
    const cached = resourceRefs.get(name);
    if (cached) return cached;
    const res = template.Resources[name];
    if (!res) throw new Error(`Ref to unknown resource ${name}`);
    const p = res.Properties ?? {};
    const str = (key: string): string => String(evaluate(p[key]));
    let ref: string;
    let attrs: Record<string, string> = {};
    const { partition, accountId } = pseudo;
    switch (res.Type) {
      case "AWS::IAM::ManagedPolicy":
        ref = `arn:${partition}:iam::${accountId}:policy/${str("ManagedPolicyName")}`;
        break;
      case "AWS::IAM::Role":
        ref = str("RoleName");
        attrs = { Arn: `arn:${partition}:iam::${accountId}:role/${ref}` };
        break;
      case "AWS::S3::Bucket":
        ref = str("BucketName");
        attrs = { Arn: `arn:${partition}:s3:::${ref}` };
        break;
      case "AWS::IAM::OIDCProvider":
        ref = `arn:${partition}:iam::${accountId}:oidc-provider/${String(params.ZenithIssuerHost)}`;
        break;
      default:
        ref = `<${name}>`;
    }
    resourceRefs.set(name, ref);
    resourceAttrs.set(name, attrs);
    return ref;
  }

  function getAtt(name: string, attr: string): string {
    const o = options.resourceOverrides?.[name]?.attrs?.[attr];
    if (o !== undefined) return o;
    resourceRef(name);
    const v = resourceAttrs.get(name)?.[attr];
    if (v === undefined) throw new Error(`Unsupported attribute ${name}.${attr}`);
    return v;
  }

  function sub(template_: string, vars: Record<string, unknown>): string {
    return template_.replace(/\$\{([^}]+)\}/g, (_m, key: string) => {
      if (key in vars) return String(vars[key]);
      if (key.startsWith("AWS::")) return String(pseudoValue(key));
      if (key.includes(".")) {
        const [res, attr] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
        return getAtt(res, attr);
      }
      if (key in params) {
        const v = params[key];
        return Array.isArray(v) ? v.join(",") : v;
      }
      return resourceRef(key);
    });
  }

  function evaluate(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(evaluate).filter((v) => v !== NOVALUE);
    }
    if (node === null || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const k = keys[0];
      const arg = obj[k];
      switch (k) {
        case "Ref": {
          const name = String(arg);
          if (name.startsWith("AWS::")) return pseudoValue(name);
          if (name in params) return params[name];
          return resourceRef(name);
        }
        case "Fn::Sub": {
          if (typeof arg === "string") return sub(arg, {});
          const [str, map] = arg as [string, Record<string, unknown>];
          const vars = Object.fromEntries(Object.entries(map).map(([n, v]) => [n, evaluate(v)]));
          return sub(str, vars);
        }
        case "Fn::GetAtt": {
          const [name, attr] = arg as [string, string];
          return getAtt(name, attr);
        }
        case "Fn::Join": {
          const [sep, list] = arg as [string, unknown];
          const items = evaluate(list);
          if (!Array.isArray(items)) throw new Error("Fn::Join needs a list");
          return items.map((x) => (Array.isArray(x) ? x.join(",") : String(x))).join(sep);
        }
        case "Fn::If": {
          const [cond, yes, no] = arg as [string, unknown, unknown];
          return evaluate(condition(cond) ? yes : no);
        }
        case "Fn::Equals": {
          const [a, b] = (arg as unknown[]).map(evaluate);
          return JSON.stringify(a) === JSON.stringify(b);
        }
        case "Fn::Not":
          return !truthy(evaluate((arg as unknown[])[0]));
        case "Fn::And":
          return (arg as unknown[]).every((c) => truthy(evaluate(c)));
        case "Fn::Or":
          return (arg as unknown[]).some((c) => truthy(evaluate(c)));
        case "Condition":
          return condition(String(arg));
        default:
          if (k.startsWith("Fn::")) throw new Error(`Unsupported intrinsic function ${k}`);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const r = evaluate(v);
      if (r !== NOVALUE) out[k] = r;
    }
    return out;
  }

  return ev;
}

/* ------------------------------ policy helpers ----------------------------- */

export interface Statement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: unknown;
  Resource?: string | string[];
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

export const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function statementsOf(doc: unknown): Statement[] {
  const d = (typeof doc === "string" ? JSON.parse(doc) : doc) as { Statement?: Statement | Statement[] };
  return asList(d.Statement);
}

/** IAM measures policy size without whitespace. */
export const compactSize = (doc: unknown): number => JSON.stringify(typeof doc === "string" ? JSON.parse(doc) : doc).replace(/\s+/g, "").length;

/** Evaluate a resource's properties for one parameter set. */
export function resolveResource(template: Template, evaluator: Evaluator, logicalId: string): Record<string, unknown> | undefined {
  const res = template.Resources[logicalId];
  if (!res) throw new Error(`Unknown resource ${logicalId}`);
  if (res.Condition && !evaluator.condition(res.Condition)) return undefined;
  return evaluator.evaluate(res.Properties ?? {}) as Record<string, unknown>;
}

/** Glob match with IAM semantics (`*` any run, `?` one char), case-sensitive. */
export function iamGlob(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(value);
}

/** Does an Allow action pattern (`ecs:Describe*`) cover a concrete or patterned action? */
export function actionCovers(granted: string, wanted: string): boolean {
  const g = granted.toLowerCase();
  const w = wanted.toLowerCase();
  return iamGlob(g, w) || (w.includes("*") && iamGlob(g, w.replace(/\*/g, "")) && g.endsWith("*") && w.startsWith(g.slice(0, -1)));
}

export type { Json };
