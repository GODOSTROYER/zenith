/**
 * The customer bootstrap module (deploy/gcp): static checks over its HCL, a
 * `tofu fmt -check`, and — gated behind ZENITH_TEST_TOFU_NETWORK=1 — a real
 * `tofu init` + `tofu validate` against hashicorp/google 8.5.0. Nothing here
 * applies the module or touches a cloud account.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { subjectAudience } from "@/lib/providers/gcp/credentials";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { LOCKFILES } from "@/lib/tofu/locks.generated";
import { PROVIDER_PINS } from "@/lib/tofu/providers";

const DIR = path.resolve(__dirname, "../../../deploy/gcp");
const read = (f: string) => readFileSync(path.join(DIR, f), "utf8");
const main = read("main.tf");
const variables = read("variables.tf");
const outputs = read("outputs.tf");
const all = [main, variables, outputs, read("versions.tf")].join("\n");

let bin: string | undefined;
try {
  bin = resolveTofuBinary();
  if (spawnSync(bin, ["version"], { stdio: "ignore" }).status !== 0) bin = undefined;
} catch {
  bin = undefined;
}
const networkEnabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && bin !== undefined;

describe("trust", () => {
  it("pins issuer, audience and the exact Zenith subject", () => {
    expect(main).toContain('zenith_subject = "zenith:ws:${var.zenith_workspace_id}:conn:${var.zenith_connection_id}"');
    expect(main).toContain('attribute_condition = "assertion.sub == \\"${local.zenith_subject}\\""');
    expect(main).toContain("issuer_uri        = var.zenith_issuer_uri");
    expect(main).toContain("allowed_audiences = [local.allowed_audience]");
    // the audience is the same string the session asks the broker to mint (credentials.ts)
    expect(main).toContain('allowed_audience = "https://iam.googleapis.com/${local.provider_path}"');
    expect(subjectAudience("projects/1/locations/global/workloadIdentityPools/p/providers/q")).toBe("https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q");
  });

  it("binds impersonation to one principal://…/subject/<sub>, never the pool", () => {
    expect(main).toContain('federated_principal = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.zenith.name}/subject/${local.zenith_subject}"');
    expect(main).not.toContain("principalSet");
    expect(main).not.toContain("attribute.");
    const bindings = [...main.matchAll(/resource "google_service_account_iam_member" "(\w+)" \{[\s\S]*?\n\}/g)];
    expect(bindings.map((b) => b[1]).sort()).toEqual(["deploy_impersonation", "observe_impersonation"]);
    for (const b of bindings) {
      expect(b[0]).toContain('role               = "roles/iam.workloadIdentityUser"');
      expect(b[0]).toContain("member             = local.federated_principal");
    }
  });

  it("validates workspace and connection ids so they cannot break out of the CEL string", () => {
    for (const v of ["zenith_workspace_id", "zenith_connection_id"]) {
      const block = variables.match(new RegExp(`variable "${v}" \\{[\\s\\S]*?\\n\\}`))![0];
      expect(block).toContain("^[A-Za-z0-9_-]{1,64}$");
    }
    expect(variables).toContain('!endswith(var.zenith_issuer_uri, "/")');
    expect(variables).toContain("^https://");
  });
});

describe("least privilege", () => {
  it("uses no primitive role, no key, no public member", () => {
    expect(all).not.toMatch(/"roles\/(owner|editor|viewer)"/);
    expect(all).not.toContain("google_service_account_key");
    expect(all).not.toContain("allUsers");
    expect(all).not.toContain("allAuthenticatedUsers");
    expect(all).not.toMatch(/secretmanager\.admin|secretAccessor/);
    expect(all).not.toContain('"secretmanager.versions.access"'); // as a permission; the description may name it
  });

  it("gives observe read-only roles only", () => {
    const observe = main.match(/observe_roles = \[([\s\S]*?)\]/)![1].match(/"roles\/[^"]+"/g)!.map((r) => r.slice(1, -1));
    expect(observe.length).toBeGreaterThan(8);
    for (const r of observe) expect(r, r).toMatch(/\.(viewer|reader|serviceUsageConsumer)$/);
    const extras = main.match(/zenithObserveExtras[\s\S]*?permissions = \[([\s\S]*?)\]/)![1];
    for (const p of extras.match(/"[^"]+"/g)!) expect(p, p).toMatch(/\.(get|list)"$/);
  });

  it("limits the IAM admin binding to the three roles Zenith's drivers bind", () => {
    const block = main.match(/resource "google_project_iam_member" "deploy_iam_grants" \{[\s\S]*?\n\}/)![0];
    expect(block).toContain('role    = "roles/resourcemanager.projectIamAdmin"');
    expect(block).toContain("modifiedGrantsByRole");
    expect(block).toContain("hasOnly");
    const granted = main.match(/grantable_roles = \[([\s\S]*?)\]/)![1].match(/"roles\/[^"]+"/g)!.map((r) => r.slice(1, -1));
    expect(granted.sort()).toEqual(["roles/cloudsql.client", "roles/cloudsql.instanceUser", "roles/logging.logWriter"]);
    // exactly the project-level roles the drivers compile (see compile.test.ts)
    expect(main.match(/projectIamAdmin/g)).toHaveLength(1);
  });

  it("lets deploy write secrets but not read their values", () => {
    const role = main.match(/zenithSecretsManage[\s\S]*?permissions = \[([\s\S]*?)\]/)![1];
    expect(role).toContain("secretmanager.versions.add");
    expect(role).not.toContain("access");
    expect(main).not.toMatch(/deploy_roles = \[[^\]]*secretmanager/);
  });

  it("makes act-as project-wide only when no prefix is given, and says so", () => {
    expect(main).toContain('for_each = var.service_account_name_prefix == "" ? [] : [1]');
    expect(variables).toContain("broader");
  });
});

describe("state bucket", () => {
  it("is private, versioned, protected from force destroy, and only the two accounts can reach it", () => {
    const block = main.match(/resource "google_storage_bucket" "state" \{[\s\S]*?\n\}\n/)![0];
    for (const line of ['uniform_bucket_level_access = true', 'public_access_prevention    = "enforced"', "force_destroy = false", "enabled = true"]) expect(block).toContain(line);
    expect(main).toContain('role   = "roles/storage.objectUser"');
    expect(main).toContain('role   = "roles/storage.objectViewer"');
  });
});

describe("outputs and pins", () => {
  it("exposes the non-secret connection fields Zenith's GcpConnectionConfig needs", () => {
    for (const name of ["workload_identity_provider", "observe_service_account", "deploy_service_account", "state_bucket", "connection"]) expect(outputs).toContain(`output "${name}"`);
    const conn = outputs.match(/output "connection" \{[\s\S]*?\n\}/)![0];
    for (const key of ["provider", "mode", "projectId", "region", "workloadIdentityProvider", "observeServiceAccount", "deployServiceAccount"]) expect(conn).toMatch(new RegExp(`\\b${key}\\s*=`));
    expect(conn).toContain('mode                     = "oidc_web_identity"');
    expect(outputs).not.toMatch(/sensitive|private_key|secret_data|password/);
  });

  it("pins the same provider version and lockfile as Zenith's own gcp provider set", () => {
    expect(read("versions.tf")).toContain(`version = "= ${PROVIDER_PINS.google.version}"`);
    const lock = read(".terraform.lock.hcl");
    expect(lock).toContain('provider "registry.opentofu.org/hashicorp/google"');
    expect(lock).toContain(`version     = "${PROVIDER_PINS.google.version}"`);
    // the google block is byte-identical to the one in Zenith's gcp lockfile
    const googleBlock = (s: string) => s.replace(/\r\n/g, "\n").match(/provider "registry\.opentofu\.org\/hashicorp\/google" \{[\s\S]*?\n\}/)![0];
    expect(googleBlock(lock)).toBe(googleBlock(LOCKFILES.gcp));
  });

  it("has a README that states the validation status and the limits", () => {
    const readme = read("README.md");
    expect(readme).toContain("not been applied");
    expect(readme).toContain("Both accounts are reachable by the same subject");
    expect(readme).toContain("zenith:ws:<workspace>:conn:<connection>");
  });
});

describe.skipIf(bin === undefined)("formatting", () => {
  it("is tofu fmt clean", () => {
    const r = spawnSync(bin!, ["fmt", "-check", "-diff", "-no-color", DIR], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!networkEnabled)("tofu validate (network)", () => {
  it(
    "initializes with the committed lockfile and validates against hashicorp/google 8.5.0",
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-gcp-bootstrap-"));
      try {
        for (const f of readdirSync(DIR)) if (/\.tf$|^\.terraform\.lock\.hcl$/.test(f)) cpSync(path.join(DIR, f), path.join(dir, f));
        const env = {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", USERPROFILE: dir, APPDATA: path.join(dir, "AppData") } : { HOME: dir }),
          TF_IN_AUTOMATION: "1",
          TF_INPUT: "0",
          CHECKPOINT_DISABLE: "1",
          TF_PLUGIN_CACHE_DIR: process.env.ZENITH_TOFU_PLUGIN_CACHE ?? path.join(os.tmpdir(), "zenith-tofu-plugin-cache"),
        } as unknown as NodeJS.ProcessEnv;
        const init = spawnSync(bin!, ["init", "-input=false", "-backend=false", "-lockfile=readonly", "-no-color"], { cwd: dir, env, encoding: "utf8", timeout: 600_000 });
        expect(init.status, init.stdout + init.stderr).toBe(0);
        const v = spawnSync(bin!, ["validate", "-json", "-no-color"], { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
        const out = JSON.parse(v.stdout) as { valid: boolean; diagnostics: { severity: string; summary: string }[] };
        expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(out.valid).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    720_000
  );
});
