/**
 * The shared runtime of the activity implementations: resolved dependencies
 * (defaults applied, required ones checked), the clock, and the two writers
 * every activity uses — events and evidence.
 *
 * Idempotency by construction: every event and evidence row an activity writes
 * gets a DETERMINISTIC id derived from (operation, kind/type, discriminator), so
 * a Temporal retry of the same activity appends the same row again instead of a
 * second one (the store adapters treat a repeated id as insert-or-return).
 *
 * Failure policy for those writers:
 *   - events are an audit projection: a failed append is logged and swallowed;
 *     it never changes what an activity returns or throws;
 *   - evidence from a READ-ONLY activity (plan, verify, observe) propagates
 *     (the activity is retryable and the ids make the retry idempotent);
 *   - evidence from a MUTATING activity (apply, build, deploy, migrate,
 *     capability) is retried, then logged and swallowed: turning a change that
 *     really happened into an error because the ledger hiccuped would make
 *     reality worse, and reconcile observes the environment regardless.
 */
import { randomUUID } from "node:crypto";
import type { EvidenceRecord, PlatformEventType } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { findDriver } from "@/lib/drivers/types";
import type { PlanCustodyInput } from "@/lib/tofu/engine";
import type { ExecContext } from "./context";
import { applyVerifiedPlan, planWorkspace } from "@/lib/tofu/engine";
import { sleepMs } from "./concurrency";
import { defaultCostPort } from "./cost";
import { DEFAULT_LIMITS, type CostPort, type DriverLookup, type ExecutionDeps, type ExecutionLimits, type TofuPort } from "./ports";
import { errorText } from "./text";

/** What an event or evidence row needs to know about the work it belongs to (an operation, or a reconcile pass). */
export interface WorkScope {
  /** operation id, or the reconcile pass id: what deterministic event/evidence ids are derived from */
  id: string;
  /** set only when `id` is a real operation row (a reconcile pass has none) */
  operationId?: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  correlationId: string;
}

export interface Runtime {
  readonly d: ExecutionDeps;
  readonly drivers: DriverLookup;
  readonly tofu: TofuPort;
  readonly cost: CostPort;
  readonly limits: ExecutionLimits;
  now(): Date;
  iso(): string;
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
  heartbeat(detail?: unknown): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** `worker:<workerId>:<operationId>` */
  holder(operationId: string): string;
  emit(scope: WorkScope, type: PlatformEventType, key: string | undefined, data: Record<string, unknown>, extra?: { resourceId?: string }): Promise<void>;
  evidence(
    scope: WorkScope,
    input: { kind: EvidenceRecord["kind"]; digest: string; summary: Record<string, unknown>; simulated: boolean; key?: string },
    opts: { critical: boolean }
  ): Promise<EvidenceRecord | undefined>;
}

const WORKER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_FINGERPRINT_KEY = 16;

export function createRuntime(deps: ExecutionDeps): Runtime {
  if (typeof deps.fingerprintKey !== "string" || deps.fingerprintKey.length < MIN_FINGERPRINT_KEY)
    throw new Error(
      `ExecutionDeps.fingerprintKey is required and must be at least ${MIN_FINGERPRINT_KEY} characters, derived from a server secret. The public-digest default would let anyone holding a plan confirm guesses of a sensitive value.`
    );
  if (!WORKER_ID.test(deps.workerId ?? "")) throw new Error("ExecutionDeps.workerId must be 1-64 characters of letters, digits, '.', '_' or '-'; it is part of every lease holder.");
  if (typeof deps.planDir !== "string" || deps.planDir.length === 0) throw new Error("ExecutionDeps.planDir is required: binary plan files are kept there and nowhere else.");

  const limits: ExecutionLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  if (limits.heartbeatIntervalMs > 25_000) throw new Error("limits.heartbeatIntervalMs must stay under 25 s: the workflow's heartbeat timeout is 60 s and a missed beat looks like a dead worker.");
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.ids ?? (() => randomUUID());
  const logSink = deps.log ?? (() => undefined);

  const rt: Runtime = {
    d: deps,
    drivers: deps.drivers ?? findDriver,
    tofu: deps.tofu ?? { planWorkspace, applyVerifiedPlan },
    cost: deps.cost ?? defaultCostPort(),
    limits,
    now: clock,
    iso: () => clock().toISOString(),
    log(level, message, data) {
      try {
        logSink(level, message, data);
      } catch {
        /* a broken log sink never changes behaviour */
      }
    },
    heartbeat(detail) {
      try {
        deps.heartbeat?.(detail);
      } catch (err) {
        rt.log("warn", "heartbeat failed", { error: errorText(err) });
      }
    },
    sleep: deps.sleep ?? sleepMs,
    holder: (operationId) => `worker:${deps.workerId}:${operationId}`,

    async emit(scope, type, key, data, extra) {
      const id = `evt_${digest({ w: scope.id, type, key: key ?? ids() }).slice(0, 32)}`;
      try {
        await deps.events.append({
          id,
          type,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          resourceId: extra?.resourceId,
          operationId: scope.operationId,
          correlationId: scope.correlationId,
          data,
        });
      } catch (err) {
        rt.log("warn", "event append failed", { type, error: errorText(err) });
      }
    },

    async evidence(scope, input, opts) {
      const id = `evd_${digest({ w: scope.id, kind: input.kind, key: input.key ?? input.digest }).slice(0, 32)}`;
      const write = (): Promise<EvidenceRecord> =>
        deps.evidence.append({
          id,
          workspaceId: scope.workspaceId,
          operationId: scope.operationId,
          kind: input.kind,
          digest: input.digest,
          summary: input.summary,
          simulated: input.simulated,
        });
      if (!opts.critical) return write();
      let last: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await write();
        } catch (err) {
          last = err;
          if (attempt < 3) await rt.sleep(50 * attempt);
        }
      }
      rt.log("error", "evidence append failed after the action had already happened; reconcile will observe the environment", { kind: input.kind, error: errorText(last) });
      return undefined;
    },
  };
  return rt;
}

/** `WorkScope` of a stored operation record. */
export function scopeOf(op: { id: string; workspaceId: string; projectId?: string; environmentId?: string; correlationId: string }): WorkScope {
  return { id: op.id, operationId: op.id, workspaceId: op.workspaceId, projectId: op.projectId, environmentId: op.environmentId, correlationId: op.correlationId };
}

/** Derived only from trusted loaded authorities, never workflow/LLM supplied manifest claims. */
export function planCustody(ec: ExecContext, graphDigest: string, connection: { id: string; workspaceId: string; config: unknown }): PlanCustodyInput {
  if (ec.op.projectId !== ec.product.project.id || ec.op.workspaceId !== ec.product.workspace.id || ec.op.environmentId !== ec.product.environment.id
    || connection.workspaceId !== ec.workspaceId) throw new Error("Plan custody scope is inconsistent.");
  return Object.freeze({ workspaceId: ec.workspaceId, projectId: ec.product.project.id, environmentId: ec.environmentId, operationId: ec.op.id,
    proposalDigest: ec.op.proposalDigest, inputDigest: ec.op.inputDigest, expiresAt: ec.op.expiresAt, graphDigest,
    sourceDigest: digest({ revision: ec.product.revision ?? null, deployedRevisionId: ec.product.environment.deployedRevisionId ?? null,
      connectionId: connection.id, connectionConfig: connection.config, provider: ec.product.environment.provider, region: ec.product.environment.region }) });
}
