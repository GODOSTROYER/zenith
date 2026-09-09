/**
 * First tests for the Terraform exporter — the largest file in the repo and,
 * until now, the only one with no coverage at all.
 *
 * The load-bearing one is `every referenced address is declared`. Terraform is
 * not installed in CI, so this suite stands in for `terraform validate`: it
 * parses the emitted HCL for resource/data/variable declarations and for
 * references to them, and asserts the second set is a subset of the first.
 * That is exactly the class of bug the export shipped with — task definitions
 * pointing at `aws_db_instance.legacy_db` for a resource marked *referenced*,
 * which the bundle deliberately never declares.
 */
import { describe, expect, it } from "vitest";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";
import { allocateStableNames, containerEnv, fargateSpec, terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

/* --------------------------------- fixtures -------------------------------- */

const environment: Environment = {
  id: "env-staging",
  projectId: "proj-atlas",
  name: "staging",
  class: "staging",
  connectionId: "conn-aws",
  region: "us-west-2",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.orrery.test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * Exercises every branch that emits HCL: managed and referenced nodes of each
 * kind, a secretRef, a static site, a cron job, and a TLS route.
 */
function fullManifest(): Manifest {
  return {
    version: 1,
    services: [
      {
        id: "svc-api",
        name: "api",
        kind: "web",
        source: { type: "git", repo: "github.com/acme/api", ref: "main" },
        size: "standard",
        replicas: 2,
        port: 3000,
        healthPath: "/healthz",
        env: [
          { key: "LOG_LEVEL", value: "info" },
          { key: "STRIPE_KEY", secretRef: "vault:stripe" },
        ],
        ownership: "managed",
      },
      {
        id: "svc-worker",
        name: "worker",
        kind: "worker",
        source: { type: "image", image: "ghcr.io/acme/worker:1.2.3" },
        size: "small",
        replicas: 1,
        env: [],
        ownership: "managed",
      },
      {
        id: "svc-nightly",
        name: "nightly",
        kind: "cron",
        source: { type: "image", image: "ghcr.io/acme/nightly:1" },
        size: "nano",
        replicas: 1,
        schedule: "0 3 * * *",
        env: [],
        ownership: "managed",
      },
      {
        id: "svc-site",
        name: "site",
        kind: "static",
        source: { type: "git", repo: "github.com/acme/site", ref: "main" },
        size: "nano",
        replicas: 1,
        env: [],
        ownership: "managed",
      },
    ],
    resources: [
      { id: "res-db", name: "main-db", kind: "postgres", config: { version: "16" }, size: "small", ownership: "managed" },
      { id: "res-cache", name: "cache", kind: "redis", config: {}, size: "nano", ownership: "managed" },
      { id: "res-uploads", name: "uploads", kind: "object_store", config: {}, size: "small", ownership: "managed" },
      { id: "res-events", name: "events", kind: "queue", config: { visibilityTimeout: 60 }, size: "small", ownership: "managed" },
      { id: "res-mail", name: "mail", kind: "email", config: {}, size: "small", ownership: "managed" },
      // The whole point of the referenced/managed split: these five exist in
      // the customer's account and must never appear as resource blocks.
      { id: "res-legacy", name: "legacy-db", kind: "postgres", config: {}, size: "standard", ownership: "referenced", externalRef: "prod-postgres-1" },
      { id: "res-shared", name: "shared-cache", kind: "redis", config: {}, size: "small", ownership: "referenced", externalRef: "redis://shared.internal:6379" },
      { id: "res-archive", name: "archive", kind: "object_store", config: {}, size: "small", ownership: "referenced", externalRef: "acme-archive-prod" },
      { id: "res-billing", name: "billing", kind: "queue", config: {}, size: "small", ownership: "referenced", externalRef: "https://sqs.us-west-2.amazonaws.com/1/billing" },
      { id: "res-relay", name: "relay", kind: "email", config: {}, size: "small", ownership: "referenced" },
    ],
    routes: [{ id: "rt-app", host: "app.acme.com", pathPrefix: "/", tls: true, managedDns: true }],
    bindings: [
      { id: "b-route", from: "rt-app", to: "svc-api", capability: "http" },
      { id: "b-sql", from: "svc-api", to: "res-db", capability: "sql" },
      { id: "b-cache", from: "svc-api", to: "res-cache", capability: "cache" },
      { id: "b-blob", from: "svc-api", to: "res-uploads", capability: "blob" },
      { id: "b-queue", from: "svc-api", to: "res-events", capability: "queue_publish" },
      { id: "b-mail", from: "svc-api", to: "res-mail", capability: "smtp" },
      { id: "b-legacy", from: "svc-api", to: "res-legacy", capability: "sql" },
      { id: "b-shared", from: "svc-api", to: "res-shared", capability: "cache" },
      { id: "b-archive", from: "svc-api", to: "res-archive", capability: "blob" },
      { id: "b-billing", from: "svc-worker", to: "res-billing", capability: "queue_consume" },
      { id: "b-relay", from: "svc-worker", to: "res-relay", capability: "smtp" },
    ],
  };
}

/** A manifest with nothing but a bare service — the "does it degrade" case. */
function minimalManifest(): Manifest {
  return {
    version: 1,
    services: [
      {
        id: "svc-solo",
        name: "solo",
        kind: "worker",
        source: { type: "image", image: "alpine:3" },
        size: "nano",
        replicas: 1,
        env: [],
        ownership: "managed",
      },
    ],
    resources: [],
    routes: [],
    bindings: [],
  };
}

/* ------------------------------- HCL scanning ------------------------------ */

const hcl = (files: ExportFile[]) =>
  files.filter((f) => f.path.endsWith(".tf")).map((f) => f.content).join("\n");

/** Comments are not code: `imports.tf` references resources on purpose. */
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

function declarations(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"/gm)) out.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/^data\s+"([^"]+)"\s+"([^"]+)"/gm)) out.add(`data.${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/^variable\s+"([^"]+)"/gm)) out.add(`var.${m[1]}`);
  return out;
}

/**
 * Every address the HCL points at: `var.x`, `data.aws_type.name`, and
 * `aws_type.name` / `random_type.name`. Attribute suffixes are dropped — the
 * question is whether the *block* exists.
 */
function references(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bvar\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(`var.${m[1]}`);
  for (const m of src.matchAll(/\bdata\.((?:aws|random)_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]*)/g))
    out.add(`data.${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/(?<!\.)\b((?:aws|random)_[a-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]*)/g))
    out.add(`${m[1]}.${m[2]}`);
  return out;
}

/** Addresses referenced but never declared — must always be empty. */
function undeclared(files: ExportFile[]): string[] {
  const src = stripComments(hcl(files));
  const declared = declarations(src);
  return [...references(src)].filter((r) => !declared.has(r)).sort();
}

const fileNamed = (files: ExportFile[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in bundle: ${files.map((x) => x.path).join(", ")}`);
  return f.content;
};

/* ---------------------------------- tests ---------------------------------- */

describe("terraform bundle", () => {
  it("emits one file per concern, and omits files with nothing to say", () => {
    expect(terraformFiles(environment, fullManifest()).map((f) => f.path)).toEqual([
      "providers.tf",
      "backend.tf",
      "variables.tf",
      "network.tf",
      "ecs.tf",
      "secrets.tf",
      "imports.tf",
      "rds.tf",
      "elasticache.tf",
      "s3.tf",
      "sqs.tf",
      "ses.tf",
      "alb.tf",
      "acm.tf",
      "route53.tf",
      "outputs.tf",
      "terraform.tfvars.example",
    ]);
  });

  it("drops every file a bare manifest has no content for", () => {
    const paths = terraformFiles(environment, minimalManifest()).map((f) => f.path);
    expect(paths).toEqual([
      "providers.tf",
      "backend.tf",
      "variables.tf",
      "network.tf",
      "ecs.tf",
      "outputs.tf",
      "terraform.tfvars.example",
    ]);
    // No resources, so no secrets/imports/rds/s3/route53.
    expect(paths).not.toContain("secrets.tf");
    expect(paths).not.toContain("imports.tf");
    expect(paths).not.toContain("route53.tf");
  });

  it("never emits an empty file", () => {
    for (const f of terraformFiles(environment, fullManifest()))
      expect(f.content.trim().length, f.path).toBeGreaterThan(0);
  });
});

describe("declared vs referenced addresses", () => {
  it("declares every address the full manifest's HCL refers to", () => {
    expect(undeclared(terraformFiles(environment, fullManifest()))).toEqual([]);
  });

  it("declares every address a bare manifest's HCL refers to", () => {
    expect(undeclared(terraformFiles(environment, minimalManifest()))).toEqual([]);
  });

  it("declares every address when every resource is referenced", () => {
    const m = fullManifest();
    for (const r of m.resources) {
      r.ownership = "referenced";
      r.externalRef ??= `external-${r.name}`;
    }
    expect(undeclared(terraformFiles(environment, m))).toEqual([]);
  });

  it("declares every address with no routes and no TLS", () => {
    const m = fullManifest();
    m.routes = [];
    m.bindings = m.bindings.filter((b) => b.id !== "b-route");
    expect(undeclared(terraformFiles(environment, m))).toEqual([]);
  });

  it("assigns only declared variables in terraform.tfvars.example", () => {
    const files = terraformFiles(environment, fullManifest());
    const declared = declarations(stripComments(hcl(files)));
    const assigned = [
      ...fileNamed(files, "terraform.tfvars.example").matchAll(/^([a-z_][a-z0-9_]*)\s*=/gm),
    ].map((m) => `var.${m[1]}`);
    expect(assigned.length).toBeGreaterThan(4);
    expect(assigned.filter((a) => !declared.has(a))).toEqual([]);
  });
});

describe("managed vs referenced resources", () => {
  const files = terraformFiles(environment, fullManifest());
  const src = hcl(files);

  it("declares a resource block for each managed resource", () => {
    expect(src).toContain(`resource "aws_db_instance" "main_db"`);
    expect(src).toContain(`resource "aws_elasticache_cluster" "cache"`);
    expect(src).toContain(`resource "aws_s3_bucket" "uploads"`);
    expect(src).toContain(`resource "aws_sqs_queue" "events"`);
    expect(src).toContain(`resource "aws_ses_domain_identity" "main"`);
  });

  it("declares no resource block for any referenced resource", () => {
    expect(src).not.toContain(`"aws_db_instance" "legacy_db"`);
    expect(src).not.toContain(`"aws_elasticache_cluster" "shared_cache"`);
    expect(src).not.toContain(`"aws_s3_bucket" "archive"`);
    expect(src).not.toContain(`"aws_sqs_queue" "billing"`);
  });

  it("reaches referenced resources through variables the user fills", () => {
    const vars = fileNamed(files, "variables.tf");
    expect(vars).toContain(`variable "ref_legacy_db_host"`);
    expect(vars).toContain(`variable "ref_archive_bucket"`);
    expect(vars).toContain(`variable "ref_billing_queue_arn"`);
    // externalRef becomes the default, so the export is not a blank form.
    expect(vars).toContain(`default     = "prod-postgres-1"`);
  });

  it("wires managed bindings to real resource attributes, not variables", () => {
    const api = fullManifest().services[0];
    const c = containerEnv(fullManifest(), api, environment);
    const expr = (name: string) => c.env.find((e) => e.name === name)?.expr;
    expect(expr("MAIN_DB_HOST")).toBe("aws_db_instance.main_db.address");
    expect(expr("LEGACY_DB_HOST")).toBe("var.ref_legacy_db_host");
  });

  it("offers a commented import block per referenced resource", () => {
    const imports = fileNamed(files, "imports.tf");
    expect(imports).toContain("#   to = aws_db_instance.legacy_db");
    expect(imports).toContain(`#   id = "prod-postgres-1"`);
    // Commented, so the bundle still validates as shipped.
    for (const line of imports.split("\n").filter((l) => l.includes("import {")))
      expect(line.trimStart().startsWith("#")).toBe(true);
  });

  it("keeps legacy tfvars names unless field boundaries actually collide", () => {
    const m = fullManifest();
    m.resources.push(
      { id: "res-a", name: "a", kind: "queue", config: {}, size: "small", ownership: "referenced" },
      { id: "res-a-queue", name: "a-queue", kind: "redis", config: {}, size: "small", ownership: "referenced" }
    );
    m.bindings.push(
      { id: "b-a", from: "svc-api", to: "res-a", capability: "queue_publish" },
      { id: "b-a-queue", from: "svc-worker", to: "res-a-queue", capability: "cache" }
    );
    const files = terraformFiles(environment, m);
    const vars = fileNamed(files, "variables.tf");
    const tfvars = fileNamed(files, "terraform.tfvars.example");
    expect(vars).toContain(`variable "ref_legacy_db_host"`);
    const collided = [...vars.matchAll(/variable "(ref_a_queue_url_[a-z0-9]+)"/g)].map((x) => x[1]);
    expect(collided).toHaveLength(2);
    expect(new Set(collided).size).toBe(2);
    expect(vars).not.toContain(`variable "ref_a_queue_url"`);
    for (const name of collided) expect(tfvars).toMatch(new RegExp(`^${name}\\s*=`, "m"));
    expect(undeclared(files)).toEqual([]);
  });

  it("assigns same-sanitized resources stable keys across manifest reorder and explains migration", () => {
    const m = fullManifest();
    m.resources.push(
      { id: "res-dot", name: "alpha.cache", kind: "redis", config: {}, size: "small", ownership: "referenced" },
      { id: "res-dash", name: "alpha-cache", kind: "redis", config: {}, size: "small", ownership: "referenced" }
    );
    m.bindings.push(
      { id: "b-dot", from: "svc-api", to: "res-dot", capability: "cache" },
      { id: "b-dash", from: "svc-api", to: "res-dash", capability: "cache" }
    );
    const assigned = (manifest: Manifest) => {
      const c = containerEnv(manifest, manifest.services[0], environment);
      return new Map(c.vars.filter((v) => /alpha[.-]cache/.test(v.description)).map((v) => [v.description, v.name]));
    };
    const before = assigned(m);
    m.resources.reverse();
    m.bindings.reverse();
    expect(assigned(m)).toEqual(before);
    const readme = terraformReadme(environment, m);
    expect(readme).toMatch(/ref_alpha_cache_url was ambiguous/);
    for (const name of before.values()) expect(readme).toContain(`uses ${name}`);
  });

  it("recomputes reference allocations after an in-place manifest mutation", () => {
    const m = fullManifest();
    expect(terraformFiles(environment, m).map((f) => f.content).join("\n")).toContain(`variable "ref_shared_cache_url"`);
    m.resources.push({ id: "res-shared-dot", name: "shared.cache", kind: "redis", config: {}, size: "small", ownership: "referenced" });
    m.bindings.push({ id: "b-shared-dot", from: "svc-api", to: "res-shared-dot", capability: "cache" });
    const src = terraformFiles(environment, m).map((f) => f.content).join("\n");
    expect(src).not.toContain(`variable "ref_shared_cache_url"`);
    expect([...src.matchAll(/variable "(ref_shared_cache_url_[a-z0-9]+)"/g)]).toHaveLength(2);
  });

  it("reserves a natural key that resembles a generated collision suffix", () => {
    const pair = [
      { key: "a", identity: "resource-a", natural: "ref_shared_url" },
      { key: "b", identity: "resource-b", natural: "ref_shared_url" },
    ];
    const generated = allocateStableNames(pair).get("a")!;
    const withNatural = allocateStableNames([
      ...pair,
      { key: "natural", identity: "resource-natural", natural: generated },
    ]);
    expect(withNatural.get("natural")).toBe(generated);
    expect(withNatural.get("a")).not.toBe(generated);
    expect(new Set(withNatural.values()).size).toBe(3);
  });
});

describe("secrets", () => {
  const files = terraformFiles(environment, fullManifest());

  it("creates an SSM parameter for every secretRef, so the first apply does not die at task start", () => {
    const secrets = fileNamed(files, "secrets.tf");
    expect(secrets).toContain(`resource "aws_ssm_parameter" "secret_vault_stripe"`);
    expect(secrets).toContain(`name        = "/\${var.name_prefix}/secrets/vault-stripe"`);
    expect(secrets).toContain(`type        = "SecureString"`);
    // Zenith never held the value, and must not clobber the real one later.
    expect(secrets).toContain("ignore_changes = [value]");
  });

  it("points the task definition at the parameter it creates, not at a bare ARN string", () => {
    const api = fullManifest().services[0];
    const c = containerEnv(fullManifest(), api, environment);
    expect(c.secrets.find((s) => s.name === "STRIPE_KEY")?.expr).toBe(
      "aws_ssm_parameter.secret_vault_stripe.arn"
    );
  });

  it("scaffolds a parameter for referenced-resource credentials too", () => {
    const secrets = fileNamed(files, "secrets.tf");
    expect(secrets).toContain(`resource "aws_ssm_parameter" "ref_legacy_db_password"`);
    // Underscored, not "smtp-password": a hyphen here parses as subtraction
    // wherever the parameter is referenced.
    expect(secrets).toContain(`resource "aws_ssm_parameter" "ref_relay_smtp_password"`);
    expect(secrets).toContain(`name        = "/\${var.name_prefix}/refs/relay/smtp-password"`);
  });

  it("preserves the historical SSM path for a noncolliding hyphenated reference", () => {
    const m = fullManifest();
    m.resources.find((r) => r.id === "res-relay")!.name = "mail-relay";
    const secrets = fileNamed(terraformFiles(environment, m), "secrets.tf");
    expect(secrets).toContain(`name        = "/\${var.name_prefix}/refs/mail-relay/smtp-password"`);
    expect(secrets).not.toContain(`/refs/mail_relay/smtp-password`);
  });

  it("documents replacement SSM paths when referenced secret names collide", () => {
    const m = fullManifest();
    const relay = m.resources.find((r) => r.id === "res-relay")!;
    relay.name = "mail relay";
    m.resources.push({ ...relay, id: "res-relay-2", name: "mail!relay" });
    m.bindings.push({ id: "b-relay-2", from: "svc-worker", to: "res-relay-2", capability: "smtp" });
    const files = terraformFiles(environment, m);
    expect(terraformReadme(environment, m)).toContain("Referenced secret path refs/mail-relay/smtp-password was ambiguous");
    const paths = [...fileNamed(files, "secrets.tf").matchAll(/refs\/mail-relay\/smtp-password_[a-z0-9_]+/g)].map((m) => m[0]);
    expect(new Set(paths).size).toBe(2);
  });

  it("declares a sensitive placeholder map rather than inventing values", () => {
    const vars = fileNamed(files, "variables.tf");
    expect(vars).toContain(`variable "secret_values"`);
    expect(vars).toContain("sensitive   = true");
    // alignEq pads keys into columns, so match tolerantly.
    expect(vars).toMatch(/"vault:stripe"\s+= "PLACEHOLDER"/);
  });

  it("emits no secrets.tf when the manifest has no secrets", () => {
    expect(terraformFiles(environment, minimalManifest()).map((f) => f.path)).not.toContain(
      "secrets.tf"
    );
  });
});

describe("s3", () => {
  const s3 = fileNamed(terraformFiles(environment, fullManifest()), "s3.tf");

  it("suffixes bucket names, because the S3 namespace is global", () => {
    expect(s3).toContain(`resource "random_id" "bucket_suffix"`);
    expect(s3).toContain(`bucket = "\${var.name_prefix}-uploads-\${random_id.bucket_suffix.hex}"`);
    expect(s3).toContain(`bucket = "\${var.name_prefix}-site-site-\${random_id.bucket_suffix.hex}"`);
  });

  it("keeps data buckets private", () => {
    expect(s3).toMatch(/resource "aws_s3_bucket_public_access_block" "uploads"[\s\S]*?block_public_policy\s+= true/);
  });

  it("makes static-site buckets actually serve", () => {
    // A website bucket with the default private settings answers 403.
    expect(s3).toMatch(
      /resource "aws_s3_bucket_public_access_block" "site_site"[\s\S]*?block_public_policy\s+= false/
    );
    expect(s3).toContain(`resource "aws_s3_bucket_policy" "site_site"`);
    expect(s3).toContain(`Action    = "s3:GetObject"`);
    expect(s3).toContain(`Principal = "*"`);
    // The access block has to land before the policy or S3 rejects it.
    expect(s3).toContain("depends_on = [aws_s3_bucket_public_access_block.site_site]");
  });
});

describe("images", () => {
  const files = terraformFiles(environment, fullManifest());

  it("creates a registry per service, so an empty image entry has somewhere to point", () => {
    const ecs = fileNamed(files, "ecs.tf");
    expect(ecs).toContain(`resource "aws_ecr_repository" "api"`);
    expect(ecs).toContain(`resource "aws_ecr_repository" "worker"`);
    // Static sites are S3, not ECS.
    expect(ecs).not.toContain(`resource "aws_ecr_repository" "site"`);
  });

  it("falls back to that registry instead of shipping a CHANGE_ME image", () => {
    const ecs = fileNamed(files, "ecs.tf");
    expect(ecs).toContain(
      `coalesce(lookup(var.container_images, "api", ""), "\${aws_ecr_repository.api.repository_url}:latest")`
    );
    const vars = fileNamed(files, "variables.tf");
    expect(vars).not.toContain("CHANGE_ME");
    expect(vars).toMatch(/"worker"\s+= "ghcr\.io\/acme\/worker:1\.2\.3"/);
    expect(vars).toMatch(/"api"\s+= ""/);
  });
});

describe("state", () => {
  it("ships a backend block for this environment, commented out", () => {
    const backend = fileNamed(terraformFiles(environment, fullManifest()), "backend.tf");
    expect(backend).toContain(`#     key          = "atlas-staging/terraform.tfstate"`);
    expect(backend).toContain(`#     region       = "us-west-2"`);
    for (const line of backend.split("\n").filter((l) => l.includes("backend \"s3\"")))
      expect(line.trimStart().startsWith("#")).toBe(true);
  });
});

describe("fargateSpec", () => {
  it("clamps onto a valid Fargate CPU/memory pair", () => {
    expect(fargateSpec("nano")).toEqual({ cpu: 256, memory: 512 });
    expect(fargateSpec("small")).toEqual({ cpu: 512, memory: 1024 });
    expect(fargateSpec("standard")).toEqual({ cpu: 1024, memory: 2048 });
    expect(fargateSpec("performance")).toEqual({ cpu: 2048, memory: 4096 });
  });
});

describe("readme", () => {
  const readme = terraformReadme(environment, fullManifest());

  it("documents the referenced-resource contract it now implements", () => {
    expect(readme).toContain("Referenced resources");
    expect(readme).toContain("imports.tf");
  });

  it("no longer claims secrets are uncreated", () => {
    expect(readme).not.toContain("are **not** created for you");
    expect(readme).toContain("put-parameter");
  });

  it("says the static-site bucket is public", () => {
    expect(readme).toContain("public S3 website buckets");
  });
});
