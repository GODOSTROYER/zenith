/**
 * The plan → approve → verified apply flow of ADR-0005.
 *
 *   planWorkspace(ws, session)          init + plan + show → NormalizedPlan
 *                                        (approval binds to `plan.planDigest`)
 *   applyVerifiedPlan(ws, {approvedDigest, session})
 *                                        init + plan again, normalize, compare:
 *                                        a different digest throws
 *                                        `TofuPlanChangedError` and applies
 *                                        NOTHING; the same digest applies the
 *                                        plan file that was just produced and
 *                                        re-verified (never an older file).
 *
 * The approved plan file itself is deliberately not what gets applied: state,
 * data sources and the cloud may have moved since approval, and a stale saved
 * plan would apply against them. Re-planning and comparing digests turns any
 * such movement into a refused apply and a new approval.
 *
 * Plan files (binary, may embed unmasked values) go only to the caller; when
 * `planDir` is given they are written there with mode 0600. They must never be
 * placed on a model-visible surface — hand models `planView(plan)` instead.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlanNormalizeBase, TofuSessionEnv } from "@/lib/tofu/runner";
import { TofuRunner } from "@/lib/tofu/runner";
import type { NormalizedPlan, TofuRunLimits, TofuRunResult, TofuWorkspace } from "@/lib/tofu/types";

export interface EngineOptions {
  /** defaults to a process-wide runner configured from `ZENITH_TOFU_BIN` / `ZENITH_TOFU_PLUGIN_CACHE` */
  runner?: TofuRunner;
  signal?: AbortSignal;
  limits?: Partial<TofuRunLimits>;
  normalize?: PlanNormalizeBase;
}

export interface PlanWorkspaceOptions extends EngineOptions {
  /** keep the binary plan file here as `<planDigest>.tfplan` (mode 0600) */
  planDir?: string;
}

export interface PlanWorkspaceResult {
  plan: NormalizedPlan;
  /** binary plan file — server-side only */
  planFile: Buffer;
  planFilePath?: string;
}

export interface ApplyVerifiedResult {
  plan: NormalizedPlan;
  apply: TofuRunResult;
  /** non-sensitive outputs after apply (sensitive ones are dropped) */
  outputs: Record<string, { sensitive: boolean; type: unknown; value?: unknown }>;
}

let shared: TofuRunner | undefined;
function defaultRunner(): TofuRunner {
  shared ??= new TofuRunner();
  return shared;
}

export async function planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
  const runner = opts.runner ?? defaultRunner();
  const result = await runner.run(ws, { session, signal: opts.signal, limits: opts.limits }, async (run) => {
    await run.init();
    await run.plan();
    const plan = await run.normalizedPlan(opts.normalize);
    const planFile = await run.readPlanFile();
    return { plan, planFile };
  });
  let planFilePath: string | undefined;
  if (opts.planDir) {
    await mkdir(opts.planDir, { recursive: true, mode: 0o700 });
    planFilePath = path.join(opts.planDir, `${result.plan.planDigest}.tfplan`);
    await writeFile(planFilePath, result.planFile, { mode: 0o600 });
  }
  return { ...result, planFilePath };
}

export async function applyVerifiedPlan(
  ws: TofuWorkspace,
  args: { approvedDigest: string; session?: TofuSessionEnv } & EngineOptions
): Promise<ApplyVerifiedResult> {
  const runner = args.runner ?? defaultRunner();
  return runner.run(ws, { session: args.session, signal: args.signal, limits: args.limits }, async (run) => {
    await run.init();
    await run.plan();
    // re-runs `show -json` on the plan file it applies; throws TofuPlanChangedError on a moved digest
    const { plan, result } = await run.apply({ expectedPlanDigest: args.approvedDigest, normalize: args.normalize });
    const outputs = await run.output();
    return { plan, apply: result, outputs };
  });
}
