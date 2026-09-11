/**
 * Deployment engine contract. Implementation lives in src/lib/engine/engine.ts
 * The engine is a durable state machine:
 *
 *   planning → awaiting_approval? → applying → verifying → succeeded
 *                                       ↘ failed → rolling_back → rolled_back
 *
 * Rules the implementation must keep:
 *  - All state lives in the store; the in-process ticker only advances it.
 *  - Steps are executed via the provider adapter, idempotently.
 *  - Every transition and log line is appended to the event log (JSONL),
 *    so SSE clients can replay from any cursor after refresh.
 *  - `resumeInFlight()` is called lazily on first server touch after a
 *    restart and must move orphaned running steps to their correct state.
 */
import type { Deployment } from "@/lib/domain/types";

export interface StartDeploymentInput {
  projectId: string;
  environmentId: string;
  revisionId: string;
  changeSummary: string;
  estCostDeltaUsd: number;
  actorName: string;
  /**
   * The acting user's real id. Recorded on the deployment so the Deploys
   * screen can name who deployed instead of everyone being "you".
   */
  actorId: string;
  actorType: "user" | "navigator";
  /** skip awaiting_approval (policy already satisfied by caller) */
  approved?: boolean;
}

export interface EngineApi {
  start(input: StartDeploymentInput): Promise<Deployment>;
  approve(deploymentId: string): Promise<Deployment>;
  cancel(deploymentId: string): Promise<Deployment>;
  /** roll an environment back to its previous revision via a new deployment */
  rollback(
    environmentId: string,
    toRevisionId?: string,
    actor?: { id: string; name: string }
  ): Promise<Deployment>;
  resumeInFlight(): void;
}
