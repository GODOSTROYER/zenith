/**
 * ALB and target group names are capped at 32 characters by AWS.
 *
 * The export named them `${var.name_prefix}-alb` and
 * `${var.name_prefix}-<service>`, so a modest prefix ("acme-production-eu") plus
 * a descriptive service name planned fine and then failed at apply with a
 * `ValidationError` from ELB — the worst place to learn it. The README's advice
 * was "shorten name_prefix if a plan complains", which a plan never does.
 *
 * Now a name that would be longer than 32 characters is cut to its first 25
 * characters plus "-" and the first 6 hex characters of the SHA-1 of the full
 * name. The work happens in HCL (`local.lb_names` in alb.tf) rather than at
 * export time on purpose: the prefix is `var.name_prefix`, which the user can
 * override in terraform.tfvars, and a length decided against the default would
 * be wrong the moment they did. Names that already fit are unchanged.
 *
 * The behavioural half of this suite evaluates the emitted locals with
 * `tofu console` (no providers, no network, nothing created), and is skipped
 * when OpenTofu is not on PATH. The string-level half always runs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Environment, Manifest, Service } from "@/lib/domain/types";
import { terraformFiles, terraformReadme } from "@/lib/providers/aws/terraform";

const environment: Environment = {
  id: "env-prod",
  projectId: "proj-atlas",
  name: "staging",
  class: "staging",
  connectionId: "conn-aws",
  region: "us-west-2",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.zenith.test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const web = (name: string, id = `svc-${name}`): Service => ({
  id,
  name,
  kind: "web",
  source: { type: "image", image: "ghcr.io/acme/app:1" },
  size: "small",
  replicas: 1,
  port: 8080,
  healthPath: "/healthz",
  env: [],
  ownership: "managed",
});

function routed(...names: string[]): Manifest {
  const services = names.map((n, i) => web(n, `svc-${i}`));
  return {
    version: 1,
    services,
    resources: [],
    routes: services.map((s, i) => ({
      id: `rt-${i}`,
      host: `${s.id}.acme.com`,
      pathPrefix: `/${i}`,
      tls: true,
      managedDns: true,
    })),
    bindings: services.map((s, i) => ({ id: `b-${i}`, from: `rt-${i}`, to: s.id, capability: "http" as const })),
  };
}

const albFile = (m: Manifest, env: Environment = environment): string =>
  terraformFiles(env, m).find((f) => f.path.endsWith("alb.tf"))!.content;

/** The `locals { … }` block of alb.tf: the whole naming decision, and nothing else. */
function localsBlock(alb: string): string {
  const start = alb.indexOf("locals {");
  expect(start, "alb.tf must declare the load-balancer names in a locals block").toBeGreaterThanOrEqual(0);
  const end = alb.indexOf("\n}\n", start);
  return alb.slice(start, end + 3);
}

/* ------------------------------ string level ------------------------------ */

describe("alb.tf names", () => {
  it("routes every load balancer and target group name through the bounded locals", () => {
    const alb = albFile(routed("api", "worker"));
    expect(alb).toMatch(/resource "aws_lb" "main" \{\s*\n\s*name\s*=\s*local\.lb_names\["alb"\]/);
    for (const label of ["api", "worker"])
      expect(alb).toMatch(
        new RegExp(`resource "aws_lb_target_group" "${label}" \\{\\s*\\n\\s*name\\s*=\\s*local\\.lb_names\\["tg_${label}"\\]`)
      );
    // Nothing is named straight from the prefix any more.
    expect(alb).not.toMatch(/name\s*=\s*"\$\{var\.name_prefix\}-/);
  });

  it("declares the full name of each, and the bound applied to all of them", () => {
    const locals = localsBlock(albFile(routed("api", "worker")));
    expect(locals).toMatch(/alb\s+= "\$\{var\.name_prefix\}-alb"/);
    expect(locals).toMatch(/tg_api\s+= "\$\{var\.name_prefix\}-api"/);
    expect(locals).toMatch(/tg_worker\s+= "\$\{var\.name_prefix\}-worker"/);
    expect(locals).toContain("length(v) > 32");
    expect(locals).toContain("substr(v, 0, 25)");
    expect(locals).toContain("substr(sha1(v), 0, 6)");
    // No call inside a template: the exporter's interpolations stay plain addresses.
    expect(locals).not.toMatch(/[^$]\$\{[^}]*\(/);
  });

  it("gives every target group its own key even when two service names sanitise to one label", () => {
    const alb = albFile(routed("api.v1", "api-v1"));
    const keys = [...localsBlock(alb).matchAll(/^\s+(tg_\w+)\s+=/gm)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(alb).toContain(`local.lb_names["${k}"]`);
  });

  it("keeps a hostile service name inside its string", () => {
    const alb = albFile(routed('x${file("~/.aws/credentials")}"'));
    const locals = localsBlock(alb);
    // The template sigil is doubled (a literal), never an interpolation.
    expect(locals).toContain('$${file(');
    expect(locals).not.toMatch(/[^$]\$\{file\(/);
  });

  it("is byte-identical across exports of an unchanged manifest", () => {
    expect(albFile(routed("api", "worker"))).toBe(albFile(routed("api", "worker")));
  });

  it("emits no load balancer at all when nothing is routed", () => {
    const m = routed("api");
    m.routes = [];
    m.bindings = [];
    expect(terraformFiles(environment, m).some((f) => f.path.endsWith("alb.tf"))).toBe(false);
  });

  it("documents the truncation instead of advising a shorter prefix", () => {
    const readme = terraformReadme(environment, routed("api"));
    expect(readme).toMatch(/32 characters/);
    expect(readme).toMatch(/25 characters/);
    expect(readme).toMatch(/SHA-1/);
    expect(readme).not.toMatch(/Shorten `name_prefix` if a plan complains/);
    const variables = terraformFiles(environment, routed("api")).find((f) => f.path.endsWith("variables.tf"))!.content;
    expect(variables).not.toContain("Keep it short");
  });
});

/* ------------------------------ evaluated HCL ----------------------------- */

const HAVE_TOFU = spawnSync("tofu", ["version"], { encoding: "utf8" }).status === 0;
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const TOFU_ENV: Record<string, string | undefined> = {};
for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"])
  if (process.env[k]) TOFU_ENV[k] = process.env[k]!;
TOFU_ENV.TF_IN_AUTOMATION = "1";

/** Evaluate `local.lb_names` for one `name_prefix`, exactly as OpenTofu would. */
function evaluate(alb: string, namePrefix: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lbnames-"));
  scratch.push(dir);
  fs.writeFileSync(
    path.join(dir, "main.tf"),
    `variable "name_prefix" {\n  type    = string\n  default = ${JSON.stringify(namePrefix)}\n}\n\n${localsBlock(alb)}`
  );
  const out = execFileSync("tofu", ["console"], {
    cwd: dir,
    env: TOFU_ENV as NodeJS.ProcessEnv,
    input: "jsonencode(local.lb_names)\n",
    encoding: "utf8",
    timeout: 60_000,
  });
  // console prints the JSON string, itself JSON-quoted.
  return JSON.parse(JSON.parse(out.trim()));
}

describe.skipIf(!HAVE_TOFU)("alb.tf names, as OpenTofu evaluates them", () => {
  it("leaves a name that already fits exactly as it was", () => {
    const names = evaluate(albFile(routed("api", "worker")), "atlas-staging");
    expect(names).toEqual({
      alb: "atlas-staging-alb",
      tg_api: "atlas-staging-api",
      tg_worker: "atlas-staging-worker",
    });
  });

  it("does not touch a name of exactly 32 characters, and shortens one of 33 to exactly 32", () => {
    const alb = albFile(routed("s"));
    // "<prefix>-s" is prefix + 2 characters.
    const at32 = evaluate(alb, "p".repeat(30));
    expect(at32.tg_s).toBe(`${"p".repeat(30)}-s`);
    expect(at32.tg_s).toHaveLength(32);

    const at33 = evaluate(alb, "p".repeat(31));
    expect(at33.tg_s).toHaveLength(32);
    expect(at33.tg_s).toMatch(/^p{25}-[0-9a-f]{6}$/);
  });

  it("bounds the ALB name and every target group name to 32 characters", () => {
    const m = routed("checkout-and-payments-service", "customer-notification-dispatcher", "a");
    const names = evaluate(albFile(m), "acme-production-eu-west-1");
    expect(Object.keys(names)).toHaveLength(4);
    for (const [key, name] of Object.entries(names)) {
      expect(name.length, `${key}: ${name}`).toBeLessThanOrEqual(32);
      // ELB: alphanumeric and hyphens, not beginning or ending with a hyphen.
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/);
    }
    // The one that fit is still readable and unhashed.
    expect(names.tg_a).toBe("acme-production-eu-west-1-a");
  });

  it("keeps two long names that share their first 25 characters distinct", () => {
    const m = routed("customer-notification-dispatcher-a", "customer-notification-dispatcher-b");
    const names = evaluate(albFile(m), "acme-production");
    const [a, b] = [names.tg_customer_notification_dispatcher_a, names.tg_customer_notification_dispatcher_b];
    expect(a.slice(0, 25)).toBe(b.slice(0, 25)); // the collision the hash exists for
    expect(a).not.toBe(b);
    expect(new Set(Object.values(names)).size).toBe(Object.keys(names).length);
  });

  it("is deterministic: the same inputs always give the same name", () => {
    const alb = albFile(routed("customer-notification-dispatcher"));
    expect(evaluate(alb, "acme-production")).toEqual(evaluate(alb, "acme-production"));
  });

  it("follows an override of name_prefix, which is why it is decided in HCL", () => {
    const alb = albFile(routed("api"));
    const short = evaluate(alb, "atlas-staging");
    const long = evaluate(alb, "a-much-longer-organisation-and-environment-prefix");
    expect(short.tg_api).toBe("atlas-staging-api");
    expect(long.tg_api).toHaveLength(32);
    expect(long.tg_api).toMatch(/^a-much-longer-organisatio-[0-9a-f]{6}$/);
    expect(long.alb).toHaveLength(32);
  });

  it("tells two environments apart when their long prefixes share a 25-character head", () => {
    const alb = albFile(routed("api"));
    const one = evaluate(alb, "customer-production-environment-1");
    const two = evaluate(alb, "customer-production-environment-2");
    expect(one.alb.slice(0, 25)).toBe(two.alb.slice(0, 25));
    expect(one.alb).not.toBe(two.alb);
    expect(one.tg_api).not.toBe(two.tg_api);
  });
});
