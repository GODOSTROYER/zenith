/**
 * Helpers the scenario definitions share: pass-criterion recording, prerequisite
 * builders, the sample-app fixture loader, and the two pieces of choreography
 * several live scenarios need (waiting for a human approval, adopting resources
 * into the run).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { adoptEnvironmentResources } from "../adopt";
import { regionsFor } from "../cleanup";
import type { LiveConfig } from "../config";
import type { CheckMode } from "../evidence";
import { isTerminalStatus, waitForOperation, type ControlPlaneClient, type OperationViewLike, type ProposeResponse } from "../clients/control-plane";
import { requireClient, type PassCriterion, type Prerequisite, type ScenarioContext, type ScenarioId } from "../types";

/** Record results against a scenario's declared pass criteria (an unknown id is a programming error). */
export function checker(scenario: ScenarioId, criteria: readonly PassCriterion[], defaultMode?: CheckMode) {
  const text = (id: string): string => {
    const c = criteria.find((x) => x.id === id);
    if (!c) throw new Error(`Scenario ${scenario} has no pass criterion "${id}".`);
    return c.text;
  };
  return {
    pass: (ctx: ScenarioContext, id: string, detail?: string, mode?: CheckMode) => ctx.evidence.pass(scenario, id, text(id), detail, mode ?? defaultMode),
    fail: (ctx: ScenarioContext, id: string, detail?: string, mode?: CheckMode) => ctx.evidence.fail(scenario, id, text(id), detail, mode ?? defaultMode),
    skip: (ctx: ScenarioContext, id: string, reason: string) => ctx.evidence.skip(scenario, id, text(id), reason),
    /** pass when `ok`, fail otherwise; the detail says what was observed either way */
    expect: (ctx: ScenarioContext, id: string, ok: boolean, detail: string, mode?: CheckMode) => (ok ? ctx.evidence.pass(scenario, id, text(id), detail, mode ?? defaultMode) : ctx.evidence.fail(scenario, id, text(id), detail, mode ?? defaultMode)),
  };
}

/* ------------------------------- prerequisites ------------------------------ */

export const configPrerequisite = (id: string, description: string, ok: (c: LiveConfig) => boolean, fix: string): Prerequisite => ({
  id,
  description,
  kind: "offline",
  check: (ctx) => (ok(ctx.config) ? { ok: true } : { ok: false, detail: fix }),
});

export const toolPrerequisite = (id: string, tool: "tofu" | "docker"): Prerequisite => ({
  id,
  description: `${tool} is installed on this machine`,
  kind: "offline",
  check: () => {
    if (tool === "tofu") {
      try {
        return { ok: true, detail: resolveTofuBinary() };
      } catch {
        return { ok: false, detail: "OpenTofu was not found (set ZENITH_TOFU_BIN or put tofu on PATH)" };
      }
    }
    const dirs = (process.env.PATH ?? "").split(path.delimiter);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
    return dirs.some((d) => exts.some((e) => existsSync(path.join(d, `docker${e}`)))) ? { ok: true } : { ok: false, detail: "docker was not found on PATH" };
  },
});

export const controlPlaneReachable: Prerequisite = {
  id: "control-plane-reachable",
  description: "the Zenith control plane answers with the configured token",
  kind: "control-plane",
  async check(ctx) {
    if (!ctx.controlPlane) return { ok: false, detail: "no control plane client (ZENITH_LIVE_API_URL / ZENITH_LIVE_API_TOKEN)" };
    const r = await ctx.controlPlane.ping();
    return r.ok ? { ok: true, detail: `HTTP ${r.status}` } : { ok: false, detail: r.status === 0 ? "unreachable" : `HTTP ${r.status}` };
  },
};

export const liveControlPlaneConfig = configPrerequisite("control-plane-config", "ZENITH_LIVE_API_URL, ZENITH_LIVE_API_TOKEN and ZENITH_LIVE_CONNECTION_ID are set", (c) => !!c.apiUrl && !!c.apiToken && !!c.connectionId, "set ZENITH_LIVE_API_URL, ZENITH_LIVE_API_TOKEN and ZENITH_LIVE_CONNECTION_ID");

export const awsTargetConfig = configPrerequisite("aws-target", "ZENITH_LIVE_AWS_ACCOUNT_ID and a region are set", (c) => !!c.awsAccountId && !!c.region, "set ZENITH_LIVE_AWS_ACCOUNT_ID and ZENITH_LIVE_REGION (or --region)");

export const dependsOnEarlier = (id: ScenarioId): Prerequisite => ({
  id: `after-${id}`,
  description: `scenario ${id} completed earlier in this run`,
  kind: "offline",
  check: (ctx) => (ctx.earlier.includes(id) ? { ok: true } : { ok: false, detail: `run it as --scenario ${id},<this scenario>` }),
});

/* ------------------------------- the sample app ------------------------------ */

/** The repository root: the harness is run from it (`npx tsx scripts/acceptance/aws-live.ts`). */
export function repoRoot(): string {
  const root = process.cwd();
  if (!existsSync(path.join(root, "fixtures", "acceptance-app", "server.mjs"))) {
    throw new Error("Run the harness from the repository root (fixtures/acceptance-app/server.mjs was not found under the working directory).");
  }
  return root;
}

export function fixtureDir(): string {
  return path.join(repoRoot(), "fixtures", "acceptance-app");
}

/** The sample app's files, as an analysis snapshot input (paths relative to the app, as a repository root). */
export function loadFixtureFiles(dir: string = fixtureDir()): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) files[name] = readFileSync(path.join(dir, name), "utf8");
  return files;
}

/* ---------------------------- operations and approval ------------------------- */

export const cp = (ctx: ScenarioContext): ControlPlaneClient => requireClient(ctx.controlPlane, "The Zenith control plane client");

export interface ApprovalOutcome {
  /** `policy_allowed`: policy let it run unattended; `human`: a person approved it in the browser */
  mode: "policy_allowed" | "human";
  operation: OperationViewLike;
  approverIsHuman: boolean;
  waitedMs: number;
}

/**
 * Get a proposed operation past its approval gate. The harness NEVER approves:
 * approval is a browser-session-only endpoint by design (no token, integration
 * or agent can reach it). If policy requires approval the harness prints the
 * proposal digest and waits, up to `approvalTimeoutMs`, for a person.
 */
export async function awaitApproval(ctx: ScenarioContext, proposed: ProposeResponse): Promise<ApprovalOutcome> {
  const started = ctx.now().getTime();
  const id = proposed.operation.id;
  if (proposed.decision.outcome === "deny") {
    throw new Error(`Policy denied operation ${id}: ${proposed.decision.reasons.map((r) => r.code).join(", ") || "no reason given"}.`);
  }
  if (proposed.decision.outcome === "allow") {
    return { mode: "policy_allowed", operation: proposed.operation, approverIsHuman: false, waitedMs: 0 };
  }
  ctx.log(`APPROVAL NEEDED: a person must approve operation ${id} in the Zenith web app (proposal digest ${String(proposed.operation.proposalDigest ?? "unknown").slice(0, 16)}…). Waiting up to ${Math.round(ctx.config.approvalTimeoutMs / 60_000)} min.`);
  const waited = await waitForOperation(cp(ctx), id, {
    until: (op) => ["approved", "queued", "running", "succeeded"].includes(op.status),
    timeoutMs: ctx.config.approvalTimeoutMs,
    pollMs: 5_000,
    sleep: ctx.sleep,
    now: () => ctx.now().getTime(),
    signal: ctx.signal,
  });
  if (!waited.reached) {
    throw new Error(waited.timedOut ? `Nobody approved operation ${id} within ${Math.round(ctx.config.approvalTimeoutMs / 60_000)} minutes.` : `Operation ${id} ended ${waited.operation.status} without being approved.`);
  }
  const detail = await cp(ctx).getOperation(id);
  const approver = detail.approvals.find((a) => a.decision === "approve");
  const proposer = detail.operation.principal?.id;
  return { mode: "human", operation: detail.operation, approverIsHuman: approver !== undefined && approver.approverId !== proposer, waitedMs: ctx.now().getTime() - started };
}

/** Wait for an operation to reach a terminal state and record it as evidence. */
export async function awaitTerminal(ctx: ScenarioContext, scenario: ScenarioId, operationId: string, timeoutMs: number, onPoll?: () => Promise<void>): Promise<OperationViewLike> {
  const r = await waitForOperation(cp(ctx), operationId, {
    until: (op) => isTerminalStatus(op.status),
    timeoutMs,
    pollMs: 10_000,
    sleep: ctx.sleep,
    now: () => ctx.now().getTime(),
    signal: ctx.signal,
    onPoll: onPoll ? async () => onPoll() : undefined,
  });
  ctx.evidence.operation(scenario, { operationId, capability: r.operation.capability, status: r.operation.status, ...(r.operation.error ? { detail: r.operation.error } : {}) });
  if (!r.reached) throw new Error(`Operation ${operationId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes (last status ${r.operation.status}).`);
  return r.operation;
}

/* ----------------------------- adoption into the run -------------------------- */

/** Environment ids this run created (recorded by scenario A). */
export const environmentIds = (ctx: ScenarioContext): string[] => (ctx.state.get("a.environmentIds") as string[] | undefined) ?? [];

/** One adoption pass; failures are noted in the evidence, not thrown (the caller is mid-deploy). */
export async function adoptNow(ctx: ScenarioContext, scenario: ScenarioId): Promise<number> {
  const ids = environmentIds(ctx);
  if (!ctx.session || ids.length === 0) return 0;
  try {
    const report = await adoptEnvironmentResources({ access: ctx.session.aws(), runId: ctx.runId, environmentIds: ids, regions: regionsFor(ctx.session.region) });
    if (report.adopted.length > 0) ctx.evidence.note(`Adopted ${report.adopted.length} resource(s) into run ${ctx.runId}.`, scenario);
    for (const s of report.skipped.slice(0, 5)) ctx.evidence.note(`Not adopted: ${s.arn} (${s.reason}).`, scenario);
    return report.adopted.length;
  } catch (err) {
    ctx.evidence.note(`Adoption pass failed (${err instanceof Error ? err.name : "error"}); cleanup will retry.`, scenario);
    return 0;
  }
}

/** The operator-facing URL where a person approves; derived from the control plane origin. */
export const approvalHint = (ctx: ScenarioContext): string => `${ctx.config.apiUrl ?? "(control plane)"}  → Operations → approve`;
