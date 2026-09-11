/**
 * Container environment derivation: what each service's task definition sees
 * as plain env vars, as SSM-backed secrets, and which parameters the bundle
 * must therefore create. Split out of the single-file exporter; the code is
 * unchanged.
 */
import { hclString } from "./hcl";
import {
  managed,
  refPath,
  refVar,
  resLabel,
  routeOf,
  ssmSafe,
  svcLabel,
  tf,
  type SecretParam,
  type TfVariable,
} from "./naming";
import { bindingEnv, findNode } from "@/lib/domain/graph";
import type { Environment, Manifest, Service } from "@/lib/domain/types";

/* ------------------------- container env derivation ------------------------ */

export interface ContainerEnv {
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
export const containerServices = (m: Manifest) =>
  managed(m.services).filter((s) => s.kind !== "static");

/**
 * Everything the manifest forces the bundle to declare beyond its own managed
 * resources: variables for referenced targets, and SSM parameters for secrets.
 * Collected once so `variables.tf`/`secrets.tf` and the task definitions can
 * never drift apart — that drift is exactly what made the export fail
 * `terraform validate`.
 */
export function scaffold(m: Manifest, env: Environment): {
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
export function envJson(c: ContainerEnv): string {
  const lines = c.env.map((e) => `        { name = ${hclString(e.name)}, value = ${e.expr} }`);
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}

export function secretsJson(c: ContainerEnv): string {
  const lines = c.secrets.map(
    (e) => `        { name = ${hclString(e.name)}, valueFrom = ${e.expr} }`
  );
  return lines.length ? `[\n${lines.join(",\n")}\n      ]` : "[]";
}
