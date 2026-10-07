/**
 * Temporal activities for durable coding-agent runs (PROD-MACH-06).
 *
 * `agentStep` does one unit of work from the stored checkpoint (see
 * `executeRunStep`), heartbeating on every checkpoint and on a timer, and passes
 * Temporal's cancellation signal into the loop so a workflow cancel stops the
 * model call and persists the checkpoint. No model key on this worker is a
 * non-retryable `CodingAgentModelUnavailable`: the run is left failed and
 * resumable, never answered by a stand-in.
 */
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import type { Sql } from "@/lib/controlplane/types";
import type { CodingAgentActivities, CodingAgentRunInput, CodingAgentStepResult } from "@/lib/workflows/definitions/codingAgent";
import { anthropicKeyPresent, anthropicProvider } from "./anthropic";
import { createGithubSource } from "./github-source";
import { AgentServiceError, executeRunStep, failRunStep, type AgentWorkerDeps } from "./service";
import { platformRunStore } from "./store";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function checked(input: unknown): CodingAgentRunInput {
  const i = input as CodingAgentRunInput;
  if (!i || Object.getPrototypeOf(i) !== Object.prototype || i.contract !== "zenith.coding-agent-run.v1" || typeof i.runId !== "string" || !ID.test(i.runId) || typeof i.workspaceId !== "string" || !ID.test(i.workspaceId))
    throw ApplicationFailure.nonRetryable("Coding agent activity input is invalid.", "CodingAgentContractInvalid");
  return i;
}

export function createCodingAgentActivities(deps: AgentWorkerDeps): CodingAgentActivities {
  return {
    async agentStep(raw): Promise<CodingAgentStepResult> {
      const input = checked(raw);
      const context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const beat = (): void => context.heartbeat({ phase: "stepping" });
      const timer = setInterval(beat, 5_000);
      timer.unref();
      try {
        beat();
        return await executeRunStep(deps, { workspaceId: input.workspaceId, runId: input.runId, signal: context.cancellationSignal, beat });
      } catch (error) {
        if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined);
        if (error instanceof ApplicationFailure) throw error;
        if (error instanceof AgentServiceError) throw ApplicationFailure.nonRetryable(error.message, "CodingAgentContractInvalid");
        throw error;
      } finally {
        clearInterval(timer);
      }
    },

    async agentFinalize(raw): Promise<CodingAgentStepResult> {
      const input = checked(raw);
      const outcome = (raw as { outcome?: unknown }).outcome;
      const detail = String((raw as { detail?: unknown }).detail ?? "").slice(0, 60);
      if (outcome === "cancelled") {
        try {
          const row = await deps.store.cancel({ workspaceId: input.workspaceId, id: input.runId });
          return { status: row.status };
        } catch (error) {
          if (error instanceof ControlStoreError && (error.code === "invalid_state" || error.code === "not_found")) {
            const row = await deps.store.get(input.workspaceId, input.runId);
            return { status: row?.status ?? "cancelled" };
          }
          throw error;
        }
      }
      return failRunStep(deps, input.workspaceId, input.runId, detail || "step_failed");
    },
  };
}

/** Compose the production activities for the execution worker over its already-open platform store. */
export function createProductionCodingAgentActivities(db: Sql): CodingAgentActivities {
  const source = createGithubSource({ db: async () => db });
  return createCodingAgentActivities({
    store: platformRunStore(db),
    provider: () => {
      if (!anthropicKeyPresent()) throw ApplicationFailure.nonRetryable("No model key is configured on this worker.", "CodingAgentModelUnavailable");
      return anthropicProvider();
    },
    readSource: source.read,
    broker: platformBroker,
  });
}
