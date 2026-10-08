/** Adapt owned J1/J2/J4 evidence without inventing a pass for an uncovered scenario. */
import { readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { defaultExec } from "./acceptance-orchestrator";
import { requiredChecks, validateLocalReceipt, type LocalReceipt } from "./local-targets";
import { readiness } from "../acceptance/default-stack/readiness.mjs";
import { readState } from "../acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../acceptance/default-stack/env.mjs";
import { operatedScenario } from "./drivers/contracts";

const JOURNEY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "plan-approval": ["self-approval-refused", "bearer-approval-refused", "stale-semantics-refused", "browser-kind-execution-readback", "rest-proposal-execution-readback", "mcp-proposal-execution-readback"],
  rotation: ["connection-rotation-readback"],
  revocation: ["connection-revocation-no-fallback"],
  teardown: ["cleanup"],
};
/** J4 uses a fresh database on J1's owned local server and a separate API/namespace. */
export function maintenanceEnvironment(base: NodeJS.ProcessEnv, overlay: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = new Set(["ZENITH_PLATFORM_DB_URL", "ZENITH_PLATFORM_DB_MAX", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE", "ZENITH_J4_API_ORIGIN", "ZENITH_J4_CRON_SECRET_FILE", "ZENITH_DATA", "ZENITH_SERVERLESS", "ZENITH_BILLING"]);
  if (Object.keys(overlay).some(key => !allowed.has(key))) throw new Error("Unknown maintenance overlay field");
  const environment = { ...base, ...overlay };
  const owner = new URL(base.ZENITH_PLATFORM_DB_URL ?? ""), database = new URL(environment.ZENITH_PLATFORM_DB_URL ?? "");
  const localHost = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (!localHost(owner.hostname) || !localHost(database.hostname) || database.port !== owner.port
    || database.username !== owner.username || database.password !== owner.password || database.search !== owner.search || database.hash
    || !["postgres:", "postgresql:"].includes(database.protocol) || !/^\/[A-Za-z0-9_-]+$/.test(database.pathname)) throw new Error("Maintenance database must use J1's exact local server and credentials");
  const api = new URL(environment.ZENITH_J4_API_ORIGIN ?? "");
  if (!localHost(api.hostname) || !["http:", "https:"].includes(api.protocol) || api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw new Error("Maintenance API must be local");
  if (!/^j4-[a-z0-9-]{1,50}$/.test(environment.ZENITH_TEMPORAL_NAMESPACE ?? "")
    || !/^(127\.0\.0\.1|localhost):\d+$/.test(environment.ZENITH_TEMPORAL_ADDRESS ?? "")
    || environment.ZENITH_SERVERLESS !== "1" || environment.ZENITH_BILLING !== "managed" || environment.ZENITH_PLATFORM_DB_MAX !== "2"
    || environment.ZENITH_BILLING_STRIPE_SECRET_KEY || environment.ZENITH_CONTROL_KMS_KEY_ID
    || !path.isAbsolute(environment.ZENITH_J4_CRON_SECRET_FILE ?? "") || !path.isAbsolute(environment.ZENITH_DATA ?? "")) throw new Error("Fresh isolated J4 maintenance configuration required");
  environment.SUPABASE_DB_URL = environment.ZENITH_PLATFORM_MIGRATION_URL = database.href;
  return environment;
}
export function journeyScenarioStatus(scenario: string, evidence: unknown): "passed" | "failed" | "skipped" {
  const required = JOURNEY_CHECKS[scenario];
  if (!required) return "skipped";
  if (!evidence || typeof evidence !== "object" || !("checks" in evidence) || !Array.isArray(evidence.checks)) return "failed";
  const checks = evidence.checks as { id?: unknown; status?: unknown }[];
  if (new Set(checks.map(item => item.id)).size !== checks.length) return "failed";
  if (!required.every(id => checks.some(item => item.id === id && item.status === "passed"))) return "failed";
  return "status" in evidence && evidence.status === "passed" ? "passed" : "failed";
}
export async function runJoinedScenario(input: { scenarioId: string; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const { scenarioId, runId, sourceCommit, receiptFile, env } = input;
  if (env.ZENITH_LOCAL_JOINED_DRIVERS !== "1" || env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || !env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR || existsSync(receiptFile)) throw new Error("Owned default stack and explicit joined-driver gates required");
  // J1 proves ownership, source bytes, native architecture, migrations and readiness.
  const state = readState(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
  if (operatedScenario(scenarioId)) {
    if (env.ZENITH_LOCAL_OPERATED !== "1") return 2;
    // Start with J1's private CA at process launch, so real Auth requests verify TLS.
    const child = await defaultExec([process.execPath, "node_modules/tsx/dist/cli.mjs", `scripts/release/drivers/${scenarioId}.ts`,
      "--run-id", runId, "--source-commit", sourceCommit, "--receipt", receiptFile],
      { cwd: process.cwd(), env: { ...env, ...hostEnvironment(state) }, timeoutMs: 3_600_000 });
    if (child.code === 2) return 2;
    const receipt = validateLocalReceipt(JSON.parse(readFileSync(receiptFile, "utf8")), { scenarioId, runId, sourceCommit });
    return child.code === 0 && receipt.checks.every(check => check.status === "passed") ? 0 : 1;
  }
  const ready = await readiness(state);
  Object.assign(env, hostEnvironment(state));
  let status: "passed" | "failed" | "skipped" = "passed";
  const limits = ["Owned local rehearsal only; no live cloud or production acceptance."];
  if (scenarioId === "install") {
    if (ready.failed !== 0 || ready.skipped !== 0 || ready.passed < 1) status = "failed";
  } else if (scenarioId === "machine-schedules") {
    if (env.ZENITH_TEST_MAINTENANCE !== "1") throw new Error("J4 natural-timer gate required");
    const file = env.ZENITH_LOCAL_MAINTENANCE_ENV_FILE;
    if (!file || !path.isAbsolute(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || (lstatSync(file).mode & 0o077) !== 0) throw new Error("Private J4 maintenance overlay FILE required");
    const overlay: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Z][A-Z0-9_]*)=([^\0]*)$/.exec(line);
      if (!match || match[1] in overlay) throw new Error("Malformed or duplicate maintenance overlay field");
      overlay[match[1]] = match[2];
    }
    const child = await defaultExec([process.execPath, "node_modules/tsx/dist/cli.mjs", "scripts/acceptance/maintenance/run.ts"], { cwd: process.cwd(), env: maintenanceEnvironment(env, overlay), timeoutMs: 1_080_000 });
    if (child.code !== 0) throw new Error("J4 natural maintenance acceptance failed; retain the owned engines for inspection");
    const evidence = JSON.parse(child.stdout.trim()) as Record<string, unknown>;
    if (evidence.naturalTimers !== true || evidence.workerRestart !== true || evidence.fallbackResumed !== true || evidence.jobLeaseExclusion !== true) status = "failed";
    limits.push("J4 default scheduling evidence; provider machine transports remain separately gated.");
  } else {
    const config = env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    if (!config || !path.isAbsolute(config) || lstatSync(config).isSymbolicLink() || !lstatSync(config).isFile() || env.ZENITH_DEFAULT_JOURNEY !== "1") throw new Error("Private J2 configuration and journey gate required");
    const output = `${receiptFile}.journey.json`;
    const child = await defaultExec([process.execPath, "scripts/acceptance/default-journey.mjs", "--config", config, "--receipt", output], { cwd: process.cwd(), env, timeoutMs: 1_080_000 });
    status = child.code === 0 ? journeyScenarioStatus(scenarioId, JSON.parse(readFileSync(output, "utf8"))) : "failed";
    if (status === "skipped") limits.push("The J2 journey has no independent check for this scenario. This receipt is incomplete; run its dedicated acceptance lane.");
  }
  const receipt: LocalReceipt = { schema: 1, evidenceLabel: "local_rehearsal", scenarioId, runId, sourceCommit, checks: requiredChecks(scenarioId).map(id => ({ id, status })), limits };
  validateLocalReceipt(receipt, { scenarioId, runId, sourceCommit });
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return status === "passed" ? 0 : status === "skipped" ? 3 : 1;
}
