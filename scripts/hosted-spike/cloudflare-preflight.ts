/** Standalone test-resource inspection; never imported by the product. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectionUrl, isRecord, isTestName, readMetadata, ReadFailure,
  type FetchLike, type InspectionEndpoint,
} from "./cloudflare-client";

export interface TestApp {
  appKey: string;
  release: string;
  broker: string;
  d1Id: string;
}
export interface SpikeConfig { accountId: string; namespace: string; apps: [TestApp, TestApp] }
interface CliOptions { live: boolean; config: SpikeConfig }
type ReadbackStatus = "not-run" | "blocked" | "failed" | "passed";

export interface Evidence {
  schemaVersion: 1;
  tool: "hosted-spike/cloudflare-preflight";
  contractVersion: 1;
  nodeVersion: string;
  startedAt: string;
  finishedAt: string | null;
  scope: "test-script-binding-configuration-only";
  mode: "offline" | "live-read-only";
  localValidation: { status: "passed" | "blocked"; detail: string };
  configurationDigest?: string;
  configurationReadback: {
    status: ReadbackStatus;
    source: "not-run" | "cloudflare-api" | "injected-test-transport";
    completedRequests: number;
    checks: { target: string; endpoint: InspectionEndpoint; status: "passed" | "blocked" | "failed"; code: string }[];
    detail: string;
  };
  broaderEvidence: {
    identity: "not-run"; revocation: "not-run"; egress: "not-run"; isolation: "not-run";
    health: "not-run"; build: "not-run"; quotas: "not-run"; immutableRelease: "not-run";
    d02D08Compliance: "blocked-missing-report";
  };
}

export class ConfigFailure extends Error {
  constructor(message: string) { super(message); this.name = "ConfigFailure"; }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateConfig(value: unknown): SpikeConfig {
  if (!isRecord(value) || Object.keys(value).some((key) => !["accountId", "namespace", "apps"].includes(key))) {
    throw new ConfigFailure("Configuration must contain only accountId, namespace and exactly two apps.");
  }
  if (typeof value.accountId !== "string" || !/^[a-f0-9]{32}$/.test(value.accountId)) {
    throw new ConfigFailure("Provide --account-id as 32 lowercase hexadecimal characters.");
  }
  if (!isTestName(value.namespace)) throw new ConfigFailure("Provide --namespace as a test-prefixed lowercase name (maximum 63 characters).");
  if (!Array.isArray(value.apps) || value.apps.length !== 2) throw new ConfigFailure("Provide exactly two --app appKey:release:broker:d1Uuid selectors.");
  const apps: TestApp[] = value.apps.map((app) => {
    if (!isRecord(app) || Object.keys(app).length !== 4 || Object.keys(app).some((key) => !["appKey", "release", "broker", "d1Id"].includes(key))
        || !isTestName(app.appKey) || !isTestName(app.release) || !isTestName(app.broker)
        || typeof app.d1Id !== "string" || !UUID.test(app.d1Id)) {
      throw new ConfigFailure("Each app needs test-prefixed lowercase app/release/broker names and a lowercase D1 UUID; extra fields are forbidden.");
    }
    if (!app.release.startsWith(`${app.appKey}-`) || !app.broker.startsWith(`${app.appKey}-`)) {
      throw new ConfigFailure("Each release and broker name must start with its own app key followed by a hyphen.");
    }
    return { appKey: app.appKey, release: app.release, broker: app.broker, d1Id: app.d1Id };
  });
  if (new Set(apps.map((a) => a.appKey)).size !== 2 || new Set(apps.map((a) => a.d1Id)).size !== 2
      || new Set(apps.flatMap((a) => [a.release, a.broker])).size !== 4) {
    throw new ConfigFailure("Use two distinct app keys, two distinct D1 UUIDs and four distinct release/broker names.");
  }
  if (apps.some((app, i) => app.appKey.startsWith(`${apps[1 - i].appKey}-`))) {
    throw new ConfigFailure("App keys must not be nested prefixes of one another.");
  }
  return { accountId: value.accountId, namespace: value.namespace, apps: apps as [TestApp, TestApp] };
}

export function parseArgs(args: readonly string[]): CliOptions {
  let accountId: string | undefined;
  let namespace: string | undefined;
  let live = false;
  const apps: unknown[] = [];
  const seen = new Set<string>();
  if (args.length > 11) throw new ConfigFailure("Too many arguments. Use --help for the bounded two-app syntax.");
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--account-id", "--namespace", "--app", "--live-read-only"].includes(flag)) {
      throw new ConfigFailure("Unknown argument. Use --help; token, file, URL and provisioning options are not supported.");
    }
    if (flag !== "--app" && seen.has(flag)) throw new ConfigFailure("Duplicate option. Specify each option once except --app, which is required twice.");
    seen.add(flag);
    if (flag === "--live-read-only") { live = true; continue; }
    const input = args[++i];
    if (!input || input.startsWith("--") || input.length > 256) throw new ConfigFailure("An option is missing its bounded value. Use --help for the exact syntax.");
    if (flag === "--account-id") accountId = input;
    if (flag === "--namespace") namespace = input;
    if (flag === "--app") {
      const parts = input.split(":");
      if (parts.length !== 4) throw new ConfigFailure("Use --app appKey:release:broker:d1Uuid with exactly four colon-separated fields.");
      const [appKey, release, broker, d1Id] = parts;
      apps.push({ appKey, release, broker, d1Id });
    }
  }
  return { live, config: validateConfig({ accountId, namespace, apps }) };
}

type Binding = { name: "ASSETS"; type: "assets" } | { name: "DB"; type: "d1"; database_id: string };

class PolicyFailure extends Error {
  constructor(public readonly code: string, public readonly blocked = false) { super(code); }
}

function checkedBindings(value: unknown, expectedD1?: string): Binding[] {
  if (!Array.isArray(value)) throw new PolicyFailure("binding-array-missing", true);
  if (value.length > 1) throw new PolicyFailure("extra-or-duplicate-binding");
  if (expectedD1 && value.length !== 1) throw new PolicyFailure("broker-db-binding-missing");
  return value.map((binding) => {
    if (!isRecord(binding)) throw new PolicyFailure("malformed-binding");
    if (!expectedD1) {
      if (binding.type !== "assets" || binding.name !== "ASSETS"
          || Object.keys(binding).some((key) => !["type", "name"].includes(key))) {
        throw new PolicyFailure("release-binding-not-allowlisted");
      }
      return { name: "ASSETS", type: "assets" };
    }
    if (binding.type !== "d1" || binding.name !== "DB"
        || Object.keys(binding).some((key) => !["type", "name", "database_id", "id"].includes(key))) {
      throw new PolicyFailure("broker-binding-not-allowlisted");
    }
    if (binding.database_id !== expectedD1 || ("id" in binding && binding.id !== expectedD1)) {
      throw new PolicyFailure("broker-database-mismatch");
    }
    return { name: "DB", type: "d1", database_id: expectedD1 };
  });
}

export interface PreflightDependencies {
  fetch?: FetchLike;
  /** Lazy so offline mode cannot inspect credentials, even if supplied. */
  getToken?: () => string | undefined;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runPreflight(args: readonly string[], deps: PreflightDependencies = {}): Promise<{ exitCode: 0 | 1 | 2; evidence: Evidence }> {
  const evidence: Evidence = {
    schemaVersion: 1,
    tool: "hosted-spike/cloudflare-preflight",
    contractVersion: 1,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    scope: "test-script-binding-configuration-only",
    mode: args.includes("--live-read-only") ? "live-read-only" : "offline",
    localValidation: { status: "blocked", detail: "Configuration has not been validated." },
    configurationReadback: { status: "not-run", source: "not-run", completedRequests: 0, checks: [], detail: "Configuration readback was not run; no Cloudflare request was made." },
    broaderEvidence: {
      identity: "not-run", revocation: "not-run", egress: "not-run", isolation: "not-run",
      health: "not-run", build: "not-run", quotas: "not-run", immutableRelease: "not-run",
      d02D08Compliance: "blocked-missing-report",
    },
  };
  const finish = (exitCode: 0 | 1 | 2) => {
    evidence.finishedAt = new Date().toISOString();
    return { exitCode, evidence };
  };
  let options: CliOptions;
  try { options = parseArgs(args); }
  catch (error) {
    evidence.localValidation.detail = error instanceof ConfigFailure ? error.message : "Configuration could not be validated; values were discarded.";
    return finish(2);
  }
  const config = options.config;
  evidence.localValidation = { status: "passed", detail: "Two test app selectors are locally valid. Their existence and ownership have not been verified." };
  evidence.configurationDigest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  if (!options.live) return finish(0);

  const readback = evidence.configurationReadback;
  let token: string | undefined;
  try { token = (deps.getToken ?? (() => process.env.HOSTED_SPIKE_CLOUDFLARE_API_TOKEN))(); }
  catch { /* A credential source's exception may itself contain secrets. */ }
  if (!token || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) {
    readback.status = "blocked";
    readback.detail = "Set HOSTED_SPIKE_CLOUDFLARE_API_TOKEN in this process through your secret manager, with Workers Scripts Read for the test account; no .env files are loaded.";
    return finish(2);
  }
  readback.source = deps.fetch ? "injected-test-transport" : "cloudflare-api";
  for (let index = 0; index < config.apps.length; index++) {
    const app = config.apps[index];
    for (const role of ["release", "broker"] as const) {
      const target = `app-${index + 1}/${role}`;
      let prior: Binding[] | undefined;
      for (const endpoint of ["bindings", "settings"] as const) {
        try {
          // Construct only the documented two metadata endpoints; no arbitrary
          // baseURL/path is accepted from argv, env or the remote response.
          inspectionUrl(config.accountId, config.namespace, app[role], endpoint);
          const result = await readMetadata({ ...config, script: app[role], endpoint, token, signal: deps.signal }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
          readback.completedRequests++;
          if (endpoint === "settings" && !isRecord(result)) throw new PolicyFailure("settings-object-missing", true);
          const current = checkedBindings(endpoint === "bindings" ? result : (result as Record<string, unknown>).bindings, role === "broker" ? app.d1Id : undefined);
          if (prior && JSON.stringify(prior) !== JSON.stringify(current)) throw new PolicyFailure("binding-readback-changed");
          prior = current;
          readback.checks.push({ target, endpoint, status: "passed", code: "binding-policy-matched" });
        } catch (error) {
          const blocked = error instanceof PolicyFailure ? error.blocked
            : error instanceof ReadFailure && ["credentials-rejected", "resource-unavailable", "rate-limited", "aborted", "invalid-token"].includes(error.code);
          readback.status = blocked ? "blocked" : "failed";
          const code = error instanceof ReadFailure || error instanceof PolicyFailure ? error.code : "inspection-failed";
          readback.checks.push({ target, endpoint, status: readback.status, code });
          readback.detail = error instanceof ReadFailure ? error.message
            : error instanceof PolicyFailure && error.blocked ? "The documented binding configuration was absent; readback cannot certify this target."
            : "Test binding configuration did not match the strict policy, or inspection failed. Remote values were discarded.";
          return finish(blocked ? 2 : 1);
        }
      }
    }
  }
  readback.status = "passed";
  readback.detail = "All eight metadata responses matched the binding policy at read time. This is not an atomic snapshot, immutable artifact check, or runtime security proof. Other settings are not certified.";
  return finish(0);
}

export const HELP = `Cloudflare test binding preflight (offline by default)
Usage: npx --no-install tsx scripts/hosted-spike/cloudflare-preflight.ts
  --account-id <32-lowercase-hex> --namespace <test-name>
  --app <test-app-key:test-release:test-broker:d1-uuid> (exactly twice)
  [--live-read-only]

Names must start with test-; each release/broker starts with its app key plus '-'.
Live mode requires HOSTED_SPIKE_CLOUDFLARE_API_TOKEN in the process environment.
Only eight bounded GETs to api.cloudflare.com are possible. No provisioning,
dispatch, customer data, .env loading or production configuration is supported.
Exit 0: requested local validation/readback passed; 1: readback failed;
2: blocked by missing/invalid configuration, credentials, resource or cancellation.
Read README.md for the limits: no identity/revocation/egress/isolation/health/build
or D02/D08 compliance is established by this command.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(HELP); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runPreflight(args, { signal: controller.signal });
    console.log(JSON.stringify(result.evidence, null, 2));
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    // Never print exceptions, stacks, token-bearing headers or remote bodies.
    console.error("Preflight stopped unexpectedly. No runtime evidence was established.");
    process.exitCode = 1;
  });
}
