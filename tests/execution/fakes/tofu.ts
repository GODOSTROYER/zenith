/**
 * Scripted OpenTofu port (`TofuPort`). It stands where the real engine stands:
 * the activities call `planWorkspace` and `applyVerifiedPlan` exactly as they
 * would the real ones and get a `NormalizedPlan` back. NOT OpenTofu: nothing is
 * planned or applied; the plan is whatever the test built. The real engine is
 * exercised separately in journey.test.ts.
 *
 * Like the real `planWorkspace`, when given a `planDir` it writes a binary plan
 * file there (mode 0600) — here containing a canary — so tests can assert that
 * the file stays in `planDir`, is removed after the apply, and never reaches the
 * evidence ledger or an activity result.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApplyVerifiedResult, EngineOptions, PlanWorkspaceOptions, PlanWorkspaceResult } from "@/lib/tofu/engine";
import type { TofuSessionEnv } from "@/lib/tofu/runner";
import { TofuCommandError } from "@/lib/tofu/runner";
import { TofuPlanChangedError, type NormalizedPlan, type TofuRunResult, type TofuWorkspace } from "@/lib/tofu/types";
import type { TofuPort } from "@/lib/execution/ports";
import { CANARY_SECRET, makePlan } from "./fixtures";

export const PLAN_FILE_CANARY = `FAKE-BINARY-PLAN-FILE-${CANARY_SECRET}`;

const run = (command: TofuRunResult["command"], exitCode = 1): TofuRunResult => ({ command, exitCode, output: "", truncated: false, durationMs: 7 });

export type ApplyBehaviour = "ok" | "fail_apply" | "fail_plan_before_apply" | "timeout" | "abort" | "unclassified" | "plan_changed" | "hang" | "fail_output";

export class FakeTofu implements TofuPort {
  readonly planCalls: { ws: TofuWorkspace; opts: PlanWorkspaceOptions; envKeys: string[] }[] = [];
  readonly applyCalls: { ws: TofuWorkspace; approvedDigest: string; envKeys: string[]; fingerprintKey?: string }[] = [];
  /** the plan each `planWorkspace` call returns */
  planFactory: (ws: TofuWorkspace, call: number) => NormalizedPlan = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest });
  planError: Error | undefined;
  /** `planWorkspace` waits for this before answering (the test holds it) */
  planGate: Promise<void> | undefined;
  apply: ApplyBehaviour = "ok";
  outputs: ApplyVerifiedResult["outputs"] = {
    alb_dns_name: { sensitive: false, type: "string", value: "lb.example.com" },
    db_master_password: { sensitive: true, type: "string" },
  };
  /** an "ok" apply waits for this before returning (the test holds it) */
  applyGate: Promise<void> | undefined;
  /** resolves once an apply has started */
  applyStarted: Promise<void>;
  private markApplyStarted!: () => void;

  constructor() {
    this.applyStarted = new Promise((resolve) => (this.markApplyStarted = resolve));
  }

  async planWorkspace(ws: TofuWorkspace, session?: TofuSessionEnv, opts: PlanWorkspaceOptions = {}): Promise<PlanWorkspaceResult> {
    this.planCalls.push({ ws, opts, envKeys: Object.keys(session?.childProcessEnv?.() ?? {}) });
    if (this.planGate) await this.planGate;
    if (opts.signal?.aborted) throw new TofuCommandError("tofu_aborted", "tofu plan was aborted.", run("plan"));
    if (this.planError) throw this.planError;
    const plan = this.planFactory(ws, this.planCalls.length);
    let planFilePath: string | undefined;
    if (opts.planDir) {
      await mkdir(opts.planDir, { recursive: true, mode: 0o700 });
      planFilePath = path.join(opts.planDir, `${plan.planDigest}.tfplan`);
      await writeFile(planFilePath, PLAN_FILE_CANARY, { mode: 0o600 });
    }
    return { plan, planFile: Buffer.from(PLAN_FILE_CANARY), planFilePath };
  }

  async applyVerifiedPlan(ws: TofuWorkspace, args: { approvedDigest: string; session?: TofuSessionEnv } & EngineOptions): Promise<ApplyVerifiedResult> {
    this.applyCalls.push({ ws, approvedDigest: args.approvedDigest, envKeys: Object.keys(args.session?.childProcessEnv?.() ?? {}), fingerprintKey: args.normalize?.fingerprintKey });
    this.markApplyStarted();
    const plan = this.planFactory(ws, this.planCalls.length + 1);
    switch (this.apply) {
      case "fail_plan_before_apply":
        throw new TofuCommandError("tofu_command_failed", "tofu plan failed with exit code 1.", run("plan"));
      case "plan_changed":
        throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
      case "fail_apply":
        throw new TofuCommandError("tofu_command_failed", "tofu apply failed with exit code 1.", run("apply"));
      case "fail_output":
        throw new TofuCommandError("tofu_command_failed", "tofu output failed with exit code 1.", run("output"));
      case "timeout":
        throw new TofuCommandError("tofu_timeout", "tofu apply timed out after 1800000 ms.", run("apply", -1));
      case "abort":
        throw new TofuCommandError("tofu_aborted", "tofu apply was aborted.", run("apply", -1));
      case "unclassified":
        throw new Error("socket hang up");
      case "hang":
        await new Promise<never>((_, reject) => {
          const fail = (): void => reject(new TofuCommandError("tofu_aborted", "tofu apply was aborted.", run("apply", -1)));
          if (args.signal?.aborted) fail();
          else args.signal?.addEventListener("abort", fail, { once: true });
        });
        break;
      case "ok":
        break;
    }
    if (plan.planDigest !== args.approvedDigest) throw new TofuPlanChangedError(args.approvedDigest, plan.planDigest);
    if (this.applyGate) await this.applyGate;
    return { plan, apply: { command: "apply", exitCode: 0, output: "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.", truncated: false, durationMs: 42 }, outputs: this.outputs };
  }
}
