/**
 * Manifest → real Terraform. This is the no-lock-in guarantee: the HCL this
 * module emits is meant to be run with `terraform apply` and your own
 * credentials, with or without Zenith in the picture.
 *
 * Design choices that keep the bundle applyable into a fresh account:
 *  - the account's default VPC/subnets are read through data sources rather
 *    than a bespoke network module you would then have to own;
 *  - every generated credential lands in SSM Parameter Store (SecureString)
 *    and reaches containers through the task definition's `secrets` block,
 *    never as a plaintext env var;
 *  - S3 and SQS access comes from per-service task roles, not access keys.
 *
 * Workstream A.
 */
import { bindingEnv, findNode } from "@/lib/domain/graph";
import { SIZE_SPECS } from "@/lib/cost/pricing";
import type {
  Binding,
  Environment,
  Manifest,
  Route,
  Service,
  ServiceSize,
} from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";

/* ------------------------------- HCL encoding ------------------------------ */

/**
 * Everything below exists because a manifest is untrusted input and this file
 * writes a program. The domain schema constrains route hosts and path
 * prefixes, but the exporter cannot lean on that: manifests also arrive from
 * importers, from stored revisions written before a schema tightened, and via
 * fields that are still free text (service and resource names, env keys and
 * values, health paths, image refs, schedules, externalRefs, region and
 * environment names). So every manifest-derived value is encoded here, at the
 * moment it is spliced into HCL, rather than trusted on the way in.
 *
 * There are exactly three shapes a value can take in the output, and each has
 * its own encoder:
 *
 *  - inside a double-quoted string  → `hclBody` / `hclString`
 *  - inside a `#` comment           → `hclComment`
 *  - as an identifier or address    → `tf` (constrained, never escaped)
 */

/**
 * C0/C1 controls plus the two Unicode line separators. None of them belong
 * in a .tf file, and a newline is the whole attack: it ends a `#` comment,
 * or turns one quoted string into two lines of configuration.
 */
const isControl = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
};

/**
 * The *body* of an HCL2 double-quoted string: escaped, without the quotes, so
 * it can be spliced next to interpolations this module writes itself (e.g.
 * `"/${var.name_prefix}/${hclBody(path)}"`).
 *
 * Beyond the obvious backslash/quote/newline work, the load-bearing line is
 * the last one. In HCL a quoted string is a *template*: `${…}` opens an
 * interpolation and `%{…}` a directive, so a value carrying either is
 * executable configuration rather than data — the difference between a
 * hostname and a call to `file("~/.aws/credentials")`. HCL's own literal form
 * for them is to double the sigil, and doubling only the sigil that actually
 * precedes a `{` is what makes the encoding stable: an input that already
 * reads `$${` comes out as `$$${`, which HCL renders back as the literal
 * `$${` instead of re-arming the interpolation.
 */
export function hclBody(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (isControl(ch)) out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  out = out.replace(/([$%])\{/g, (_m, sigil: string) => `${sigil}${sigil}{`);
  // A body is spliced into a larger literal, so a trailing sigil could pair up
  // with a `{` the caller writes next and re-open the hole from outside the
  // value. `$$`/`%%` are only escapes in front of a brace, so the fix is the
  // numeric escape: it survives the template scanner as a plain character.
  return out.replace(/\$$/, "\\u0024").replace(/%$/, "\\u0025");
}

/** A complete HCL2 double-quoted string literal, quotes included. */
export const hclString = (value: unknown): string => `"${hclBody(value)}"`;

/**
 * Text destined for a `#` comment. A comment ends at the first newline, so a
 * value carrying one does not stay a comment — the remainder lands in the
 * parser as configuration. Control characters therefore collapse to a space.
 * Quotes and `${` are inert inside a comment and are left readable.
 */
export function hclComment(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  let out = "";
  for (const ch of s) out += isControl(ch) ? " " : ch;
  return out.replace(/  +/g, " ").trim();
}

/**
 * A whole number for an unquoted attribute. Unquoted positions cannot be
 * escaped at all — whatever is written there is HCL — so a value that is not
 * a finite number is replaced rather than encoded.
 */
export function hclNum(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * A port safe to write unquoted, or nothing at all. Shared by the security
 * group, the task definition and the target group so a port the manifest
 * cannot justify is dropped from all three rather than one.
 */
const validPort = (value: unknown): number | undefined => {
  const n = hclNum(value, 0);
  return n >= 1 && n <= 65535 ? n : undefined;
};

/* --------------------------------- helpers -------------------------------- */

/**
 * A safe Terraform block label, and the one segment of an address that a
 * manifest can influence. Identifiers are not quoted, so they cannot be
 * escaped the way strings are — they are constrained instead: anything
 * outside `[A-Za-z0-9_]` collapses to `_`, a leading digit gains a `_`, and
 * an empty result becomes `_`. The empty case matters: an address is what
 * both the declaration and every reference to it are built from, and a blank
 * one emits `aws_s3_bucket..arn`, which does not parse.
 */
const tf = (s: string): string => {
  const out = String(s ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^(\d)/, "_$1");
  return out.length > 0 ? out : "_";
};

/** Fargate only accepts a fixed CPU/memory lattice; clamp SIZE_SPECS onto it. */
export function fargateSpec(size: ServiceSize): { cpu: number; memory: number } {
  // `size` is typed but not guaranteed: a stored revision predating a
  // vocabulary change reaches here with a value that is not in the enum, and
  // destructuring `undefined` would take the whole export down.
  const { vcpu, memoryMb } = SIZE_SPECS[size] ?? SIZE_SPECS.small;
  const cpu = Math.max(256, Math.round(vcpu * 1024));
  const floor: Record<number, number> = { 256: 512, 512: 1024, 1024: 2048, 2048: 4096 };
  return { cpu, memory: Math.max(memoryMb, floor[cpu] ?? 512) };
}

const DB_CLASS: Record<ServiceSize, string> = {
  nano: "db.t4g.micro",
  small: "db.t4g.small",
  standard: "db.t4g.medium",
  performance: "db.m6g.large",
};

const CACHE_CLASS: Record<ServiceSize, string> = {
  nano: "cache.t4g.micro",
  small: "cache.t4g.small",
  standard: "cache.t4g.medium",
  performance: "cache.m6g.large",
};

const DB_STORAGE: Record<ServiceSize, number> = {
  nano: 20,
  small: 20,
  standard: 50,
  performance: 200,
};

const managed = <T extends { ownership: string }>(xs: T[]) =>
  xs.filter((x) => x.ownership === "managed");

/**
 * A `referenced` node exists in the customer's account and this bundle must
 * never declare it as a resource. Its attributes come from variables the user
 * fills instead, so the HCL still validates and still plans.
 */
/**
 * A Terraform block label unique within `seen`. Sanitising is lossy, so two
 * different names arrive here as one label; duplicate labels do not parse, so
 * the second occurrence takes a numeric suffix. Deterministic.
 */
function uniqueLabel(seen: Set<string>, base: string): string {
  let label = base;
  for (let n = 2; seen.has(label); n++) label = `${base}_${n}`;
  seen.add(label);
  return label;
}

/**
 * One Terraform label per node, decided once for the whole bundle.
 *
 * `tf()` is many-to-one — "api.v1" and "api-v1" both sanitise to "api_v1" — and
 * a service's name is reused as the label of five or six blocks (ECR repo, log
 * group, task role, task definition, ECS service, target group). Deciding the
 * label independently at each site therefore emitted duplicate block labels,
 * which is a *parse* error: the bundle would not plan at all. Deciding it once,
 * per node id, keeps every emitter agreeing on one name and every name unique.
 *
 * Services and resources are numbered separately because they never share a
 * Terraform resource *type*, and a benign manifest must keep emitting exactly
 * the HCL it emitted before. Labels follow manifest order, so re-exporting an
 * unchanged manifest is byte-identical.
 */
interface NodeLabels {
  services: Map<string, string>;
  resources: Map<string, string>;
}

const LABELS = new WeakMap<Manifest, NodeLabels>();

function labelsFor(m: Manifest): NodeLabels {
  const hit = LABELS.get(m);
  if (hit) return hit;
  const services = new Map<string, string>();
  const resources = new Map<string, string>();
  const svcSeen = new Set<string>();
  const resSeen = new Set<string>();
  for (const x of m.services) services.set(x.id, uniqueLabel(svcSeen, tf(x.name)));
  for (const x of m.resources) resources.set(x.id, uniqueLabel(resSeen, tf(x.name)));
  const built = { services, resources };
  LABELS.set(m, built);
  return built;
}

/** The label for a service; falls back to the raw sanitised name off-manifest. */
const svcLabel = (m: Manifest, s: { id: string; name: string }): string =>
  labelsFor(m).services.get(s.id) ?? tf(s.name);

/** The label for a resource; falls back to the raw sanitised name off-manifest. */
const resLabel = (m: Manifest, r: { id: string; name: string }): string =>
  labelsFor(m).resources.get(r.id) ?? tf(r.name);

const REF_FIELDS: Partial<Record<Binding["capability"], string[]>> = {
  sql: ["host", "port", "user", "database", "password", "url"],
  cache: ["url"],
  blob: ["bucket"],
  queue_publish: ["queue_url", "queue_arn"],
  queue_consume: ["queue_url", "queue_arn"],
  smtp: ["smtp_host", "smtp_port", "smtp_user", "smtp-password"],
};

interface RefNames {
  names: Map<string, string>;
  paths: Map<string, string>;
}

/** Small deterministic token: identity-stable, unlike manifest-order suffixes. */
function stableToken(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function allocateStableNames(
  entries: { key: string; identity: string; natural: string }[]
): Map<string, string> {
  const groups = new Map<string, typeof entries>();
  for (const entry of entries)
    groups.set(entry.natural, [...(groups.get(entry.natural) ?? []), entry]);
  const reserved = new Set(groups.keys());
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const natural of [...groups.keys()].sort()) {
    const group = groups.get(natural)!;
    if (group.length === 1) {
      result.set(group[0].key, natural);
      used.add(natural);
      continue;
    }
    for (const entry of [...group].sort((a, b) => a.identity.localeCompare(b.identity))) {
      const base = `${natural}_${stableToken(entry.identity)}`;
      let candidate = base;
      for (let n = 2; reserved.has(candidate) || used.has(candidate); n++) candidate = `${base}_${n}`;
      result.set(entry.key, candidate);
      used.add(candidate);
    }
  }
  return result;
}

/**
 * Allocate all referenced inputs as a set. A unique natural key/path is kept
 * byte-for-byte for compatibility. Every member of a genuinely ambiguous
 * group gets an identity-derived suffix, so reordering the manifest cannot
 * swap meanings. All natural keys are reserved before suffix allocation, so a
 * generated name cannot steal another resource's already-valid natural key.
 * This is intentionally recomputed: manifests are mutable working copies.
 */
function refNamesFor(m: Manifest): RefNames {
  const entries: { key: string; identity: string; natural: string; path: string }[] = [];
  for (const resource of m.resources) {
    if (resource.ownership === "managed") continue;
    const fields = new Set<string>();
    for (const binding of m.bindings.filter((b) => b.to === resource.id)) {
      for (const field of REF_FIELDS[binding.capability] ?? []) fields.add(field);
    }
    for (const field of fields) {
      entries.push({
        key: `${resource.id}\0${field}`,
        identity: `${resource.id}\0${field}`,
        natural: tf(`ref_${resource.name}_${field}`),
        path: `refs/${ssmSafe(resource.name)}/${field}`,
      });
    }
  }
  return {
    names: allocateStableNames(entries.map((e) => ({ ...e, natural: e.natural }))),
    paths: allocateStableNames(entries.map((e) => ({ ...e, natural: e.path }))),
  };
}

const refVar = (m: Manifest, node: { id: string; name: string }, field: string) =>
  refNamesFor(m).names.get(`${node.id}\0${field}`) ?? tf(`ref_${node.name}_${field}`);

const refPath = (m: Manifest, node: { id: string; name: string }, field: string) =>
  refNamesFor(m).paths.get(`${node.id}\0${field}`) ?? `refs/${ssmSafe(node.name)}/${field}`;

/** SSM parameter names accept only these characters. */
const ssmSafe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-");

/** A `variable` block the bundle must declare. */
interface TfVariable {
  name: string;
  description: string;
  /** HCL default. Omitted = the user must supply it. */
  default?: string;
}

/**
 * A SecureString parameter the bundle creates so the first `terraform apply`
 * does not fail when ECS resolves the task definition's `secrets` block.
 */
interface SecretParam {
  /** terraform resource label */
  label: string;
  /** name under /${var.name_prefix}/ */
  path: string;
  /** key into var.secret_values */
  key: string;
  description: string;
}

/** Route serving this service, if any. */
function routeOf(m: Manifest, serviceId: string): Route | undefined {
  const b = m.bindings.find(
    (x) => x.capability === "http" && x.to === serviceId && m.routes.some((r) => r.id === x.from)
  );
  return b ? m.routes.find((r) => r.id === b.from) : undefined;
}

const projectSlug = (env: Environment) => String(env.baseDomain ?? "").split(".")[0] || "orrery";

/** Sandbox regions are Zenith-internal; a real bundle needs a real region. */
const exportRegion = (env: Environment) => {
  const r = String(env.region ?? "");
  return r.startsWith("sim-") || r === "" ? "us-east-1" : r;
};

/** `<project>-<environment>`, the default for `var.name_prefix`. */
const namePrefix = (env: Environment) => `${projectSlug(env)}-${String(env.name ?? "")}`;

/* ------------------------- container env derivation ------------------------ */

interface ContainerEnv {
  env: { name: string; expr: string }[];
  secrets: { name: string; expr: string }[];
  /** SSM parameters this service's bindings require us to create */
  params: SecretParam[];
  /** variables referenced (non-managed) targets require the user to fill */
  vars: TfVariable[];
  /** IAM statements the service's task role needs */
  statements: string[];
  notes: string[];
}

/**
 * Translate a service's manifest env + bindings into ECS task-definition
 * environment/secrets entries. The right-hand sides are HCL expressions, so
 * they resolve to real endpoints at apply time.
 */
export function containerEnv(m: Manifest, s: Service, _env: Environment): ContainerEnv {
  const out: ContainerEnv = {
    env: [],
    secrets: [],
    params: [],
    vars: [],
    statements: [],
    notes: [],
  };

  if (s.port) out.env.push({ name: "PORT", expr: hclString(s.port) });

  for (const e of s.env) {
    if (e.key === "ORRERY_CHAOS") continue; // sandbox-only failure injection
    if (e.value !== undefined) {
      // Not JSON.stringify: JSON has no opinion about `${`, so it would hand
      // the value straight through as a live HCL interpolation.
      out.env.push({ name: e.key, expr: hclString(e.value) });
    } else if (e.secretRef) {
      const p: SecretParam = {
        label: tf(`secret_${e.secretRef}`),
        path: `secrets/${ssmSafe(e.secretRef)}`,
        key: e.secretRef,
        description: `Manifest secretRef "${e.secretRef}".`,
      };
      out.params.push(p);
      // Point at the parameter this bundle creates, so ECS cannot start
      // before it exists — a bare ARN string would fail at task start.
      out.secrets.push({ name: e.key, expr: `aws_ssm_parameter.${p.label}.arn` });
      out.notes.push(
        `${s.name}.${e.key} reads SSM parameter /<name_prefix>/${p.path}, which this bundle creates as a placeholder. Set the real value with \`aws ssm put-parameter --overwrite\` — the parameter ignores later value changes, so Terraform will not revert it.`
      );
    }
  }

  for (const b of m.bindings.filter((x) => x.from === s.id)) {
    const target = findNode(m, b.to);
    if (!target) continue;
    const keys = bindingEnv(m, b).map((k) => k.key);
    const P = target.node.name.replace(/-/g, "_").toUpperCase();
    // The *declared* label, not a fresh tf() of the name: those differ whenever
    // two node names sanitise alike, and a reference that disagrees with the
    // declaration points at a resource the bundle never declares.
    const t =
      target.type === "resource"
        ? resLabel(m, target.node)
        : svcLabel(m, target.node);
    const name = target.node.name;

    // Referenced targets are not declared anywhere in this bundle, so every
    // attribute has to come from a variable rather than a resource address.
    if (target.node.ownership !== "managed" && b.capability !== "http") {
      const ext = target.type === "resource" ? target.node.externalRef : undefined;
      const v = (field: string, description: string, dflt?: string): string => {
        const n = refVar(m, target.node, field);
        const old = tf(`ref_${name}_${field}`);
        if (n !== old)
          out.notes.push(`Referenced input ${old} was ambiguous; ${name}.${field} uses ${n}. Update this key in terraform.tfvars for this export.`);
        out.vars.push({ name: n, description, default: dflt });
        return `var.${n}`;
      };
      const secretParam = (field: string, description: string): SecretParam => {
        const p: SecretParam = {
          // tf() the whole label: a hyphen is legal in a block label but makes
          // `aws_ssm_parameter.ref_x_smtp-password` parse as subtraction.
          label: refVar(m, target.node, field),
          path: refPath(m, target.node, field),
          key: refPath(m, target.node, field),
          description,
        };
        out.params.push(p);
        const previousPath = `refs/${ssmSafe(name)}/${field}`;
        if (p.path !== previousPath)
          out.notes.push(`Referenced secret path ${previousPath} was ambiguous; ${name}.${field} now uses ${p.path}. Populate the replacement SSM parameter before applying this export.`);
        return p;
      };
      const why = `Referenced ${target.node.kind} "${name}" — Zenith never provisions or mutates it`;

      if (b.capability === "sql") {
        out.env.push(
          { name: `${P}_HOST`, expr: v("host", `${why}. Hostname of the database.`, ext) },
          { name: `${P}_PORT`, expr: v("port", `${why}. Port.`, "5432") },
          { name: `${P}_USER`, expr: v("user", `${why}. Login role for ${s.name}.`) },
          { name: `${P}_DATABASE`, expr: v("database", `${why}. Database name.`, tf(name).toLowerCase()) }
        );
        const p = secretParam("password", `${why}. Password for ${s.name}'s login role.`);
        out.secrets.push({ name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${p.label}.arn` });
        const u = secretParam("url", `${why}. Full connection URL, if your app wants one.`);
        out.secrets.push({ name: `${P}_URL`, expr: `aws_ssm_parameter.${u.label}.arn` });
      } else if (b.capability === "cache") {
        out.env.push({
          name: `${P}_URL`,
          expr: v("url", `${why}. Redis URL, e.g. "redis://host:6379".`, ext),
        });
      } else if (b.capability === "blob") {
        const bucket = v("bucket", `${why}. Existing S3 bucket name.`, ext);
        out.env.push(
          { name: `${P}_BUCKET`, expr: bucket },
          { name: `${P}_ENDPOINT`, expr: `"https://s3.\${var.region}.amazonaws.com"` }
        );
        out.statements.push(
          `  statement {\n    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]\n    resources = ["arn:aws:s3:::\${${bucket}}", "arn:aws:s3:::\${${bucket}}/*"]\n  }`
        );
      } else if (b.capability === "queue_publish" || b.capability === "queue_consume") {
        out.env.push({ name: `${P}_URL`, expr: v("queue_url", `${why}. Existing SQS queue URL.`, ext) });
        const arn = v("queue_arn", `${why}. Existing SQS queue ARN, for the task role policy.`);
        const actions =
          b.capability === "queue_publish"
            ? `["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`
            : `["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`;
        out.statements.push(
          `  statement {\n    actions   = ${actions}\n    resources = [${arn}]\n  }`
        );
      } else if (b.capability === "smtp") {
        out.env.push(
          { name: `${P}_HOST`, expr: v("smtp_host", `${why}. SMTP hostname.`, ext) },
          { name: `${P}_PORT`, expr: v("smtp_port", `${why}. SMTP port.`, "587") },
          { name: `${P}_USER`, expr: v("smtp_user", `${why}. SMTP username.`) }
        );
        const p = secretParam("smtp-password", `${why}. SMTP password.`);
        out.secrets.push({ name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${p.label}.arn` });
      }

      out.notes.push(
        `${name} is referenced, not managed. This bundle declares no resource for it — fill \`${tf(`ref_${name}`)}_*\` in terraform.tfvars and put its credentials in SSM (see secrets.tf). \`imports.tf\` shows how to hand it to Terraform later if you change your mind.`
      );
      continue;
    }

    if (b.capability === "sql") {
      out.env.push(
        { name: `${P}_HOST`, expr: `aws_db_instance.${t}.address` },
        { name: `${P}_PORT`, expr: `tostring(aws_db_instance.${t}.port)` },
        { name: `${P}_USER`, expr: `aws_db_instance.${t}.username` },
        { name: `${P}_DATABASE`, expr: `aws_db_instance.${t}.db_name` }
      );
      out.secrets.push(
        { name: `${P}_PASSWORD`, expr: `aws_ssm_parameter.${t}_password.arn` },
        { name: `${P}_URL`, expr: `aws_ssm_parameter.${t}_url.arn` }
      );
    } else if (b.capability === "cache") {
      out.env.push({
        name: `${P}_URL`,
        expr: `"redis://\${aws_elasticache_cluster.${t}.cache_nodes[0].address}:6379"`,
      });
    } else if (b.capability === "blob") {
      out.env.push(
        { name: `${P}_BUCKET`, expr: `aws_s3_bucket.${t}.bucket` },
        { name: `${P}_ENDPOINT`, expr: `"https://s3.\${var.region}.amazonaws.com"` }
      );
      out.statements.push(
        `  statement {\n    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]\n    resources = [aws_s3_bucket.${t}.arn, "\${aws_s3_bucket.${t}.arn}/*"]\n  }`
      );
      if (keys.includes(`${P}_ACCESS_KEY`))
        out.notes.push(
          `${s.name} reaches ${target.node.name} through its task role, so ${P}_ACCESS_KEY / ${P}_SECRET_KEY are deliberately not injected — the AWS SDK picks the role up automatically.`
        );
    } else if (b.capability === "queue_publish" || b.capability === "queue_consume") {
      out.env.push({ name: `${P}_URL`, expr: `aws_sqs_queue.${t}.url` });
      const actions =
        b.capability === "queue_publish"
          ? `["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`
          : `["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]`;
      out.statements.push(
        `  statement {\n    actions   = ${actions}\n    resources = [aws_sqs_queue.${t}.arn]\n  }`
      );
    } else if (b.capability === "smtp") {
      out.env.push(
        { name: `${P}_HOST`, expr: `"email-smtp.\${var.region}.amazonaws.com"` },
        { name: `${P}_PORT`, expr: `"587"` },
        { name: `${P}_USER`, expr: `aws_iam_access_key.ses_smtp.id` }
      );
      out.secrets.push({
        name: `${P}_PASSWORD`,
        expr: `aws_ssm_parameter.ses_smtp_password.arn`,
      });
    } else if (b.capability === "http") {
      const peer = m.services.find((x) => x.id === b.to);
      const r = peer ? routeOf(m, peer.id) : undefined;
      if (r) {
        out.env.push({
          name: `${P}_URL`,
          expr: hclString(`${r.tls ? "https" : "http"}://${r.host}`),
        });
      } else if (peer) {
        out.notes.push(
          `${s.name} → ${peer.name} is an internal HTTP binding. ${P}_URL is not injected because ${peer.name} has no public route; add ECS Service Connect (or a private ALB) and set ${P}_URL yourself.`
        );
      }
    }
  }

  return out;
}

/** Services that get a container. Static sites are S3, not ECS. */
const containerServices = (m: Manifest) =>
  managed(m.services).filter((s) => s.kind !== "static");

/**
 * Everything the manifest forces the bundle to declare beyond its own managed
 * resources: variables for referenced targets, and SSM parameters for secrets.
 * Collected once so `variables.tf`/`secrets.tf` and the task definitions can
 * never drift apart — that drift is exactly what made the export fail
 * `terraform validate`.
 */
function scaffold(m: Manifest, env: Environment): {
  vars: TfVariable[];
  secrets: SecretParam[];
} {
  const vars = new Map<string, TfVariable>();
  const secrets = new Map<string, SecretParam>();
  for (const s of containerServices(m)) {
    const c = containerEnv(m, s, env);
    for (const v of c.vars) if (!vars.has(v.name)) vars.set(v.name, v);
    for (const p of c.params) if (!secrets.has(p.label)) secrets.set(p.label, p);
  }
  return { vars: [...vars.values()], secrets: [...secrets.values()] };
}

/**
 * `name` comes from the manifest and is encoded here. `expr` is generator-owned
 * HCL — a resource address, a `var.` reference, or a literal that was already
 * put through `hclString` where it was built — and is emitted verbatim on
 * purpose, because escaping it would break the reference it is.
 */
function envJson(c: ContainerEnv): string {
  const lines = c.env.map((e) => `        { name = ${hclString(e.name)}, value = ${e.expr} }`);
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}

function secretsJson(c: ContainerEnv): string {
  const lines = c.secrets.map(
    (e) => `        { name = ${hclString(e.name)}, valueFrom = ${e.expr} }`
  );
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}

/* --------------------------------- files ---------------------------------- */

function providersTf(): string {
  return `terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Origin      = "orrery-export"
    }
  }
}

data "aws_caller_identity" "current" {}
`;
}

function variablesTf(env: Environment, m: Manifest, hasRoutes: boolean, hasEmail: boolean): string {
  // "" means "use the ECR repository this bundle creates for the service".
  const images = containerServices(m)
    .map(
      (s) =>
        `    ${hclString(s.name)} = ${hclString(s.source.type === "image" ? s.source.image : "")}`
    )
    .join("\n");

  const { vars, secrets } = scaffold(m, env);

  const refVars = vars
    .map(
      (v) => `
variable "${tf(v.name)}" {
  description = ${hclString(v.description)}
  type        = string${v.default !== undefined ? `\n  default     = ${hclString(v.default)}` : ""}
}
`
    )
    .join("");

  const secretVar = secrets.length
    ? `
# Placeholders only. Zenith never held these values, so it cannot put them here.
# After the first apply, set each real value out-of-band:
#   aws ssm put-parameter --overwrite --type SecureString \\
#     --name "/<name_prefix>/<path>" --value "<value>"
# The parameters ignore later value changes, so Terraform will not revert you.
variable "secret_values" {
  description = "Initial value per secret. Anything left as PLACEHOLDER must be set with aws ssm put-parameter before the service can start."
  type        = map(string)
  sensitive   = true

  default = {
${secrets.map((p) => `    ${hclString(p.key)} = "PLACEHOLDER"`).join("\n")}
  }
}
`
    : "";

  const zoneVar = hasRoutes
    ? `
variable "route53_zone_name" {
  description = "Public hosted zone that owns the route hostnames, e.g. \\"example.com\\". Must already exist."
  type        = string
}
`
    : "";

  const mailVar = hasEmail
    ? `
variable "mail_domain" {
  description = "Domain to verify with SES for outbound mail."
  type        = string
}
`
    : "";

  return `variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = ${hclString(exportRegion(env))}
}

variable "project_name" {
  description = "Project name, used for tagging."
  type        = string
  default     = ${hclString(projectSlug(env))}
}

variable "environment" {
  description = "Environment name, used for tagging."
  type        = string
  default     = ${hclString(env.name)}
}

variable "name_prefix" {
  description = "Prefix for every resource name. Keep it short: ALB target group names cap at 32 characters."
  type        = string
  default     = ${hclString(namePrefix(env))}
}
${
  images
    ? `
variable "container_images" {
  description = "Image reference per service. Leave a service empty to use the ECR repository this bundle creates for it (push a :latest tag there first)."
  type        = map(string)

  default = {
${images}
  }
}
`
    : ""
}${zoneVar}${mailVar}${secretVar}${refVars}`;
}

/**
 * SecureString parameters for every `secretRef` and every referenced-resource
 * credential. Without these the first apply succeeds and then ECS fails at
 * task start, unable to resolve the `secrets` block — the worst possible time
 * to find out.
 */
function secretsTf(m: Manifest, env: Environment): string {
  const { secrets } = scaffold(m, env);
  if (!secrets.length) return "";
  return (
    `# Created empty on purpose: Zenith never holds secret values. Each parameter
# starts at the placeholder in var.secret_values and then ignores value
# changes, so \`aws ssm put-parameter --overwrite\` is the only writer.
` +
    secrets
      .map(
        (p) => `
resource "aws_ssm_parameter" "${tf(p.label)}" {
  name        = "/\${var.name_prefix}/${hclBody(p.path)}"
  description = ${hclString(p.description)}
  type        = "SecureString"
  value       = lookup(var.secret_values, ${hclString(p.key)}, "PLACEHOLDER")

  lifecycle {
    ignore_changes = [value]
  }
}
`
      )
      .join("")
  );
}

/**
 * Referenced resources have no `resource` block by design. If the owner later
 * wants Terraform to manage one, these are the import blocks to uncomment —
 * commented so the bundle still validates as shipped.
 */
function importsTf(m: Manifest): string {
  const refs = m.resources.filter((r) => r.ownership === "referenced");
  if (!refs.length) return "";
  const addr: Record<string, string> = {
    postgres: "aws_db_instance",
    redis: "aws_elasticache_cluster",
    object_store: "aws_s3_bucket",
    queue: "aws_sqs_queue",
    email: "aws_ses_domain_identity",
  };
  return `# Referenced resources: this bundle reads them through variables and never
# declares them. To hand one to Terraform, uncomment its import block, add a
# matching \`resource\` block that describes the live settings, then run
# \`terraform plan\` and reconcile until the plan is empty.
#
# Import is one-way in practice: once Terraform owns the resource, a
# \`terraform destroy\` will delete it.
${refs
  .map(
    (r) => `
# ${hclComment(`${r.name} (${r.kind})${r.externalRef ? ` — externalRef ${r.externalRef}` : " — no externalRef recorded in the manifest"}`)}
# import {
#   to = ${addr[r.kind] ?? "aws_resource"}.${resLabel(m, r)}
#   id = ${hclString(r.externalRef ?? "CHANGE_ME")}
# }
`
  )
  .join("")}`;
}

/** Commented remote-state backend. Local state is the default; this is the fix. */
function backendTf(env: Environment): string {
  // Both sit inside a quoted string inside a comment: escaping keeps them on
  // one line, which is what keeps the block commented.
  const prefix = hclBody(namePrefix(env));
  const region = hclBody(exportRegion(env));
  return `# State is on local disk until you move it. Before a second person touches
# this bundle, create a versioned S3 bucket you own, uncomment the block below,
# and run \`terraform init -migrate-state\`.
#
# \`use_lockfile\` needs Terraform >= 1.10 or OpenTofu >= 1.10. On older
# versions drop it and add \`dynamodb_table = "your-lock-table"\` instead.
#
# terraform {
#   backend "s3" {
#     bucket       = "CHANGE_ME-terraform-state"
#     key          = "${prefix}/terraform.tfstate"
#     region       = "${region}"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
`;
}

function networkTf(m: Manifest, hasRoutes: boolean): string {
  // Ports land in unquoted attributes, where nothing can be escaped, so a
  // non-numeric one is dropped rather than written out.
  const ports = [
    ...new Set(
      managed(m.services)
        .map((s) => validPort(s.port))
        .filter((p): p is number => p !== undefined)
    ),
  ];
  const albSg = hasRoutes
    ? `
resource "aws_security_group" "alb" {
  name        = "\${var.name_prefix}-alb"
  description = "Public ingress to the load balancer."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`
    : "";

  const serviceIngress = hasRoutes
    ? ports
        .map(
          (p) => `
  ingress {
    description     = "Load balancer to container port ${p}"
    from_port       = ${p}
    to_port         = ${p}
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
`
        )
        .join("")
    : "";

  const dataPorts: number[] = [];
  if (m.resources.some((r) => r.kind === "postgres")) dataPorts.push(5432);
  if (m.resources.some((r) => r.kind === "redis")) dataPorts.push(6379);

  const dataSg = dataPorts.length
    ? `
resource "aws_security_group" "data" {
  name        = "\${var.name_prefix}-data"
  description = "Managed data stores. Reachable only from the task security group."
  vpc_id      = data.aws_vpc.default.id
${dataPorts
  .map(
    (p) => `
  ingress {
    description     = "Tasks to port ${p}"
    from_port       = ${p}
    to_port         = ${p}
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
  }
`
  )
  .join("")}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`
    : "";

  return `# The default VPC is used on purpose: this bundle applies cleanly into a fresh
# account with no prerequisites. Replace these two data sources with your own
# VPC (or a module) when you want private subnets and NAT.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
${albSg}
resource "aws_security_group" "service" {
  name        = "\${var.name_prefix}-service"
  description = "Fargate tasks."
  vpc_id      = data.aws_vpc.default.id
${serviceIngress}
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
${dataSg}`;
}

/** The alphabet of a cron field. Anything else is not a schedule. */
const CRON_FIELD = /^[0-9*?,/#LW-]+$/;

/**
 * AWS EventBridge cron wants six fields and rejects `*` in both day slots.
 *
 * The field check is not politeness: `schedule` is free text in the manifest,
 * and a field like `*"` would otherwise close the quoted
 * `schedule_expression` and leave the rest of the value as configuration. An
 * unparseable schedule falls back to hourly, which is what a missing one
 * already did.
 */
function awsCron(expr: string): string {
  const f = String(expr ?? "").trim().split(/\s+/);
  if (f.length !== 5 || !f.every((x) => CRON_FIELD.test(x))) return `cron(0 * * * ? *)`;
  const [min, hour, dom, month, dow] = f;
  const useDow = dow !== "*";
  return `cron(${min} ${hour} ${useDow ? "?" : dom} ${month} ${useDow ? dow : "?"} *)`;
}

function ecsTf(m: Manifest, env: Environment): string {
  const services = containerServices(m);
  if (!services.length) return "";

  const anySecrets = services.some((s) => containerEnv(m, s, env).secrets.length > 0);

  let out = `resource "aws_ecs_cluster" "main" {
  name = "\${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "\${var.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
`;

  if (anySecrets)
    out += `
# The execution role is what pulls SecureString parameters at task start.
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:\${var.region}:\${data.aws_caller_identity.current.account_id}:parameter/\${var.name_prefix}/*"]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "\${var.name_prefix}-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}
`;

  for (const s of services) {
    const t = svcLabel(m, s);
    // `n` is the escaped body, for the names that splice the service name next
    // to an interpolation this file writes; `nq` is the standalone literal.
    const n = hclBody(s.name);
    const nq = hclString(s.name);
    const c = containerEnv(m, s, env);
    const spec = fargateSpec(s.size);
    const route = routeOf(m, s.id);
    const port = validPort(s.port);

    out += `
# A registry per service, so \`container_images[${hclComment(nq)}] = ""\` resolves
# to somewhere you can actually push. Deleting the repo deletes its images.
resource "aws_ecr_repository" "${t}" {
  name                 = "\${var.name_prefix}/${n}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "${t}" {
  name              = "/ecs/\${var.name_prefix}/${n}"
  retention_in_days = 30
}

resource "aws_iam_role" "task_${t}" {
  name               = "\${var.name_prefix}-${n}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
`;

    if (c.statements.length)
      out += `
data "aws_iam_policy_document" "task_${t}" {
${c.statements.join("\n\n")}
}

resource "aws_iam_role_policy" "task_${t}" {
  name   = "\${var.name_prefix}-${n}"
  role   = aws_iam_role.task_${t}.id
  policy = data.aws_iam_policy_document.task_${t}.json
}
`;

    const portMappings =
      port !== undefined
        ? `\n      portMappings = [\n        { containerPort = ${port}, hostPort = ${port}, protocol = "tcp" }\n      ]`
        : "";

    out += `
resource "aws_ecs_task_definition" "${t}" {
  family                   = "\${var.name_prefix}-${n}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "${hclNum(spec.cpu, 256)}"
  memory                   = "${hclNum(spec.memory, 512)}"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task_${t}.arn

  container_definitions = jsonencode([
    {
      name      = ${nq}
      image     = coalesce(lookup(var.container_images, ${nq}, ""), "\${aws_ecr_repository.${t}.repository_url}:latest")
      essential = true${portMappings}
      environment = ${envJson(c)}
      secrets = ${secretsJson(c)}
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.${t}.name
          awslogs-region        = var.region
          awslogs-stream-prefix = ${nq}
        }
      }
    }
  ])
}
`;

    if (s.kind === "cron") {
      out += `
# ${hclComment(s.name)} runs on a schedule instead of staying up.
resource "aws_iam_role" "events_${t}" {
  name = "\${var.name_prefix}-${n}-events"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = "sts:AssumeRole"
        Principal = {
          Service = "events.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "events_${t}" {
  name = "\${var.name_prefix}-${n}-events"
  role = aws_iam_role.events_${t}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["\${aws_ecs_task_definition.${t}.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.task_${t}.arn]
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "${t}" {
  name                = "\${var.name_prefix}-${n}"
  description         = ${hclString(`Schedule for ${s.name} (manifest: ${s.schedule ?? "unset"})`)}
  schedule_expression = ${hclString(awsCron(s.schedule ?? "0 * * * *"))}
}

resource "aws_cloudwatch_event_target" "${t}" {
  rule     = aws_cloudwatch_event_rule.${t}.name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.events_${t}.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.${t}.arn
    task_count          = 1
    launch_type         = "FARGATE"

    network_configuration {
      subnets          = data.aws_subnets.default.ids
      security_groups  = [aws_security_group.service.id]
      assign_public_ip = true
    }
  }
}
`;
      continue;
    }

    const lb = route
      ? `
  load_balancer {
    target_group_arn = aws_lb_target_group.${t}.arn
    container_name   = ${nq}
    container_port   = ${port ?? 80}
  }

  depends_on = [aws_lb_listener.${route.tls ? "https" : "http"}]
`
      : "";

    out += `
resource "aws_ecs_service" "${t}" {
  name            = "\${var.name_prefix}-${n}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.${t}.arn
  desired_count   = ${hclNum(s.replicas, 1)}
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }
${lb}}
`;
  }
  return out;
}

function rdsTf(m: Manifest): string {
  const dbs = managed(m.resources).filter((r) => r.kind === "postgres");
  if (!dbs.length) return "";
  let out = `resource "aws_db_subnet_group" "main" {
  name       = "\${var.name_prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of dbs) {
    const t = resLabel(m, r);
    const n = hclBody(r.name);
    const dbName = tf(r.name).toLowerCase();
    out += `
resource "random_password" "${t}" {
  length  = 32
  special = false
}

resource "aws_db_instance" "${t}" {
  identifier                  = "\${var.name_prefix}-${n}"
  engine                      = "postgres"
  engine_version              = ${hclString(r.config.version ?? "16")}
  instance_class              = ${hclString(DB_CLASS[r.size] ?? DB_CLASS.small)}
  allocated_storage           = ${hclNum(DB_STORAGE[r.size], 20)}
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = ${hclString(dbName)}
  username                    = "orrery"
  password                    = random_password.${t}.result
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.data.id]
  backup_retention_period     = 7
  auto_minor_version_upgrade  = true
  deletion_protection         = false
  skip_final_snapshot         = true
  apply_immediately           = true
}

resource "aws_ssm_parameter" "${t}_password" {
  name  = "/\${var.name_prefix}/${n}/password"
  type  = "SecureString"
  value = random_password.${t}.result
}

resource "aws_ssm_parameter" "${t}_url" {
  name  = "/\${var.name_prefix}/${n}/url"
  type  = "SecureString"
  value = "postgres://\${aws_db_instance.${t}.username}:\${random_password.${t}.result}@\${aws_db_instance.${t}.endpoint}/\${aws_db_instance.${t}.db_name}"
}
`;
  }
  return out;
}

function elasticacheTf(m: Manifest): string {
  const caches = managed(m.resources).filter((r) => r.kind === "redis");
  if (!caches.length) return "";
  let out = `resource "aws_elasticache_subnet_group" "main" {
  name       = "\${var.name_prefix}-cache"
  subnet_ids = data.aws_subnets.default.ids
}
`;
  for (const r of caches) {
    const t = resLabel(m, r);
    out += `
resource "aws_elasticache_cluster" "${t}" {
  cluster_id           = "\${var.name_prefix}-${hclBody(r.name)}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = ${hclString(CACHE_CLASS[r.size] ?? CACHE_CLASS.small)}
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.data.id]
}
`;
  }
  return out;
}

function s3Tf(m: Manifest): string {
  const buckets = managed(m.resources).filter((r) => r.kind === "object_store");
  const sites = managed(m.services).filter((s) => s.kind === "static");
  if (!buckets.length && !sites.length) return "";
  // S3 bucket names are global, so "<prefix>-uploads" collides with every other
  // account that tried the same obvious name. The suffix is generated once and
  // kept in state: it is stable across applies unless you taint this resource.
  let out = `resource "random_id" "bucket_suffix" {
  byte_length = 3
}

`;
  for (const r of buckets) {
    const t = resLabel(m, r);
    out += `resource "aws_s3_bucket" "${t}" {
  bucket = "\${var.name_prefix}-${hclBody(r.name)}-\${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "${t}" {
  bucket                  = aws_s3_bucket.${t}.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "${t}" {
  bucket = aws_s3_bucket.${t}.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "${t}" {
  bucket = aws_s3_bucket.${t}.id

  versioning_configuration {
    status = "Enabled"
  }
}

`;
  }
  for (const s of sites) {
    const t = svcLabel(m, s);
    out += `# Static site "${hclComment(s.name)}". Upload your build output here, then front it with
# CloudFront if you need a custom domain and TLS.
#
# This bucket is deliberately world-readable: a website bucket with the default
# private settings answers 403 to every visitor. Everything you put in it is
# public. Do not upload anything you would not publish.
resource "aws_s3_bucket" "site_${t}" {
  bucket = "\${var.name_prefix}-${hclBody(s.name)}-site-\${random_id.bucket_suffix.hex}"
}

resource "aws_s3_bucket_website_configuration" "site_${t}" {
  bucket = aws_s3_bucket.site_${t}.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "site_${t}" {
  bucket                  = aws_s3_bucket.site_${t}.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "site_${t}" {
  bucket = aws_s3_bucket.site_${t}.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadForWebsite"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "\${aws_s3_bucket.site_${t}.arn}/*"
      }
    ]
  })

  # The access block must land first, or S3 rejects the policy.
  depends_on = [aws_s3_bucket_public_access_block.site_${t}]
}

`;
  }
  return out;
}

function sqsTf(m: Manifest): string {
  const queues = managed(m.resources).filter((r) => r.kind === "queue");
  if (!queues.length) return "";
  return queues
    .map((r) => {
      const t = resLabel(m, r);
      const n = hclBody(r.name);
      return `resource "aws_sqs_queue" "${t}_dlq" {
  name                      = "\${var.name_prefix}-${n}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "${t}" {
  name                       = "\${var.name_prefix}-${n}"
  visibility_timeout_seconds = ${hclNum(r.config.visibilityTimeout, 30)}
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.${t}_dlq.arn
    maxReceiveCount     = 5
  })
}
`;
    })
    .join("\n");
}

function sesTf(m: Manifest): string {
  const mail = managed(m.resources).filter((r) => r.kind === "email");
  if (!mail.length) return "";
  return `resource "aws_ses_domain_identity" "main" {
  domain = var.mail_domain
}

resource "aws_ses_domain_dkim" "main" {
  domain = aws_ses_domain_identity.main.domain
}

# SMTP credentials for the services bound to this sender.
resource "aws_iam_user" "ses_smtp" {
  name = "\${var.name_prefix}-ses-smtp"
}

resource "aws_iam_user_policy" "ses_smtp" {
  name = "\${var.name_prefix}-ses-send"
  user = aws_iam_user.ses_smtp.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendRawEmail", "ses:SendEmail"]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_access_key" "ses_smtp" {
  user = aws_iam_user.ses_smtp.name
}

resource "aws_ssm_parameter" "ses_smtp_password" {
  name  = "/\${var.name_prefix}/ses/smtp-password"
  type  = "SecureString"
  value = aws_iam_access_key.ses_smtp.ses_smtp_password_v4
}
`;
}

interface RouteBinding {
  route: Route;
  service: Service;
}

function routeBindings(m: Manifest): RouteBinding[] {
  const out: RouteBinding[] = [];
  for (const b of m.bindings) {
    if (b.capability !== "http") continue;
    const route = m.routes.find((r) => r.id === b.from);
    const service = m.services.find((s) => s.id === b.to);
    if (route && service && service.ownership === "managed") out.push({ route, service });
  }
  return out;
}

function albTf(m: Manifest): string {
  const rb = routeBindings(m);
  if (!rb.length) return "";
  const anyTls = rb.some((x) => x.route.tls);
  const plain = rb.filter((x) => !x.route.tls);

  let out = `resource "aws_lb" "main" {
  name               = "\${var.name_prefix}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
}
`;

  // Two distinct services can sanitise to one label ("api.v1" and "api-v1" both
  // become "api_v1"). Skipping the second used to look like deduplication, but
  // it silently pointed both routes at the *first* service's target group. Keep
  // one target group per service, keyed by id, and disambiguate the label.
  const emitted = new Set<string>();
  for (const { service } of rb) {
    if (emitted.has(service.id)) continue; // several routes, one service
    emitted.add(service.id);
    const t = svcLabel(m, service);
    out += `
resource "aws_lb_target_group" "${t}" {
  name        = "\${var.name_prefix}-${hclBody(service.name)}"
  port        = ${validPort(service.port) ?? 80}
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"

  health_check {
    path                = ${hclString(service.healthPath ?? "/")}
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}
`;
  }

  out += `
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
${
  anyTls
    ? `    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }`
    : `    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "No route matched."
      status_code  = "404"
    }`
}
  }
}
`;

  if (anyTls)
    out += `
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "No route matched."
      status_code  = "404"
    }
  }
}
`;

  const ruleSeen = new Set<string>();
  rb.forEach(({ route, service }, i) => {
    // Host+path sanitise many-to-one too ("/x.y" and "/x-y" both become
    // "_x_y"), and duplicate block labels are a Terraform *parse* error — the
    // export would not even plan.
    const t = uniqueLabel(ruleSeen, tf(`${route.host}_${route.pathPrefix}`));
    const listener = route.tls ? "https" : "http";
    out += `
resource "aws_lb_listener_rule" "${t}" {
  listener_arn = aws_lb_listener.${listener}.arn
  priority     = ${100 + i}

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${svcLabel(m, service)}.arn
  }

  condition {
    host_header {
      values = [${hclString(route.host)}]
    }
  }

  condition {
    path_pattern {
      values = [${hclString(
        route.pathPrefix === "/" ? "/*" : `${String(route.pathPrefix ?? "/").replace(/\/+$/, "")}/*`
      )}]
    }
  }
}
`;
  });

  if (plain.length)
    out += `
# Routes exported without TLS (tls = false in the manifest) stay on the :80
# listener. Turn TLS on in Zenith and re-export to move them behind ACM.
`;

  return out;
}

function acmTf(m: Manifest): string {
  const rb = routeBindings(m).filter((x) => x.route.tls);
  if (!rb.length) return "";
  const hosts = [...new Set(rb.map((x) => x.route.host))];
  const [primary, ...sans] = hosts;

  return `resource "aws_acm_certificate" "main" {
  domain_name               = ${hclString(primary)}
  subject_alternative_names = [${sans.map((h) => hclString(h)).join(", ")}]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
`;
}

function route53Tf(m: Manifest): string {
  const rb = routeBindings(m);
  if (!rb.length) return "";
  const hosts = [...new Set(rb.map((x) => x.route.host))];
  return `data "aws_route53_zone" "main" {
  name         = var.route53_zone_name
  private_zone = false
}
${hosts
  .map(
    (h) => `
resource "aws_route53_record" "${tf(h)}" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = ${hclString(h)}
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
`
  )
  .join("")}`;
}

function outputsTf(m: Manifest): string {
  const parts: string[] = [];
  const rb = routeBindings(m);
  if (rb.length) {
    parts.push(`output "load_balancer_dns" {
  description = "Public DNS name of the application load balancer."
  value       = aws_lb.main.dns_name
}

output "urls" {
  description = "Public URL per route."
  value = [
${[
  ...new Set(
    rb.map(
      (x) =>
        `    ${hclString(
          `${x.route.tls ? "https" : "http"}://${x.route.host}${
            x.route.pathPrefix === "/" ? "" : x.route.pathPrefix
          }`
        )}`
    )
  ),
].join(",\n")}
  ]
}`);
  }
  for (const r of managed(m.resources)) {
    const t = resLabel(m, r);
    if (r.kind === "postgres")
      parts.push(`output "${t}_endpoint" {
  description = ${hclString(
    `Endpoint for ${r.name}. The password lives in SSM at /<name_prefix>/${r.name}/password.`
  )}
  value       = aws_db_instance.${t}.endpoint
}`);
    if (r.kind === "redis")
      parts.push(`output "${t}_endpoint" {
  description = ${hclString(`Primary node address for ${r.name}.`)}
  value       = aws_elasticache_cluster.${t}.cache_nodes[0].address
}`);
    if (r.kind === "object_store")
      parts.push(`output "${t}_bucket" {
  description = ${hclString(`Bucket name for ${r.name}.`)}
  value       = aws_s3_bucket.${t}.bucket
}`);
    if (r.kind === "queue")
      parts.push(`output "${t}_queue_url" {
  description = ${hclString(`Queue URL for ${r.name}.`)}
  value       = aws_sqs_queue.${t}.url
}`);
  }
  for (const s of managed(m.services).filter((x) => x.kind === "static")) {
    const t = svcLabel(m, s);
    parts.push(`output "${t}_site_endpoint" {
  description = ${hclString(
    `Public website endpoint for ${s.name}. Upload your build output to the bucket in the value below.`
  )}
  value       = aws_s3_bucket_website_configuration.site_${t}.website_endpoint
}

output "${t}_site_bucket" {
  description = ${hclString(`Bucket holding ${s.name}'s built files.`)}
  value       = aws_s3_bucket.site_${t}.bucket
}`);
  }
  const svcs = containerServices(m);
  if (svcs.length) {
    parts.push(`output "ecs_cluster" {
  description = "ECS cluster running the services."
  value       = aws_ecs_cluster.main.name
}`);
    parts.push(`output "ecr_repositories" {
  description = "Push an image here for any service left empty in container_images, then apply again."
  value = {
${svcs
  .map((s) => `    ${hclString(s.name)} = aws_ecr_repository.${svcLabel(m, s)}.repository_url`)
  .join("\n")}
  }
}`);
  }
  return parts.join("\n\n") + (parts.length ? "\n" : "");
}

function tfvarsExample(env: Environment, m: Manifest, hasRoutes: boolean, hasEmail: boolean): string {
  // terraform.tfvars is loaded and executed like any other HCL, so it gets the
  // same encoding as the .tf files — including the trailing `#` comments,
  // where a newline would turn the rest of a description into an assignment.
  const images = containerServices(m)
    .map(
      (s) =>
        `  ${hclString(s.name)} = ${hclString(s.source.type === "image" ? s.source.image : "")}${s.source.type === "image" ? "" : `  # empty = push to the ECR repo this bundle creates for ${hclComment(s.name)}`}`
    )
    .join("\n");
  const hosts = [...new Set(routeBindings(m).map((x) => x.route.host))];
  const guessZone = String(hosts[0] ?? "").split(".").slice(-2).join(".") || "example.com";
  const { vars } = scaffold(m, env);

  const refBlock = vars.length
    ? `
# Referenced resources. Zenith never provisions or mutates these; fill in where
# they already live. Anything left empty will fail at plan or at task start.
${vars
  .map((v) => `${tf(v.name)} = ${hclString(v.default ?? "")}  # ${hclComment(v.description)}`)
  .join("\n")}
`
    : "";

  return `# Copy to terraform.tfvars and edit before the first apply.
region       = ${hclString(exportRegion(env))}
project_name = ${hclString(projectSlug(env))}
environment  = ${hclString(env.name)}
name_prefix  = ${hclString(namePrefix(env))}
${hasRoutes ? `\n# Must be an existing public hosted zone you control.\nroute53_zone_name = ${hclString(guessZone)}\n` : ""}${hasEmail ? `\nmail_domain = ${hclString(guessZone)}\n` : ""}${
    images
      ? `
container_images = {
${images}
}
`
      : ""
  }${refBlock}`;
}

/* ------------------------------ bundle assembly ---------------------------- */

/**
 * Align `=` within each run of simple attribute lines, the way `terraform fmt`
 * would. Cheaper than shipping a formatter, and it means the bundle is already
 * canonical when someone runs `terraform fmt -check` in CI.
 */
function alignEq(src: string): string {
  const re = /^(\s*)([A-Za-z_"][^=]*?)\s*=\s(.*)$/;
  const out = src.split("\n");
  let group: { i: number; indent: string; key: string; val: string }[] = [];
  const flush = () => {
    if (group.length > 1) {
      const w = Math.max(...group.map((g) => g.key.length));
      for (const g of group) out[g.i] = `${g.indent}${g.key.padEnd(w)} = ${g.val}`;
    }
    group = [];
  };
  out.forEach((line, i) => {
    const m = re.exec(line);
    // A line that opens a nested block or collection ends the run.
    if (!m || /[[{(]$/.test(m[3].trim())) return flush();
    if (group.length && group[0].indent !== m[1]) flush();
    group.push({ i, indent: m[1], key: m[2], val: m[3] });
  });
  flush();
  return out.join("\n");
}

export function terraformFiles(env: Environment, m: Manifest): ExportFile[] {
  const hasRoutes = routeBindings(m).length > 0;
  const hasEmail = managed(m.resources).some((r) => r.kind === "email");

  const candidates: [string, string][] = [
    ["providers.tf", providersTf()],
    ["backend.tf", backendTf(env)],
    ["variables.tf", variablesTf(env, m, hasRoutes, hasEmail)],
    ["network.tf", networkTf(m, hasRoutes)],
    ["ecs.tf", ecsTf(m, env)],
    ["secrets.tf", secretsTf(m, env)],
    ["imports.tf", importsTf(m)],
    ["rds.tf", rdsTf(m)],
    ["elasticache.tf", elasticacheTf(m)],
    ["s3.tf", s3Tf(m)],
    ["sqs.tf", sqsTf(m)],
    ["ses.tf", sesTf(m)],
    ["alb.tf", albTf(m)],
    ["acm.tf", acmTf(m)],
    ["route53.tf", route53Tf(m)],
    ["outputs.tf", outputsTf(m)],
    ["terraform.tfvars.example", tfvarsExample(env, m, hasRoutes, hasEmail)],
  ];

  return candidates
    .filter(([, content]) => content.trim().length > 0)
    .map(([path, content]) => ({ path, content: alignEq(content) }));
}

/* --------------------------------- readme --------------------------------- */

export function terraformReadme(env: Environment, m: Manifest): string {
  const rb = routeBindings(m);
  const svcs = managed(m.services);
  // Markdown is not executed, but a newline still wrecks a table row and a
  // pipe still splits a cell, so manifest text is flattened here too.
  const cell = (s: unknown) => hclComment(s).replace(/\|/g, "\\|");
  const notes = [
    ...new Set(svcs.flatMap((s) => containerEnv(m, s, env).notes.map((n) => hclComment(n)))),
  ];
  const bindingTable = m.bindings
    .filter((b) => m.services.some((s) => s.id === b.from))
    .map((b) => {
      const from = m.services.find((s) => s.id === b.from)!;
      const to = findNode(m, b.to);
      const keys = bindingEnv(m, b).map((k) => `\`${cell(k.key)}\``).join(", ");
      return `| ${cell(from.name)} | ${cell(to?.node.name ?? b.to)} | ${cell(b.capability)} | ${keys || "—"} |`;
    })
    .join("\n");

  const prefix = hclComment(namePrefix(env));

  return `# ${cell(projectSlug(env))} — ${cell(env.name)} infrastructure

This is your infrastructure, not Zenith's. Everything here is standard
Terraform against the \`hashicorp/aws\` provider (\`~> 5.0\`); OpenTofu works
too. You can run it, read it, fork it, or delete Zenith entirely and keep
operating. Nothing in this bundle calls back to Zenith.

Generated from revision-level manifest: ${svcs.length} service(s),
${managed(m.resources).length} managed resource(s), ${m.routes.length} route(s).

## Prerequisites

1. Terraform >= 1.6 (or OpenTofu >= 1.6).
2. AWS credentials with permission to create ECS, IAM, RDS, ElastiCache, S3,
   SQS, SES, ELB, ACM and Route 53 resources. Administrator access is the
   simple answer; the least-privilege answer is the summary shown on the
   provider's connect screen.
3. A container image per service. This bundle creates an ECR repository per
   service; leave that service empty in \`container_images\` and push a
   \`:latest\` tag there, or point the entry at any registry ECS can pull from
   (Docker Hub, GHCR). A service with an empty entry and an empty repository
   will start and then fail to pull — apply once, read
   \`terraform output ecr_repositories\`, push, apply again.
${rb.length ? `4. A **public Route 53 hosted zone** you control, matching your route hostnames. ACM DNS validation writes records into it.\n` : ""}
## First apply

\`\`\`sh
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: region, name_prefix, images${rb.length ? ", route53_zone_name" : ""}
terraform init
terraform plan -out plan.tfplan   # read this. it is the same discipline as Zenith's Changes drawer
terraform apply plan.tfplan
\`\`\`

The first apply takes roughly 10–15 minutes; RDS and ACM validation dominate.
When it finishes, \`terraform output\` prints the load balancer DNS name${rb.length ? " and the public URL for each route" : ""}.

### State

State is local by default. \`backend.tf\` ships the S3 backend block already
filled in for this environment, commented out. Create a versioned bucket you
own, uncomment it, and run \`terraform init -migrate-state\` before a second
person touches this bundle.

## How Zenith's model maps onto AWS

| Zenith | AWS |
| --- | --- |
| service (web / worker) | ECS Fargate task definition + service |
| service (cron) | ECS task definition + EventBridge rule |
| service (static) | S3 bucket with website configuration |
| service size | Fargate CPU / memory (clamped to a valid Fargate pair) |
| replicas | \`desired_count\` on the ECS service |
| postgres | RDS PostgreSQL instance + SSM SecureString credentials |
| redis | ElastiCache Redis cluster |
| object_store | S3 bucket (versioned, encrypted, private) |
| queue | SQS queue + dead-letter queue |
| email | SES domain identity + SMTP IAM user |
| route → service | ALB target group + listener rule + ACM cert + Route 53 alias |
| binding | env vars / secrets on the task definition + IAM on the task role |
| managed node | a \`resource\` block Terraform creates, updates and destroys |
| referenced node | **no resource block** — a \`var.ref_*\` you fill, plus SSM for its credentials. See \`imports.tf\` to take one over. |
| secretRef | \`aws_ssm_parameter\` (SecureString) created empty, in \`secrets.tf\` |

## Environment injection

Each service's container gets three sources of configuration, all visible in
\`ecs.tf\` inside the \`container_definitions\` block:

1. **Literal env vars** from the manifest, as \`environment\` entries.
2. **Binding-derived env vars**, wired to the real resource attributes — e.g.
   \`aws_db_instance.<name>.address\` rather than a hardcoded hostname.
3. **Secrets**, as \`secrets\` entries pointing at SSM Parameter Store ARNs.
   The ECS *execution* role reads them at task start; they never appear in the
   task definition, in state output, or in the console.

${bindingTable ? `| service | target | capability | injected |\n| --- | --- | --- | --- |\n${bindingTable}\n` : "No bindings in this manifest.\n"}
${
  notes.length
    ? `### Notes on this manifest\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`
    : ""
}
### Secrets

A Zenith server can hold secret values — encrypted at rest, under its own
\`ORRERY_SECRET_KEY\` — but **an export never contains one**, whether or not
the store has it. A bundle you can commit, mail or paste is the wrong place
for a credential, and there is no flag to change that.

So what \`secrets.tf\` does instead is create every parameter the task
definitions reference, holding the placeholder \`PLACEHOLDER\`. That is what
stops the first apply from succeeding and then failing at task start, unable
to resolve the \`secrets\` block.

The values are yours to move across, once, with the command below. Zenith's
copy stays where it is and the two do not sync: after this, SSM is what the
running tasks read, and rotating a secret in Zenith does not rotate it here.

Set the real values once, after the first apply:

\`\`\`sh
aws ssm put-parameter --overwrite --type SecureString \\
  --name "/${prefix}/secrets/<ref>" --value "<value>"
\`\`\`

Each parameter carries \`ignore_changes = [value]\`, so a later
\`terraform apply\` will not revert you. Restart the service (force a new
deployment) to pick a changed value up.

${
  m.resources.some((r) => r.ownership === "referenced")
    ? `### Referenced resources

Resources marked *referenced* in Zenith already exist in your account, and
this bundle declares none of them — that is the whole point of the
distinction. Their hostnames and identifiers come from \`var.ref_*\` in
\`terraform.tfvars\`, and their credentials from the SSM parameters above.
\`imports.tf\` carries a commented \`import\` block per referenced resource for
the day you decide Terraform should own one.

`
    : ""
}
## Operating without Zenith

- **Deploy a new version.** Push a new image tag, update \`container_images\`,
  \`terraform apply\`. ECS performs a rolling replacement.
- **Scale.** Change \`desired_count\` on the service (or the \`replicas\` value
  you exported from) and apply.
- **Resize.** Change \`cpu\`/\`memory\` on the task definition, or
  \`instance_class\` on RDS, and apply.
- **Roll back.** \`git revert\` the change to this directory and apply. Your
  version control is the revision history; Terraform state is the truth.
- **Read logs.** \`aws logs tail /ecs/${prefix}/<service> --follow\`.
- **Tear down.** \`terraform destroy\`. RDS has \`skip_final_snapshot = true\`
  for demo convenience — flip it to \`false\` before you have data you care
  about.

## Deliberate simplifications

These are the corners this generator cuts, and what to do about each:

- **Default VPC, public subnets.** Tasks get public IPs so they can pull
  images without a NAT gateway. For production, add private subnets + NAT (or
  VPC endpoints) and set \`assign_public_ip = false\`.
- **\`skip_final_snapshot = true\` and \`deletion_protection = false\` on RDS.**
  Invert both once the database matters.
- **No autoscaling.** \`desired_count\` is fixed. Add
  \`aws_appautoscaling_target\` + policy when you need it.
- **Static sites are public S3 website buckets.** They carry a
  \`s3:GetObject\` policy for \`Principal = "*"\` because a private website
  bucket answers 403 to everyone. Everything you upload is public. Add
  CloudFront + an ACM cert in us-east-1 for a custom domain and TLS.
- **Bucket names carry a random suffix.** S3's namespace is global, so
  \`<name_prefix>-uploads\` is almost certainly taken. The suffix lives in
  state and is stable across applies.
- **Service-to-service HTTP** relies on public routes. Add ECS Service Connect
  or an internal ALB for private traffic.
- **ALB target group names** are \`<name_prefix>-<service>\` and AWS caps them
  at 32 characters. Shorten \`name_prefix\` if a plan complains.

Re-exporting from Zenith regenerates these files from the current manifest. If
you have edited them by hand, diff before overwriting — your edits are yours.
`;
}
