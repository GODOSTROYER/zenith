/** Local scenario planning and strict receipts. No engine is started by this module. */
import { z } from "zod";
import path from "node:path";
import catalog from "../../deploy/acceptance/local-targets/scenarios.json";
import type { LocalCommandLane, Scenario } from "./scenarios";
import { DRIVER_CHECKS, OperatedReceiptSchema, OPERATED_LABEL } from "./drivers/operated-contract";

export const LOCAL_GATE = "ZENITH_LOCAL_TARGETS";
export const LOCAL_LABEL = "local_rehearsal";
export type LocalTarget = { target: string; driver?: string; owner?: string };
export const LOCAL_TARGETS: Readonly<Record<string, LocalTarget>> = {
  ...catalog.scenarios,
  "drift-repair": { target: "operated-drv2", driver: "scripts/release/drivers/drift-repair.ts", owner: "DRV-2" },
  "crash-partition": { target: "operated-drv2", driver: "scripts/release/drivers/crash-partition.ts", owner: "DRV-2" },
};
export const TARGET_CHECKS: Readonly<Record<string, readonly string[]>> = {
  mixed: ["traffic-acknowledged", "independent-readback", "tls-peer-auth", "private-database"],
  pebble: ["dns-http01", "certificate-issued", "tls-hostname"],
  economics: ["priced", "transfer", "latency", "residency"],
  contracts: ["contracts"],
  billing: ["customer", "invoice", "independent-invoice-read"],
};

export function localTargetLane(scenario: Scenario): LocalCommandLane {
  const target = LOCAL_TARGETS[scenario.id];
  if (!target) throw new Error(`No local target for ${scenario.id}`);
  const operated = target.target === "operated-drv2";
  return {
    id: "local-target", kind: "local_engine", files: ["scripts/release/local-target-runner.ts", "deploy/acceptance/local-targets/scenarios.json", ...(operated ? [target.driver!, "scripts/release/drivers/operated.ts", "scripts/release/drivers/operated-contract.ts"] : [])],
    command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/release/local-target-runner.ts", "run", "--scenario", scenario.id],
    gates: ["ZENITH_LOCAL_TARGETS=1", "ZENITH_LOCAL_RUN_ID", "ZENITH_LOCAL_ROOT", ...(operated ? ["ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "ZENITH_TEST_DRV2_OPERATED=1"] : [])],
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
const AnyReceipt = z.union([Receipt, OperatedReceiptSchema]);
export type LocalReceipt = z.infer<typeof AnyReceipt>;

export function requiredChecks(scenarioId: string): readonly string[] {
  if (scenarioId === "drift-repair" || scenarioId === "crash-partition") return DRIVER_CHECKS[scenarioId];
  if (scenarioId === "billing") return TARGET_CHECKS.billing!;
  const target = LOCAL_TARGETS[scenarioId];
  if (!target) throw new Error("Unknown local scenario");
  const checks = TARGET_CHECKS[target.target] ?? [`scenario-${scenarioId}`];
  return scenarioId === "mixed-recovery" ? [...checks, "partition-unavailable", "partition-recovered", "outage-readback"] : checks;
}

export function validateLocalReceipt(raw: unknown, expected: { scenarioId: string; runId: string; sourceCommit: string }): LocalReceipt {
  const receipt = AnyReceipt.parse(raw);
  if ((expected.scenarioId === "drift-repair" || expected.scenarioId === "crash-partition") && receipt.evidenceLabel !== OPERATED_LABEL) throw new Error("Operated scenario cannot accept component or generic rehearsal evidence");
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
  // Node reads extra CAs at child startup. Admit only the explicit J1 fixture's public CA.
  if (env.ZENITH_ACCEPTANCE_DEFAULT_STACK === "1" && env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR && path.isAbsolute(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR)) clean.NODE_EXTRA_CA_CERTS = path.join(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "tls/ca.crt");
  return clean;
}
