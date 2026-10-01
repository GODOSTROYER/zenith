/**
 * What a tofu child process can see (WS-SEC).
 *
 * ADR-0005: "tofu runs with an allowlisted environment only (brokered cloud
 * creds, TF_* settings); the control plane's environment never reaches
 * plugins." Provider plugins, provisioners and (if one ever slipped past the
 * assembler) `local-exec` all inherit tofu's environment, so the environment IS
 * the blast radius of a compromised configuration.
 *
 * Part 1 spawns real OpenTofu with a `local-exec` provisioner that prints its
 * environment (the provisioner is hand-built here, bypassing the assembler on
 * purpose — the assembler is tested elsewhere; this asks "IF code runs, what does
 * it inherit?") while the parent process carries canaries for every control-plane
 * secret the platform uses, and checks the printed environment by NAME and by
 * VALUE.
 *
 * Part 2 checks the session/extras validator (`validateExtraEnv`). Finding
 * SEC-F6 (LOW, hardening): the validator is a DENYLIST (`ZENITH_*`, `TF_*`,
 * `TOFU_*` and runner-owned names). The `AwsSession.childProcessEnv()` contract
 * says "AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN/REGION only", but nothing
 * enforces it: a session can carry `LD_PRELOAD`, `NODE_OPTIONS`,
 * `AWS_ENDPOINT_URL*`, `AWS_CA_BUNDLE`, `AWS_CONFIG_FILE`, … which change what
 * code the child loads or where its credentialed API calls go. The broker is
 * trusted today, so this is not exploitable today; it is the difference between
 * "the env is an allowlist" (what ADR-0005 says) and "the env is a denylist on
 * top of an allowlist" (what the code does).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv, TofuEnvError, validateExtraEnv } from "@/lib/tofu/env";
import { TofuRunner } from "@/lib/tofu/runner";
import { stableJson } from "@/lib/tofu/stable";
import { EMPTY_LOCKFILE } from "@/lib/tofu/providers";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { configDigestOf, lockDigestOf } from "@/lib/tofu/workspace";
import { tofuOnPath } from "../tofu/_helpers";
import { assertNoCanaries, canarySecret } from "../_support/security";

const hasTofu = tofuOnPath();
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function printEnvWorkspace(statePath: string): TofuWorkspace {
  const printEnv = process.platform === "win32" ? "set" : "env";
  const files = [
    { path: "backend.tf.json", content: stableJson({ terraform: { backend: { local: { path: statePath } } } }) },
    { path: "main.tf.json", content: stableJson({ resource: { terraform_data: { probe: { provisioner: [{ "local-exec": { command: printEnv } }] } } } }) },
    { path: "versions.tf.json", content: stableJson({ terraform: { required_version: "= 1.12.5" } }) },
  ];
  return { files, lockfile: EMPTY_LOCKFILE, configDigest: configDigestOf(files), lockDigest: lockDigestOf(EMPTY_LOCKFILE), addressMap: {}, backend: "local" };
}

/** Every control-plane secret the platform design names, in the environment it would live in. */
const CONTROL_PLANE_ENV = [
  "ZENITH_SECRET_KEY",
  "ZENITH_CONTROL_SIGNING_JWK",
  "ZENITH_OIDC_SIGNING_JWK",
  "ZENITH_PLATFORM_DB_URL",
  "ZENITH_BACKUP_KEY",
  "ZENITH_AGENT_CREDENTIAL_FILE",
  "DATABASE_URL",
  "SUPABASE_DB_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TEMPORAL_API_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "KUBECONFIG",
  "SSH_AUTH_SOCK",
  "VERCEL_OIDC_TOKEN",
] as const;

describe.skipIf(!hasTofu)("part 1: a provisioner inside real tofu inherits nothing of the control plane's environment", () => {
  const runner = new TofuRunner({ limits: { timeoutMs: 180_000 } });

  it(
    "no control-plane variable — by name or by value — reaches the child; only the brokered session variables do",
    async () => {
      const planted = new Map<string, string>();
      const saved = new Map<string, string | undefined>();
      for (const name of CONTROL_PLANE_ENV) {
        saved.set(name, process.env[name]);
        const value = canarySecret(`host-${name}`, name.includes("KEY") || name.includes("TOKEN") || name.includes("SECRET") ? "aws-secret-access-key" : "password");
        planted.set(name, value);
        process.env[name] = value;
      }
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-sec-env-"));
      dirs.push(dir);
      try {
        const session = {
          childProcessEnv: () => ({
            AWS_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE1",
            AWS_SECRET_ACCESS_KEY: "session-secret-value-0001",
            AWS_SESSION_TOKEN: "session-token-value-0002",
            AWS_REGION: "ap-south-1",
          }),
        };
        const output = await runner.run(printEnvWorkspace(path.join(dir, "terraform.tfstate")), { session }, async (run) => {
          await run.init();
          await run.plan();
          const plan = await run.normalizedPlan();
          return (await run.apply({ expectedPlanDigest: plan.planDigest })).result.output;
        });

        // by value: nothing the parent held shows up
        assertNoCanaries(output, [...planted.values()], "a tofu provisioner's environment contains none of the control plane's secrets");

        // by name: only allowlisted names (plus what the OS shell itself adds) are present
        // the apply log prefixes each provisioner line (`terraform_data.probe (local-exec): NAME=value`), so match mid-line
        const names = new Set([...output.matchAll(/(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]));
        for (const name of CONTROL_PLANE_ENV) {
          // the session legitimately sets the AWS_* trio, redacted in the output; the rest must be absent
          if (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(name)) continue;
          expect(names.has(name), `${name} must not be in the provisioner's environment`).toBe(false);
        }
        expect([...names].filter((n) => /^ZENITH_|^SUPABASE_|^TEMPORAL_|^VERCEL_/.test(n)), "no platform-prefixed variable").toEqual([]);

        // the session's own values are in the child (it needs them) but redacted from what comes back
        expect(names.has("AWS_REGION")).toBe(true);
        for (const secret of ["session-secret-value-0001", "session-token-value-0002", "AKIAEXAMPLEEXAMPLE1"]) expect(output, secret).not.toContain(secret);
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
    240_000
  );

  it(
    "hostile ambient variables (LD_PRELOAD, NODE_OPTIONS, proxies, cert bundles, HOME) in the PARENT are not inherited",
    async () => {
      const ambient: Record<string, string> = {
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        NODE_OPTIONS: "--require /tmp/evil.js",
        HTTP_PROXY: "http://proxy.exfil.invalid:3128",
        HTTPS_PROXY: "http://proxy.exfil.invalid:3128",
        SSL_CERT_FILE: "/tmp/evil-ca.pem",
        AWS_CA_BUNDLE: "/tmp/evil-ca.pem",
        AWS_ENDPOINT_URL: "http://exfil.invalid",
        AWS_CONFIG_FILE: "/tmp/evil-config",
        BASH_ENV: "/tmp/evil.sh",
        GOFLAGS: "-toolexec=/tmp/evil",
      };
      const saved = new Map<string, string | undefined>(Object.keys(ambient).map((k) => [k, process.env[k]]));
      Object.assign(process.env, ambient);
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-sec-env2-"));
      dirs.push(dir);
      try {
        const output = await runner.run(printEnvWorkspace(path.join(dir, "terraform.tfstate")), {}, async (run) => {
          await run.init();
          await run.plan();
          const plan = await run.normalizedPlan();
          return (await run.apply({ expectedPlanDigest: plan.planDigest })).result.output;
        });
        for (const name of Object.keys(ambient)) expect(output, `${name} must not be inherited`).not.toMatch(new RegExp(`(?<![A-Za-z0-9_])${name}=`));
        expect(output).not.toContain("exfil.invalid");
        expect(output).not.toContain("/tmp/evil");
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
    240_000
  );

  it(
    "the per-run directory (workspace, plan file, private HOME/TMP) is removed when the run ends",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-sec-env3-"));
      dirs.push(dir);
      const ws = printEnvWorkspace(path.join(dir, "terraform.tfstate"));
      const run = await runner.open(ws);
      const workDir = run.workDir;
      const { existsSync } = await import("node:fs");
      expect(existsSync(workDir)).toBe(true);
      await run.dispose();
      expect(existsSync(workDir), "the workspace directory must not outlive the run (it can hold a plan file with unmasked values)").toBe(false);
    },
    60_000
  );
});

describe("part 2: the session and extras validator", () => {
  const dirsIn = { homeDir: "/run/home", tmpDir: "/run/tmp", cliConfigFile: "/run/tofu.rc", pluginCacheDir: "/cache", platform: "linux" as const };

  it("refuses names that would change what tofu does or expose control-plane configuration (the denylist works)", () => {
    for (const name of ["TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_LOG", "TF_LOG_PATH", "TF_VAR_anything", "TF_REATTACH_PROVIDERS", "TF_DATA_DIR", "TF_WORKSPACE", "TOFU_CLI_ARGS", "ZENITH_SECRET_KEY", "ZENITH_ANYTHING", "zenith_lowercase", "PATH", "HOME", "Path", "SYSTEMROOT"]) {
      expect(() => validateExtraEnv({ [name]: "x" }, "Session"), name).toThrow(TofuEnvError);
    }
  });

  it("refuses malformed names and values (shell metacharacters in a name, NUL in a value)", () => {
    for (const name of ["A B", "A=B", "A;B", "A\nB", "$(x)", "1ABC", "", "A-B", "A.B"]) {
      expect(() => validateExtraEnv({ [name]: "x" }, "Session"), JSON.stringify(name)).toThrow(TofuEnvError);
    }
    expect(() => validateExtraEnv({ OK: "a\0b" }, "Session")).toThrow(/NUL/);
  });

  it("the runner-owned variables always win over anything a session supplies", () => {
    const env = buildChildEnv({ ...dirsIn, sessionEnv: { AWS_REGION: "x" } });
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.HOME).toBe("/run/home");
    expect(env.TF_INPUT).toBe("0");
  });

  /**
   * SEC-F6. `AwsSession.childProcessEnv()` is documented (credentials/types.ts)
   * as "AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN/REGION only". These names change
   * what code the child loads or where its credentialed calls go, and the
   * validator accepts every one of them today. When a session allowlist lands
   * this starts failing: flip it to `it`.
   */
  it.fails("SEC-F6 (LOW, hardening): a session may carry only the variables its contract names", () => {
    const dangerous = [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "GOFLAGS",
      "GODEBUG",
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_STS",
      "AWS_CA_BUNDLE",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_ROLE_ARN",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ];
    const accepted = dangerous.filter((name) => {
      try {
        validateExtraEnv({ [name]: "x" }, "Session");
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted, "session environment names accepted although they can redirect or re-identify the child").toEqual([]);
  });
});
