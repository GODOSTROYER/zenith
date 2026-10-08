/** Local scenario planning and strict receipts. No engine is started by this module. */
import { z } from "zod";
import catalog from "../../deploy/acceptance/local-targets/scenarios.json";
import type { LocalCommandLane, Scenario } from "./scenarios";
import { DRIVER_CHECKS, OPERATED_LABEL, validateOperatedReceipt } from "./drivers/protocol";

export const LOCAL_GATE = "ZENITH_LOCAL_TARGETS";
export const LOCAL_LABEL = "local_rehearsal";
export type LocalTarget = { target: string; driver?: string; owner?: string };
export const LOCAL_TARGETS: Readonly<Record<string, LocalTarget>> = catalog.scenarios;
export const TARGET_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "operated-two-tenants": DRIVER_CHECKS["two-tenants"],
  "operated-export": DRIVER_CHECKS.export,
  mixed: ["traffic-acknowledged", "independent-readback", "tls-peer-auth", "private-database"],
  pebble: ["dns-http01", "certificate-issued", "tls-hostname"],
  economics: ["priced", "transfer", "latency", "residency"],
  contracts: ["contracts"],
  billing: ["customer", "invoice", "independent-invoice-read"],
};

export function localTargetLane(scenario: Scenario): LocalCommandLane {
  const target = LOCAL_TARGETS[scenario.id];
  if (!target) throw new Error(`No local target for ${scenario.id}`);
  const operated = scenario.id === "two-tenants" || scenario.id === "export";
  return {
    id: "local-target", kind: "local_engine", files: ["scripts/release/local-target-runner.ts", "deploy/acceptance/local-targets/scenarios.json", ...(operated ? [target.driver!, "scripts/release/drivers/operated.ts", "scripts/release/drivers/protocol.ts"] : []),
      ...(scenario.id === "export" ? ["scripts/release/drivers/export-data.ts", "scripts/release/drivers/export-data-plan.ts", "scripts/release/drivers/export-data-leg.ts", "scripts/release/drivers/export-data-postgres.ts", "scripts/release/drivers/export-data-mysql.ts", "scripts/release/drivers/export-data-objects.ts"] : [])],
    command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/release/local-target-runner.ts", "run", "--scenario", scenario.id],
    gates: ["ZENITH_LOCAL_TARGETS=1", "ZENITH_LOCAL_RUN_ID", "ZENITH_LOCAL_ROOT", ...(operated ? ["ZENITH_LOCAL_DRIVER_D4=1", "ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"] : []),
      ...(scenario.id === "export" ? ["ZENITH_LOCAL_EXPORT_DATA=1", "ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE", "ZENITH_LOCAL_EXPORT_MYSQL_IMAGE", "ZENITH_LOCAL_EXPORT_MINIO_IMAGE"] : [])],
    evidenceLabel: operated ? OPERATED_LABEL : LOCAL_LABEL,
  };
}

const Receipt = z.object({
  schema: z.literal(1), evidenceLabel: z.literal(LOCAL_LABEL),
  scenarioId: z.string().regex(/^[a-z][a-z0-9-]{1,50}$/),
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,19}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  checks: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,70}$/), status: z.enum(["passed", "failed", "skipped"]) }).strict()).min(1),
  limits: z.array(z.string().min(1).max(300)).min(1),
}).strict();
export type LocalReceipt = z.infer<typeof Receipt>;

export function requiredChecks(scenarioId: string): readonly string[] {
  if (scenarioId === "billing") return TARGET_CHECKS.billing!;
  const target = LOCAL_TARGETS[scenarioId];
  if (!target) throw new Error("Unknown local scenario");
  const checks = TARGET_CHECKS[target.target] ?? [`scenario-${scenarioId}`];
  return scenarioId === "mixed-recovery" ? [...checks, "partition-unavailable", "partition-recovered", "outage-readback"] : checks;
}

export function validateLocalReceipt(raw: unknown, expected: { scenarioId: string; runId: string; sourceCommit: string }): LocalReceipt | ReturnType<typeof validateOperatedReceipt> {
  if (expected.scenarioId === "two-tenants" || expected.scenarioId === "export") return validateOperatedReceipt(raw, expected);
  const receipt = Receipt.parse(raw);
  for (const key of ["scenarioId", "runId", "sourceCommit"] as const) if (receipt[key] !== expected[key]) throw new Error(`Local receipt ${key} mismatch`);
  const ids = receipt.checks.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate local check");
  for (const id of requiredChecks(expected.scenarioId)) if (!ids.includes(id)) throw new Error(`Missing required local check: ${id}`);
  return receipt;
}

/** Restrict all external HTTP seams to literal loopback; redirects are refused by callers. */
export function loopbackUrl(raw: string, port: number): URL {
  const url = new URL(raw);
  if (!["127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) throw new Error("A dedicated literal loopback target is required");
  return url;
}

export function localEnvironment(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const [key, value] of Object.entries(env)) {
    if (value && (/^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|SystemRoot|COMSPEC|DOCKER_HOST|DOCKER_CONTEXT|KUBECONFIG)$/i.test(key) || /^ZENITH_(LOCAL_|TEST_)/.test(key) || ["ZENITH_DEFAULT_JOURNEY", "ZENITH_ACCEPTANCE_DEFAULT_STACK", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"].includes(key))) clean[key] = value;
  }
  clean.AWS_EC2_METADATA_DISABLED = "true";
  return clean;
}
