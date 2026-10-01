/**
 * The plan → approve → verified apply flow of ADR-0005.
 *
 *   planWorkspace(ws, session)          init + plan + show → NormalizedPlan
 *                                        (approval binds to `plan.planDigest`)
 *   planDestroy(ws, session)            the same flow with `plan -destroy`;
 *                                      verified apply also needs `destroy: true`
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
import type { PlanInspector, PlanNormalizeBase, TofuSessionEnv } from "@/lib/tofu/runner";
import type { ResourceNode } from "@/lib/resources/types";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import { TofuRunner } from "@/lib/tofu/runner";
import type { NormalizedPlan, TofuRunLimits, TofuRunResult, TofuWorkspace } from "@/lib/tofu/types";

export interface EngineOptions {
  /** defaults to a process-wide runner configured from `ZENITH_TOFU_BIN` / `ZENITH_TOFU_PLUGIN_CACHE` */
  runner?: TofuRunner;
  signal?: AbortSignal;
  limits?: Partial<TofuRunLimits>;
  normalize?: PlanNormalizeBase;
  /** Plan teardown; apply still consumes a verified saved plan, never auto-approve. */
  destroy?: boolean;
  /** Trusted nodes from the deployed revision, including nodes removed from the new manifest. */
  deletionNodes?: readonly ResourceNode[];
  /** Server-side ownership guard, re-run on the exact file being applied. Never persist raw JSON. */
  inspectPlan?: PlanInspector;
}

export interface PlanWorkspaceOptions extends EngineOptions {
  /** keep the binary plan file here as `<planDigest>.tfplan` (mode 0600) */
  planDir?: string;
  /**
   * Take OpenTofu's state lock (default true). Pass false for a plan made with
   * observe-purpose (read-only) credentials, which cannot write the lock
   * object; the caller must hold the environment's Zenith lease. See
   * `TofuRun.plan`.
   */
  lock?: boolean;
  /**
   * The approved digest a final re-plan must match. A plan that moved is
   * refused by the caller as `plan_changed` and never applied (verified apply
   * re-plans and re-runs the digest check and every guard), so its deletion
   * guards are skipped: the refusal names what actually happened, and no
   * provider is read on behalf of an unapproved plan.
   */
  expectedDigest?: string;
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

function inspector(opts: EngineOptions & Pick<PlanWorkspaceOptions, "expectedDigest">): PlanInspector {
  return async (plan, raw) => {
    if (opts.expectedDigest !== undefined && plan.planDigest !== opts.expectedDigest) return;
    // Harness ownership checks may resolve unmapped state to trusted nodes here.
    await opts.inspectPlan?.(plan, raw);
    if (opts.destroy && plan.resourceChanges.some((c) => !["delete", "no-op", "read"].includes(c.action))) {
      throw new TofuDeletionRefusedError("A destroy plan contains a non-deletion mutation; refusing to apply.");
    }
    // Without trusted nodes the safe answer for a stateful deletion is refusal.
    assertDeletionAllowed(plan, opts.deletionNodes ?? []);
    if (!opts.inspectPlan && plan.resourceChanges.some((c) => ["delete", "replace"].includes(c.action) && ["aws_route53_record", "google_dns_record_set", "azurerm_dns_a_record", "azurerm_dns_cname_record", "oci_dns_rrset"].includes(c.type))) {
      throw new TofuDeletionRefusedError("DNS deletion requires a server-side target ownership guard.");
    }
  };
}

/** A normalized, masked, digest-bound `tofu plan -destroy`. */
export function planDestroy(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
  return planWorkspace(ws, session, { ...opts, destroy: true });
}

export async function planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
  const runner = opts.runner ?? defaultRunner();
  const result = await runner.run(ws, { session, signal: opts.signal, limits: opts.limits }, async (run) => {
    await run.init();
    await run.plan({ lock: opts.lock, ...(opts.destroy ? { destroy: true } : {}) });
    const plan = await run.normalizedPlan(opts.normalize, inspector(opts));
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
    await run.plan(args.destroy ? { destroy: true } : undefined);
    // re-runs `show -json` on the plan file it applies; throws TofuPlanChangedError on a moved digest
    const { plan, result } = await run.apply({ expectedPlanDigest: args.approvedDigest, normalize: args.normalize, inspectPlan: inspector(args) });
    const outputs = await run.output();
    return { plan, apply: result, outputs };
  });
}
