import type { NavigatorRun } from "@/lib/domain/types";
import { isExecutable } from "@/lib/navigator/shared";
import { GIMBAL_STATE, type GimbalState, type GimbalStateInfo } from "./gimbal-contract";

export interface GimbalSignals {
  planning?: boolean;
  running?: boolean;
  cancelling?: boolean;
  error?: string;
  run?: NavigatorRun;
}

const READ_ONLY_ACTIONS = new Set(["deploy.plan", "ops.investigate"]);

/** Only structured evidence can authorize a verified presentation. */
function hasVerification(run: NavigatorRun): boolean {
  const evidence = run.verification;
  return Boolean(
    evidence &&
      evidence.scope === "run" &&
      evidence.source === "provider" &&
      evidence.status === "passed" &&
      evidence.simulated === false &&
      evidence.evidenceRef.trim() &&
      Number.isFinite(Date.parse(evidence.checkedAt)) &&
      Date.parse(evidence.checkedAt) >= Date.parse(run.createdAt)
  );
}

/**
 * Product signals select motion; goal, summary and model wording never do.
 * null is a neutral presentation, not a sixth workflow state or a success.
 */
export function gimbalStateFor({ planning, running, error, run }: GimbalSignals): GimbalState | null {
  if (error) return "blocked";
  // A newly requested plan may coexist with the previous run while it loads.
  if (planning || run?.status === "planning") return "planning";
  if (run?.status === "cancelled") return null;
  if (run?.status === "failed") return "blocked";

  if (running || run?.status === "executing") {
    const activeStep = run?.steps.find((step) => step.status === "running");
    // Executing a read-only planning/inspection action is not applying a plan.
    const readOnlyRun = run && run.steps.length > 0 && run.steps.every((step) => READ_ONLY_ACTIONS.has(step.actionId));
    if (readOnlyRun || (activeStep && READ_ONLY_ACTIONS.has(activeStep.actionId)))
      return "planning";
    return "applying";
  }

  if (!run) return null;
  if (
    run.steps.some(
      (step) => !isExecutable(step.actionId) || step.status === "failed" || step.status === "skipped"
    ) ||
    run.verification?.status === "failed"
  )
    return "blocked";
  if (run.status === "awaiting_approval") return "awaiting_approval";
  if (run.status === "done" && run.steps.some((step) => step.status !== "done")) return "blocked";
  if (
    run.status === "done" &&
    run.steps.length > 0 &&
    run.steps.every((step) => step.status === "done") &&
    run.steps.some((step) => !READ_ONLY_ACTIONS.has(step.actionId)) &&
    hasVerification(run)
  )
    return "verified";
  return null;
}

export function gimbalStateForRun(run: NavigatorRun): GimbalState | null {
  return gimbalStateFor({ run });
}

export interface GimbalPresentation extends GimbalStateInfo {
  state: GimbalState | null;
}

/** Neutral lifecycle labels keep Ready/Completed/Cancelled out of the workflow enum. */
export function gimbalPresentationFor(signals: GimbalSignals): GimbalPresentation {
  const state = gimbalStateFor(signals);
  if (state) return { state, ...GIMBAL_STATE[state] };
  const neutral = { state: null, color: "#aab3d0", tone: "neutral", icon: "pause" } as const;
  const run = signals.run;
  if (run?.status === "cancelled")
    return {
      ...neutral,
      label: "Cancelled",
      description: "The run was cancelled. Completed steps may remain applied; inspect the recorded results.",
    };
  if (run?.status === "done") {
    if (run.verification?.simulated === true)
      return {
        ...neutral,
        label: "Simulation complete",
        description: "The simulation finished. Live provider state has not been verified.",
      };
    const planOnly = run.steps.length > 0 && run.steps.every((step) => step.actionId === "deploy.plan");
    return {
      ...neutral,
      label: planOnly ? "Plan complete" : "Completed",
      description: planOnly
        ? "The plan was prepared. No provider changes were applied or verified."
        : "The recorded steps completed. Provider verification is not available; inspect the recorded results.",
    };
  }
  return {
    ...neutral,
    label: "Ready",
    description: "Give Navigator an outcome to prepare a plan. No run is active.",
  };
}
