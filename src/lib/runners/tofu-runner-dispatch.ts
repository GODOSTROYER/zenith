/**
 * OpenTofu on a customer-side runner (`tofu.run` jobs), control-plane half.
 *
 *   planOnRunner(ws, target)              plan job → the runner keeps the binary plan
 *                                         file and returns `planJson` + `planFileSha256`;
 *                                         THIS side normalizes `planJson` (`normalizePlan`)
 *                                         and computes the plan digest — the runner never
 *                                         re-implements normalization.
 *   applyVerifiedOnRunner(ws, {approved}) fresh plan job → normalize → compare with the
 *                                         approved digest → `TofuPlanChangedError` and NOTHING
 *                                         applied on a mismatch; otherwise an apply job carrying
 *                                         the `planFileSha256` of THAT fresh plan. The runner
 *                                         applies exactly the retained file whose sha256 it is
 *                                         given, and only one it produced itself for the same
 *                                         `configDigest` (plans are single-use, retained <= 24 h).
 *
 * This is the runner-side twin of `applyVerifiedPlan` in `src/lib/tofu/engine.ts`
 * and obeys the same rule: an approval binds to a plan digest, never to an
 * older plan file.
 *
 * The raw `planJson` (which holds sensitive values in plaintext next to its
 * `*_sensitive` markers) exists only in the awaiting process's memory: it is
 * sealed in the store (`seal.ts`), opened by `awaitRunnerJob`, normalized, and
 * dropped. Nothing here logs or returns it; the caller gets the masked
 * `NormalizedPlan` only.
 */
import { redactOutput } from "@/lib/tofu/redact";
import { configDigestOf, lockDigestOf } from "@/lib/tofu/config-digest";
import { normalizePlan, type ShowJson } from "@/lib/tofu/plan";
import type { PlanNormalizeBase } from "@/lib/tofu/runner";
import { TofuPlanChangedError, type NormalizedPlan, type TofuWorkspace } from "@/lib/tofu/types";
import { awaitRunnerJob, DispatchError, enqueueRunnerJob, requireSucceeded } from "@/lib/runners/dispatch";
import type { TofuRunPayload } from "@/lib/runners/payloads";
import { getRunnerRuntime, type RunnerRuntime } from "@/lib/runners/runtime";
import { unverifiedClaims } from "@/lib/runners/signing";

const HEX64 = /^[0-9a-f]{64}$/;

export interface RunnerTofuTarget {
  workspaceId: string;
  runnerId: string;
  /** the provider connection the run acts through; its binding is re-proved at dispatch */
  connectionId?: string;
  operationId: string;
  /** capability grant for the apply (for a plan-only call with no `planGrant`, the plan's) */
  grant: string;
  /** grant for plan jobs (`planOnRunner`, and the fresh plan of `applyVerifiedOnRunner`) when it differs from `grant` */
  planGrant?: string;
  timeoutSec?: number;
  queueTtlSec?: number;
  maxOutputBytes?: number;
  normalize?: PlanNormalizeBase;
  signal?: AbortSignal;
  runtime?: RunnerRuntime;
}

/* ---------------------------------- payloads ---------------------------------- */

/**
 * Build a `tofu.run` payload from a workspace. Refuses a workspace whose files
 * or lockfile no longer match its digests (a truncated or edited workspace must
 * not run under an approval made for another one).
 */
export function buildTofuRunPayload(ws: TofuWorkspace, command: "plan" | "apply" | "show", opts: { planFileSha256?: string; destroy?: boolean } = {}): TofuRunPayload {
  const actual = configDigestOf(ws.files);
  if (actual !== ws.configDigest) throw new DispatchError("invalid_payload", `The workspace files do not match its configDigest (${ws.configDigest.slice(0, 12)} ≠ ${actual.slice(0, 12)}).`);
  if (lockDigestOf(ws.lockfile) !== ws.lockDigest) throw new DispatchError("invalid_payload", "The workspace lockfile does not match its lockDigest.");
  const files = [...ws.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ path: f.path, contentB64: Buffer.from(f.content, "utf8").toString("base64") }));
  return {
    command,
    files,
    lockfile: ws.lockfile,
    configDigest: ws.configDigest,
    ...(opts.planFileSha256 !== undefined ? { planFileSha256: opts.planFileSha256 } : {}),
    ...(opts.destroy ? { destroy: true } : {}),
  };
}

/* ----------------------------------- plan ----------------------------------- */

export interface RunnerPlanResult {
  /** masked, normalized, digest-bearing; the only plan representation callers get */
  plan: NormalizedPlan;
  /** sha256 of the binary plan file the runner retained */
  planFileSha256: string;
  runnerId: string;
  /** the workspace the plan was made for */
  configDigest: string;
  jobId: string;
  exitCode: number;
  /** the runner's redacted tofu output */
  output: string;
}

interface RunnerTofuResult {
  exitCode?: number;
  output?: string;
  planJson?: unknown;
  planFileSha256?: string;
}

const claimsCap = (grant: string): string => String(unverifiedClaims(grant)?.cap ?? "");

async function runJob(rt: RunnerRuntime, target: RunnerTofuTarget, grant: string, payload: TofuRunPayload): Promise<{ jobId: string; result: RunnerTofuResult }> {
  const jobId = await enqueueRunnerJob(
    {
      workspaceId: target.workspaceId,
      runnerId: target.runnerId,
      ...(target.connectionId !== undefined ? { bindingConnectionId: target.connectionId } : {}),
      operationId: target.operationId,
      capability: claimsCap(grant),
      kind: "tofu.run",
      payload,
      grant,
      timeoutSec: target.timeoutSec,
      queueTtlSec: target.queueTtlSec,
      maxOutputBytes: target.maxOutputBytes,
    },
    rt
  );
  const awaited = await awaitRunnerJob<RunnerTofuResult>(jobId, { workspaceId: target.workspaceId, signal: target.signal }, rt);
  return { jobId, result: requireSucceeded(awaited).result };
}

/** Run `tofu plan` on the runner and normalize the result here. */
export async function planOnRunner(ws: TofuWorkspace, target: RunnerTofuTarget, opts: { destroy?: boolean; grant?: string } = {}): Promise<RunnerPlanResult> {
  const rt = target.runtime ?? (await getRunnerRuntime());
  const payload = buildTofuRunPayload(ws, "plan", { destroy: opts.destroy });
  const { jobId, result } = await runJob(rt, target, opts.grant ?? target.planGrant ?? target.grant, payload);
  if (typeof result.planFileSha256 !== "string" || !HEX64.test(result.planFileSha256)) throw new DispatchError("invalid_payload", "The runner's plan result carries no planFileSha256; it cannot be applied.");
  if (result.planJson === null || typeof result.planJson !== "object" || Array.isArray(result.planJson)) throw new DispatchError("invalid_payload", "The runner's plan result carries no planJson.");
  const plan = normalizePlan(result.planJson as ShowJson, {
    configDigest: ws.configDigest,
    lockDigest: ws.lockDigest,
    addressMap: ws.addressMap,
    ...target.normalize,
  });
  return {
    plan,
    planFileSha256: result.planFileSha256,
    runnerId: target.runnerId,
    configDigest: ws.configDigest,
    jobId,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    output: redactOutput(String(result.output ?? "")),
  };
}

/* ----------------------------------- apply ----------------------------------- */

/**
 * The guard: an apply may be issued only with the `planFileSha256` of a plan
 * for THIS workspace, produced by THIS runner, whose normalized digest equals
 * the approved one. Throws `TofuPlanChangedError` on a digest mismatch (nothing
 * is applied, a new approval is needed) and a `DispatchError` for the rest.
 */
export function assertApplyAllowed(planned: RunnerPlanResult, args: { approvedDigest: string; ws: TofuWorkspace; runnerId: string }): void {
  if (planned.runnerId !== args.runnerId) throw new DispatchError("invalid_input", "The plan file lives on another runner; an apply must go to the runner that produced the plan.");
  if (planned.configDigest !== args.ws.configDigest || planned.plan.configDigest !== args.ws.configDigest) throw new DispatchError("invalid_input", "The plan was made for a different workspace configuration.");
  if (!HEX64.test(planned.planFileSha256)) throw new DispatchError("invalid_input", "planFileSha256 must be 64 lowercase hex characters.");
  if (planned.plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, planned.plan.planDigest);
}

export interface RunnerApplyResult {
  /** the fresh plan whose digest equalled the approved one */
  plan: NormalizedPlan;
  planJobId: string;
  applyJobId: string;
  exitCode: number;
  /** the runner's redacted tofu output */
  output: string;
}

/**
 * Fresh plan → digest check → apply of exactly that plan. Throws
 * `TofuPlanChangedError` (applies nothing) when the plan moved since approval.
 * An `apply` job that ends with an unknown outcome throws a `RunnerJobError`
 * with `uncertain === true`: mark the operation `uncertain`, never retry.
 */
export async function applyVerifiedOnRunner(ws: TofuWorkspace, target: RunnerTofuTarget & { approvedDigest: string; destroy?: boolean }): Promise<RunnerApplyResult> {
  const rt = target.runtime ?? (await getRunnerRuntime());
  const planned = await planOnRunner(ws, { ...target, runtime: rt }, { destroy: target.destroy, grant: target.planGrant ?? target.grant });
  assertApplyAllowed(planned, { approvedDigest: target.approvedDigest, ws, runnerId: target.runnerId });
  const payload = buildTofuRunPayload(ws, "apply", { planFileSha256: planned.planFileSha256 });
  const { jobId, result } = await runJob(rt, target, target.grant, payload);
  return {
    plan: planned.plan,
    planJobId: planned.jobId,
    applyJobId: jobId,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    output: redactOutput(String(result.output ?? "")),
  };
}
