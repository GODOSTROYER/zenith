/** Closed DRV-2 evidence vocabulary. Pure contracts never establish an operated pass. */
import { z } from "zod";

export const OPERATED_LABEL = "local_operated_rehearsal";
export const DRIVER_CHECKS = {
  "drift-repair": ["prerequisites", "approved-workload", "drift-injected", "drift-observed", "repair-browser-approved", "repair-independent-readback", "fresh-clean-observation", "cleanup"],
  "crash-partition": ["prerequisites", "approved-workload", "crash-injected", "outage-traffic", "restart-readback", "partition-injected", "partition-no-write", "survivor-readback", "writers-serialized", "stale-writer-no-duplicate", "cleanup"],
} as const;
export type DriverScenario = keyof typeof DRIVER_CHECKS;
export const DRIVER_READBACKS = {
  "drift-repair": ["baseline", "drift", "repaired", "clean"],
  "crash-partition": ["baseline", "outage", "restarted", "partition", "survivor", "writers", "rejoined"],
} as const;
export const DRIVER_LIMITS = {
  "drift-repair": ["Owned lean J1 stack and J2 kind workload only; no live cloud or production acceptance.", "Kubernetes replica drift is repaired by an approved service.scale operation; Kubernetes has no drift.repair handler. Automatic repair and escalation are separate component lanes."],
  "crash-partition": ["Owned lean J1 stack and J2 kind workload only; no live cloud or production acceptance.", "SIGKILL and Docker network disconnection exercise queued workflow recovery and competing environment writers. In-flight provider delivery ambiguity and mixed-provider outages remain separate gated lanes."],
} as const;
const Check = z.object({ id: z.string(), status: z.enum(["passed", "failed", "skipped"]) }).strict();
export const OperatedReceiptSchema = z.object({
  schema: z.literal(1), evidenceLabel: z.literal(OPERATED_LABEL),
  scenarioId: z.enum(["drift-repair", "crash-partition"]),
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,19}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), dirty: z.boolean(),
  checks: z.array(Check), limits: z.array(z.string()),
  readbacks: z.array(z.object({ target: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
}).strict().superRefine((value, context) => {
  const checks: readonly string[] = DRIVER_CHECKS[value.scenarioId];
  if (value.checks.length !== checks.length || value.checks.some((check, index) => check.id !== checks[index])) context.addIssue({ code: "custom", message: "Exact ordered operated check inventory required" });
  if (JSON.stringify(value.limits) !== JSON.stringify(DRIVER_LIMITS[value.scenarioId])) context.addIssue({ code: "custom", message: "Fixed operated limitations required" });
  const targets: readonly string[] = DRIVER_READBACKS[value.scenarioId];
  const seen = new Set<string>();
  for (const readback of value.readbacks) {
    if (!targets.includes(readback.target) || seen.has(readback.target)) context.addIssue({ code: "custom", message: "Unknown or duplicate readback" });
    seen.add(readback.target);
  }
  if (value.checks.every(check => check.status === "passed") && targets.some(target => !seen.has(target))) context.addIssue({ code: "custom", message: "Passing operated evidence requires every independent readback" });
});
export type OperatedReceipt = z.infer<typeof OperatedReceiptSchema>;

/** Observer credentials must be inline and local. An exec plugin or alternate cluster is never a readback path. */
export function observerBinding(raw: unknown, caData: string): string {
  const value = z.object({
    "current-context": z.literal("kind-zenith-j2"),
    contexts: z.array(z.object({ name: z.literal("kind-zenith-j2"), context: z.object({ cluster: z.string(), user: z.string() }).strict() })).length(1),
    clusters: z.array(z.object({ name: z.string(), cluster: z.object({ server: z.string(), "certificate-authority-data": z.string().min(1) }).strict() })).length(1),
    users: z.array(z.object({ name: z.string(), user: z.object({ "client-certificate-data": z.string().min(1), "client-key-data": z.string().min(1) }).strict() })).length(1),
  }).parse(raw);
  const cluster = value.clusters[0], user = value.users[0], context = value.contexts[0];
  const server = new URL(cluster.cluster.server);
  if (context.context.cluster !== cluster.name || context.context.user !== user.name || cluster.cluster["certificate-authority-data"] !== caData || server.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(server.hostname) || !server.port || server.username || server.password || server.pathname !== "/" || server.search || server.hash) throw new Error("Owned literal loopback observer required");
  return JSON.stringify(value);
}

/** Project only hashes and fixed vocabulary; diagnostics and provider bodies cannot escape. */
export function operatedReceipt(input: {
  scenarioId: DriverScenario; runId: string; sourceCommit: string; sourceDigest: string; dirty: boolean;
  checks: readonly { id: string; status: "passed" | "failed" | "skipped" }[]; readbacks: Readonly<Record<string, string>>;
}): OperatedReceipt {
  if (new Set(input.checks.map(check => check.id)).size !== input.checks.length || input.checks.some(check => !(DRIVER_CHECKS[input.scenarioId] as readonly string[]).includes(check.id))) throw new Error("Invalid operated facts");
  return OperatedReceiptSchema.parse({
    schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: input.scenarioId, runId: input.runId,
    sourceCommit: input.sourceCommit, sourceDigest: input.sourceDigest, dirty: input.dirty,
    checks: DRIVER_CHECKS[input.scenarioId].map(id => ({ id, status: input.checks.find(check => check.id === id)?.status ?? "skipped" })),
    readbacks: DRIVER_READBACKS[input.scenarioId].filter(target => input.readbacks[target]).map(target => ({ target, sha256: input.readbacks[target] })),
    limits: [...DRIVER_LIMITS[input.scenarioId]],
  });
}

export function driverPlan(scenarioId: DriverScenario, env: Readonly<Record<string, string | undefined>>): { checks: readonly string[]; missing: string[] } {
  const gates = ["ZENITH_LOCAL_TARGETS", "ZENITH_LOCAL_JOINED_DRIVERS", "ZENITH_ACCEPTANCE_DEFAULT_STACK", "ZENITH_DEFAULT_JOURNEY", "ZENITH_TEST_DRV2_OPERATED"];
  const missing = gates.filter(key => env[key] !== "1");
  for (const key of ["ZENITH_LOCAL_ROOT", "ZENITH_LOCAL_RUN_ID", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"]) if (!env[key]) missing.push(key);
  return { checks: DRIVER_CHECKS[scenarioId], missing };
}

/** All cleanup attempts run in registration order, including after an earlier failure. */
export class OwnedCleanup {
  private readonly tasks: (() => Promise<void>)[] = [];
  add(task: () => Promise<void>): void { this.tasks.push(task); }
  async run(): Promise<void> {
    let failed = false;
    for (const task of this.tasks) { try { await task(); } catch { failed = true; } }
    if (failed) throw new Error("Owned cleanup incomplete");
  }
}
