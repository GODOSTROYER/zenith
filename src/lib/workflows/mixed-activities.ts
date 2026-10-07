/**
 * Activities for `mixedParentWorkflow` (PROD-MIX-02). Thin, typed adapters over
 * `src/lib/execution/mixed/service.ts`: every decision is made there from durable
 * platform state, so a retried or resumed activity repeats it safely.
 *
 * Failure mapping. A refusal of the plan (`MixedPlanError`, a digest or
 * transition conflict from the store) crosses the boundary as the workflow's clean
 * `StepFailed`, non-retryable, which ends the parent `failed` with nothing started.
 * A lost lease is `LeaseLost`. Anything unclassified stays a plain error, and
 * because the child step may have acted, the workflow ends it `uncertain`.
 */
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import type { Sql } from "@/lib/controlplane/types";
import { repos } from "@/lib/controlplane/db";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createConnectionsPort, createLeasesPort } from "@/lib/execution/platform";
import { createProductPort } from "@/lib/execution/product-port";
import { settleOutcome } from "@/lib/execution/mixed/settle";
import { advanceChild, beginParent, observeChild, settleParent, verifyParent, type ChildLauncher, type MixedDeps } from "@/lib/execution/mixed/service";
import { MixedPlanError } from "@/lib/execution/mixed/types";
import { createMixedWorld, type MixedWorld } from "@/lib/execution/mixed/world";
import { platformDriverLookup } from "@/lib/platform/driver-lookup";
import { findGraphProblems } from "@/lib/execution/graph";
import type { MixedActivities } from "./definitions/mixedParent";
import { stepFailed, toTemporalFailure } from "./activities/failures";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARTITION = /^[A-Za-z0-9_.:/-]{1,200}$/;
const POLL_MS = 5_000;
const LEASE_TTL_MS = 5 * 60 * 1000;

/** The real launcher: the broker claim a person's Start performs, then the durable, idempotent start intent. */
export function createChildLauncher(): ChildLauncher {
  return {
    async claim(workspaceId, operationId) {
      const [{ platformBroker }, { isBrokerError }] = await Promise.all([import("@/lib/capabilities/platform"), import("@/lib/capabilities/errors")]);
      try {
        await (await platformBroker()).beginExecution({ workspaceId, operationId, holder: `workflow:${operationId}`, audience: "worker", leaseMs: 5 * 60_000 });
        return "claimed";
      } catch (error) {
        if (isBrokerError(error) && error.code === "already_claimed") return "already_claimed";
        throw error;
      }
    },
    async start(input) {
      const { startWorkflowIntent } = await import("./start-intent");
      await startWorkflowIntent("deploy", input);
    },
  };
}

function mapFailure(error: unknown): unknown {
  if (error instanceof MixedPlanError) return stepFailed(error.message);
  if (error instanceof ControlStoreError && ["conflict", "invalid_state", "digest_mismatch", "not_found", "tenant_mismatch", "invalid_input"].includes(error.code)) return stepFailed(error.message);
  return toTemporalFailure(error);
}

function checked(input: unknown, partition: boolean): { workspaceId: string; operationId: string; parentPlanId: string; partitionId: string } {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object" || Object.getPrototypeOf(i) !== Object.prototype) throw ApplicationFailure.nonRetryable("Mixed activity input is invalid.", "MixedContractInvalid");
  const { workspaceId, operationId, parentPlanId, partitionId } = i as Record<string, string>;
  if (![workspaceId, operationId, parentPlanId].every((value) => typeof value === "string" && ID.test(value)) || (partition && !(typeof partitionId === "string" && PARTITION.test(partitionId)))) {
    throw ApplicationFailure.nonRetryable("Mixed activity input is invalid.", "MixedContractInvalid");
  }
  return { workspaceId, operationId, parentPlanId, partitionId: partition ? partitionId : "" };
}

export interface MixedActivityDeps {
  db: Sql;
  world?: MixedWorld;
  launcher?: ChildLauncher;
  /** test seams for pacing; production uses real time */
  pollMs?: number;
}

export function createMixedActivities(options: MixedActivityDeps): MixedActivities {
  const world = options.world ?? createMixedWorld({
    product: createProductPort(), connections: createConnectionsPort(options.db), platformConnection: (workspaceId, id) => repos.connections.get(options.db, workspaceId, id),
  });
  const launcher = options.launcher ?? createChildLauncher();
  const deps: MixedDeps = { sql: options.db, world, semantics: createPlatformSemanticsStore(options.db) };
  const leases = createLeasesPort(options.db);
  const pollMs = options.pollMs ?? POLL_MS;

  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await fn(...args); } catch (error) { throw mapFailure(error); }
  };

  return {
    verifyMixedParent: guarded(async (raw) => {
      const input = checked(raw, false);
      const ready = await verifyParent(deps, { workspaceId: input.workspaceId, operationId: input.operationId, planId: input.parentPlanId, requireRunning: true });
      // The cross-provider refusal is lifted only through this admission: every node must still pass its ordinary checks.
      const parent = await world.parentGraph(input.workspaceId, ready.stored.plan.parentEnvironmentId);
      const problems = findGraphProblems(parent.graph, ready.stored.plan.children[0].authority.provider, platformDriverLookup, ready.admission);
      if (problems.length) throw new MixedPlanError("plan_refused", `The mixed graph is not executable: ${problems[0].slice(0, 200)}`);
      await beginParent(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId });
      const order = ready.stored.plan.children.map((child) => ({ partitionId: child.partitionId, ordinal: child.ordinal }));
      return { order, childSetDigest: ready.stored.plan.childSetDigest };
    }),

    advanceMixedChild: guarded(async (raw) => {
      const input = checked(raw, true);
      const result = await advanceChild(deps, launcher, { workspaceId: input.workspaceId, operationId: input.operationId, planId: input.parentPlanId, partitionId: input.partitionId });
      if (result.state === "blocked") return { state: "blocked" as const, reason: result.reason };
      if (result.state === "waiting") return { state: "waiting" as const };
      return { state: result.state };
    }),

    awaitMixedChild: guarded(async (raw) => {
      const input = checked(raw, true);
      const { lease, windowMs } = raw as { lease: { scope: string; holder: string; fenceToken: number }; windowMs: number };
      const context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const until = Date.now() + Math.max(1_000, Math.min(windowMs, 5 * 60_000));
      try {
        for (;;) {
          context.heartbeat({ phase: "observing" });
          const renewed = await leases.renew(lease, LEASE_TTL_MS);
          if (!renewed) throw new (await import("@/lib/controlplane/types")).LeaseLostError(lease.scope, lease.fenceToken);
          const observed = await observeChild(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId, partitionId: input.partitionId });
          if (observed.state === "pending") throw new MixedPlanError("child_mismatch", "The child has no adopted operation.");
          if (observed.state !== "started" && observed.state !== "adopted") return { state: observed.state };
          if (observed.state === "adopted") {
            // Not claimed yet: return as soon as its own approval lets the parent advance it.
            const rows = await plans.listChildren(options.db, input.workspaceId, input.parentPlanId);
            const row = rows.find((candidate) => candidate.partitionId === input.partitionId);
            const facts = row?.childOperationId ? await plans.readOperationFacts(options.db, input.workspaceId, row.childOperationId) : null;
            if (!facts || !["proposed", "awaiting_approval"].includes(facts.status)) return { state: "adopted" };
          }
          if (Date.now() >= until) return { state: observed.state };
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(pollMs, Math.max(0, until - Date.now()))); t.unref(); context.cancellationSignal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
          context.cancellationSignal.throwIfAborted();
        }
      } catch (error) {
        if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined);
        throw error;
      }
    }),

    settleMixedParent: guarded(async (raw) => {
      const input = checked(raw, false);
      const { outcome, reason } = raw as { outcome: "succeeded" | "failed" | "uncertain" | "cancelled"; reason: string };
      const effective = await settleOutcome(options.db, { workspaceId: input.workspaceId, planId: input.parentPlanId, requested: outcome });
      await settleParent(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId, outcome: effective, reason: String(reason ?? "").slice(0, 400) });
      return { status: effective };
    }),
  };
}
