/**
 * Progressive rollout planning: what the manifest asks for versus what the provider can do.
 *
 * `rolling` replaces instances through the provider's own deployment controller; Zenith has no
 * say in how traffic moves. `progressive` asks for the candidate to receive explicit traffic
 * percentages (a canary), with a bake period between steps. Only a provider whose release adapter
 * implements weighted traffic can honour it; every other provider REFUSES before anything is
 * deployed, with the reason, rather than quietly doing a rolling replace and calling it a canary.
 */
import { ReleaseSafetyError, type RolloutRecord, type RolloutStrategy } from "./types";

export interface RolloutDeclaration {
  strategy?: RolloutStrategy;
  steps?: readonly number[];
  bakeSec?: number;
}

export const MAX_ROLLOUT_STEPS = 6;
export const MAX_BAKE_SEC = 3600;

export function normalizeRollout(decl: RolloutDeclaration | undefined): RolloutRecord {
  const strategy: RolloutStrategy = decl?.strategy ?? "rolling";
  if (strategy === "rolling") {
    if (decl?.steps && decl.steps.length > 0 && !(decl.steps.length === 1 && decl.steps[0] === 100)) {
      throw new ReleaseSafetyError("invalid_input", "A rolling release has no traffic steps; declare strategy progressive to use them.");
    }
    return { strategy, steps: [100], bakeSec: 0, percent: 0 };
  }
  const steps = decl?.steps && decl.steps.length > 0 ? [...decl.steps] : [10, 100];
  if (steps.length > MAX_ROLLOUT_STEPS) throw new ReleaseSafetyError("invalid_input", `A progressive rollout has at most ${MAX_ROLLOUT_STEPS} steps.`);
  steps.forEach((p, i) => {
    if (!Number.isInteger(p) || p < 1 || p > 100) throw new ReleaseSafetyError("invalid_input", "Rollout steps are whole percentages from 1 to 100.");
    if (i > 0 && p <= steps[i - 1]) throw new ReleaseSafetyError("invalid_input", "Rollout steps must strictly increase.");
  });
  if (steps[steps.length - 1] !== 100) throw new ReleaseSafetyError("invalid_input", "The last rollout step must be 100: it is the cutover.");
  if (steps.length < 2) throw new ReleaseSafetyError("invalid_input", "A progressive rollout needs at least one canary step before 100.");
  const bakeSec = decl?.bakeSec ?? 60;
  if (!Number.isInteger(bakeSec) || bakeSec < 0 || bakeSec > MAX_BAKE_SEC) throw new ReleaseSafetyError("invalid_input", `The bake period is 0 to ${MAX_BAKE_SEC} seconds.`);
  return { strategy, steps, bakeSec, percent: 0 };
}

/** Canary steps below the cutover: traffic the candidate receives while the old digest still serves. */
export const canarySteps = (r: RolloutRecord): number[] => r.steps.filter((p) => p < 100);

export interface ProgressiveSupport {
  supported: boolean;
  reason?: string;
}

/** Why a provider's release adapter cannot split traffic. Used when an adapter does not say itself. */
export function progressiveUnsupportedReason(provider: string, kind?: string): string {
  const what = kind ? ` for a ${kind}` : "";
  switch (provider) {
    case "aws":
      return `ECS services are replaced through task definitions; weighted traffic needs CodeDeploy or weighted target groups, which Zenith does not provision. Use a rolling release${what}.`;
    case "azure":
      return `Container Apps can weight revisions, but the Azure release adapter does not implement it yet. Use a rolling release${what}.`;
    case "kubernetes":
      return `Kubernetes cannot split traffic by percentage without a service mesh or ingress controller Zenith does not manage. Use a rolling release${what}.`;
    case "oci":
      return `The OCI release adapter has no weighted traffic control. Use a rolling release${what}.`;
    case "gcp":
      return `Only Cloud Run services support percentage traffic; scheduled jobs have no traffic to split${what}.`;
    default:
      return `This provider's release adapter has no weighted traffic control. Use a rolling release${what}.`;
  }
}

/** Refuse a progressive request the provider cannot honour. Called before any deploy effect. */
export function assertRolloutSupported(rollout: RolloutRecord, support: ProgressiveSupport | undefined, provider: string, kind?: string): void {
  if (rollout.strategy === "rolling") return;
  if (!support?.supported) {
    throw new ReleaseSafetyError("rollout_unsupported", `Progressive rollout was requested but is not available: ${support?.reason ?? progressiveUnsupportedReason(provider, kind)}`);
  }
}
