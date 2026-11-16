/**
 * The release pipeline service: the only code that moves a `ReleaseRun`.
 *
 * Properties it holds:
 *  - the image digest is bound when a run is created and never changes (`digest_immutable`);
 *  - a run cannot be `deployed` unless provenance verified at the required level;
 *  - a migration that is not `expand` cannot start without an approval, from a person other than
 *    the requester, bound to the exact (environment, service, image digest, command digest,
 *    class), used once;
 *  - a progressive rollout the provider cannot honour is refused before any effect;
 *  - a CODE rollback never runs, reverts or re-applies a data migration, and is refused when a
 *    contract migration has run since the target digest served;
 *  - every state change is a compare-and-set, and an exact retry of a change that already
 *    happened returns the run rather than failing.
 */
import { randomUUID } from "node:crypto";
import type { Principal } from "@/lib/controlplane/types";
import { assessMigration, blocksCodeRollback, migrationBindingDigest, requiresHumanApproval, type MigrationDeclaration } from "./classify";
import { meetsLevel, requireProvenance, verifyProvenance, type ProvenanceSubject, type ProvenanceVerifier } from "./provenance";
import { assertRolloutSupported, normalizeRollout, type ProgressiveSupport, type RolloutDeclaration } from "./rollout";
import { assertTransition, isTerminal } from "./state";
import type { NewRun, ReleaseStore } from "./store";
import {
  HEX64,
  IMAGE_DIGEST,
  ReleaseSafetyError,
  scrub,
  type MigrationApproval,
  type MigrationClass,
  type ProvenanceLevel,
  type ReadbackRecord,
  type ReleaseEvent,
  type ReleaseKind,
  type ReleaseRun,
  type ReleaseState,
} from "./types";

export interface ReleaseSafetyOptions {
  store: ReleaseStore;
  verifiers: readonly ProvenanceVerifier[] | (() => readonly ProvenanceVerifier[]);
  /** The weakest provenance a release may carry. Default `build_record`. */
  minProvenance?: ProvenanceLevel;
  /** A stricter floor per image origin (e.g. built images must be attested). Never weaker than `minProvenance`. */
  minProvenanceFor?: (origin: "built" | "pinned") => ProvenanceLevel;
  clock?: () => Date;
  ids?: () => string;
  /** How long an approval stays usable. Default 24 h, never more than 7 days. */
  approvalTtlSec?: number;
}

export interface BeginInput {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  operationId: string;
  revisionId?: string;
  serviceAddress: string;
  provider: string;
  nodeKind?: string;
  kind: ReleaseKind;
  imageUri: string;
  imageDigest: string;
  sourceDigest?: string;
  origin: "built" | "pinned";
  /** accountable identity of the requester (`onBehalfOf` for an agent, else the principal id) */
  requestedBy: string;
  /** present only for the service that owns the manifest's `release.migrate` */
  migration?: { commandDigest: string; declared?: MigrationClass; sql?: string };
  rollout?: RolloutDeclaration;
  /** what the provider adapter says about weighted traffic for this node */
  progressive?: ProgressiveSupport;
  /** the signed-provenance admission for a built image (see `ProvenanceSubject.builtAdmission`) */
  builtAdmission?: ProvenanceSubject["builtAdmission"];
  actor?: string;
}

export interface RollbackSafety {
  allowed: boolean;
  /** the recorded run whose digest this would restore */
  restoresRunId?: string;
  blockingRunId?: string;
  reason?: string;
  warnings: string[];
}

export const MAX_APPROVAL_TTL_SEC = 7 * 86400;
const SERVED: readonly ReleaseState[] = ["cut_over", "readback_verified", "cut_over_unverified", "rolled_back"];
const RELEASED_STATES: readonly ReleaseState[] = ["cut_over", "readback_verified", "cut_over_unverified"];

export const accountableId = (p: Principal): string => p.onBehalfOf ?? p.id;

export class ReleaseSafetyService {
  readonly store: ReleaseStore;
  private readonly clock: () => Date;
  private readonly ids: () => string;
  private readonly min: ProvenanceLevel;

  constructor(private readonly opts: ReleaseSafetyOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? (() => new Date());
    this.ids = opts.ids ?? (() => randomUUID().replace(/-/g, "").slice(0, 24));
    this.min = opts.minProvenance ?? "build_record";
  }

  get minimumProvenance(): ProvenanceLevel {
    return this.min;
  }

  private minFor(origin: "built" | "pinned"): ProvenanceLevel {
    const stricter = this.opts.minProvenanceFor?.(origin);
    return stricter && meetsLevel(stricter, this.min) ? stricter : this.min;
  }

  private verifiers(): readonly ProvenanceVerifier[] {
    return typeof this.opts.verifiers === "function" ? this.opts.verifiers() : this.opts.verifiers;
  }

  /* ------------------------------ reads -------------------------------- */

  async get(workspaceId: string, id: string): Promise<ReleaseRun> {
    const run = await this.store.getRun(workspaceId, id);
    if (!run) throw new ReleaseSafetyError("not_found", "Release not found.");
    return run;
  }

  list(workspaceId: string, filter: { environmentId?: string; serviceAddress?: string; operationId?: string; revisionId?: string; limit?: number } = {}): Promise<ReleaseRun[]> {
    return this.store.listRuns(workspaceId, filter);
  }

  events(workspaceId: string, runId: string): Promise<ReleaseEvent[]> {
    return this.store.listEvents(workspaceId, runId);
  }

  /* ------------------------ the gate before any effect ------------------- */

  /**
   * Create (or resume) the run for this digest and clear every gate that must hold BEFORE the
   * service is touched: provenance, rollout support, rollback safety, migration approval. Returns
   * a run in state `verified`, or throws a `ReleaseSafetyError` after recording why it stopped.
   */
  async begin(input: BeginInput): Promise<ReleaseRun> {
    this.validateBegin(input);
    const actor = input.actor ?? "system:release";
    const previous = (await this.store.listRuns(input.workspaceId, { environmentId: input.environmentId, serviceAddress: input.serviceAddress, states: RELEASED_STATES, limit: 1 }))[0];
    const rollout = input.kind === "rollback" ? normalizeRollout(undefined) : normalizeRollout(input.rollout);
    const assessment = input.kind === "deploy" && input.migration ? assessMigration({ declared: input.migration.declared, sql: input.migration.sql } satisfies MigrationDeclaration) : undefined;
    const bindingDigest = assessment && input.migration
      ? migrationBindingDigest({ workspaceId: input.workspaceId, environmentId: input.environmentId, serviceAddress: input.serviceAddress, imageDigest: input.imageDigest, commandDigest: input.migration.commandDigest, sqlDigest: assessment.sqlDigest, class: assessment.class })
      : undefined;

    const fresh: NewRun = {
      id: `rel_${this.ids()}`,
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      environmentId: input.environmentId,
      operationId: input.operationId,
      ...(input.revisionId ? { revisionId: input.revisionId } : {}),
      requestedBy: scrub(input.requestedBy, 200),
      serviceAddress: input.serviceAddress,
      kind: input.kind,
      state: "planned",
      imageUri: input.imageUri,
      imageDigest: input.imageDigest,
      ...(input.sourceDigest ? { sourceDigest: input.sourceDigest } : {}),
      ...(previous && previous.imageDigest !== input.imageDigest ? { previousDigest: previous.imageDigest } : previous ? { previousDigest: previous.previousDigest } : {}),
      provenance: { level: "none" },
      migration: assessment && input.migration
        ? { class: assessment.class, status: requiresHumanApproval(assessment.class) ? "pending_approval" : "cleared", commandDigest: input.migration.commandDigest, ...(assessment.sqlDigest ? { sqlDigest: assessment.sqlDigest } : {}), findings: assessment.findings, bindingDigest }
        : { class: "none", status: "none", findings: input.kind === "rollback" ? ["A code rollback never runs or reverts a data migration."] : [] },
      rollout,
    };
    const { run: inserted } = await this.store.insertRun(fresh);
    if (inserted.imageDigest !== input.imageDigest) throw new ReleaseSafetyError("digest_immutable", "This operation already released a different image digest for this service; a new digest needs a new operation.");
    return this.clear(inserted, input, actor);
  }

  private validateBegin(i: BeginInput): void {
    if (!IMAGE_DIGEST.test(i.imageDigest)) throw new ReleaseSafetyError("invalid_input", "The image digest must be a sha256 digest.");
    if (typeof i.imageUri !== "string" || i.imageUri.length > 500 || /\s/.test(i.imageUri) || !i.imageUri.endsWith(`@${i.imageDigest}`)) {
      throw new ReleaseSafetyError("invalid_input", "The image reference must be pinned to the same digest the release is bound to.");
    }
    if (i.migration && !HEX64.test(i.migration.commandDigest)) throw new ReleaseSafetyError("invalid_input", "The migration command digest is malformed.");
    if (!i.requestedBy) throw new ReleaseSafetyError("invalid_input", "A release needs an accountable requester.");
  }

  private async clear(start: ReleaseRun, input: BeginInput, actor: string): Promise<ReleaseRun> {
    let run = start;
    if (isTerminal(run.state)) throw new ReleaseSafetyError(run.state === "refused" ? "provenance_unverified" : "conflict", `This release is already ${run.state.replace("_", " ")}${run.reason ? `: ${run.reason}` : ""}.`);
    if (run.state === "planned") run = await this.advance(run, "built", {}, "image digest bound", actor);

    if (run.state === "built") {
      const verdict = await this.verdictFor(run, input);
      try {
        requireProvenance(verdict, this.minFor(input.origin), `Image ${run.imageDigest.slice(0, 19)} for ${scrub(run.serviceAddress, 80)}`);
      } catch (e) {
        await this.advance(run, "refused", { reason: scrub((e as Error).message) }, "provenance not verified", actor);
        throw e;
      }
      run = await this.advance(run, "verified", { provenance: { level: verdict.level, evidenceRef: verdict.evidenceRef, verifiedAt: verdict.verifiedAt ?? this.clock().toISOString() } }, `provenance verified (${verdict.level})`, actor);
    }

    if (run.state === "verified" || run.state === "blocked_approval") {
      if (run.kind === "deploy") {
        try {
          assertRolloutSupported(run.rollout, input.progressive, input.provider, input.nodeKind);
        } catch (e) {
          await this.advance(run, "refused", { reason: scrub((e as Error).message) }, "rollout strategy unsupported", actor);
          throw e;
        }
      } else {
        const safety = await this.rollbackSafety({ workspaceId: run.workspaceId, environmentId: run.environmentId, serviceAddress: run.serviceAddress, targetDigest: run.imageDigest });
        if (!safety.allowed) {
          await this.advance(run, "refused", { reason: scrub(safety.reason ?? "unsafe") }, "code rollback refused", actor);
          throw new ReleaseSafetyError("rollback_unsafe", safety.reason ?? "This code rollback is unsafe.");
        }
        if (safety.restoresRunId && run.restoresRunId !== safety.restoresRunId) run = await this.advance(run, run.state, { restoresRunId: safety.restoresRunId }, "rollback target recorded", actor);
      }
      run = await this.gateMigration(run, actor);
    }
    return run;
  }

  private async verdictFor(run: ReleaseRun, input: BeginInput) {
    const subject: ProvenanceSubject = {
      workspaceId: run.workspaceId,
      environmentId: run.environmentId,
      operationId: run.operationId,
      serviceAddress: run.serviceAddress,
      imageUri: run.imageUri,
      imageDigest: run.imageDigest,
      ...(run.sourceDigest ? { sourceDigest: run.sourceDigest } : {}),
      origin: input.origin,
      ...(input.builtAdmission ? { builtAdmission: input.builtAdmission } : {}),
    };
    // A rollback restores a digest that already served: its recorded verdict counts when it still meets the bar.
    if (run.kind === "rollback") {
      const earlier = (await this.store.listRuns(run.workspaceId, { environmentId: run.environmentId, serviceAddress: run.serviceAddress, states: SERVED, limit: 200 })).find((r) => r.imageDigest === run.imageDigest && r.provenance.level !== "none");
      if (earlier) return { verified: true, level: earlier.provenance.level, evidenceRef: earlier.provenance.evidenceRef, verifiedAt: earlier.provenance.verifiedAt } as const;
    }
    return verifyProvenance(subject, this.verifiers());
  }

  private async gateMigration(run: ReleaseRun, actor: string): Promise<ReleaseRun> {
    const m = run.migration;
    if (!requiresHumanApproval(m.class)) {
      return run.state === "blocked_approval" ? this.advance(run, "verified", {}, "no approval needed", actor) : run;
    }
    const binding = m.bindingDigest;
    if (!binding) throw new ReleaseSafetyError("invalid_input", "A migration that needs approval has no binding.");
    const approval = await this.store.findUsableApproval(run.workspaceId, binding, this.clock());
    if (approval && approval.approvedBy !== run.requestedBy) {
      const patched = { migration: { ...m, status: m.status === "started" ? m.status : ("approved" as const), approvalId: approval.id } };
      const cleared = await this.advance(run, "verified", patched, `migration approved (${approval.id})`, actor);
      await this.supersedeBlocked(cleared, binding, actor);
      return cleared;
    }
    if (run.state !== "blocked_approval") run = await this.advance(run, "blocked_approval", { migration: { ...m, status: "pending_approval" }, reason: "Waiting for a person to approve the migration." }, "migration awaits approval", actor);
    await this.supersedeBlocked(run, binding, actor);
    throw new ReleaseSafetyError(
      "migration_approval_required",
      `This release carries a ${m.class} migration${m.findings.length ? ` (${m.findings.slice(0, 3).join("; ")})` : ""}. A person other than the requester must approve release ${run.id} (binding ${binding.slice(0, 16)}) first. Nothing was deployed; once approved, deploy again.`
    );
  }

  /** Earlier blocked runs of the same binding are replaced by this operation's run. */
  private async supersedeBlocked(run: ReleaseRun, binding: string, actor: string): Promise<void> {
    for (const old of await this.store.listRuns(run.workspaceId, { environmentId: run.environmentId, serviceAddress: run.serviceAddress, states: ["blocked_approval"], limit: 20 })) {
      if (old.id !== run.id && old.migration.bindingDigest === binding) await this.advance(old, "refused", { reason: `Superseded by release ${run.id}.` }, "superseded", actor).catch(() => undefined);
    }
  }

  /** The human approval of one exact migration. Browser-only at the route; re-checked here. */
  async approveMigration(input: { workspaceId: string; runId: string; bindingDigest: string; approver: Principal; ttlSec?: number }): Promise<MigrationApproval> {
    if (input.approver.kind !== "user") throw new ReleaseSafetyError("forbidden", "Only a signed-in person can approve a migration.");
    const run = await this.get(input.workspaceId, input.runId);
    const m = run.migration;
    if (!m.bindingDigest || !requiresHumanApproval(m.class)) throw new ReleaseSafetyError("approval_invalid", "This release has no migration that needs approval.");
    if (input.bindingDigest !== m.bindingDigest) throw new ReleaseSafetyError("approval_invalid", "The release changed after you reviewed it; reload and review it again.");
    if (run.state !== "blocked_approval") throw new ReleaseSafetyError("approval_invalid", `This release is ${run.state.replace("_", " ")}, so it cannot be approved now.`);
    const approver = accountableId(input.approver);
    if (approver === run.requestedBy) throw new ReleaseSafetyError("forbidden", "The person who requested a release cannot approve its migration.");
    const ttl = Math.min(input.ttlSec ?? this.opts.approvalTtlSec ?? 86400, MAX_APPROVAL_TTL_SEC);
    if (!Number.isInteger(ttl) || ttl < 60) throw new ReleaseSafetyError("invalid_input", "An approval lasts at least a minute.");
    const now = this.clock();
    const { approval } = await this.store.insertApproval({
      id: `rma_${this.ids()}`,
      workspaceId: run.workspaceId,
      runId: run.id,
      bindingDigest: m.bindingDigest,
      class: m.class,
      approvedBy: approver,
      requestedBy: run.requestedBy,
      approvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    });
    await this.advance(run, "blocked_approval", { migration: { ...m, status: "approved", approvalId: approval.id }, reason: "Approved; deploy again to proceed." }, `migration approved by ${scrub(approver, 80)}`, approver);
    return approval;
  }

  /* ---------------------------- rollback safety ---------------------------- */

  async rollbackSafety(input: { workspaceId: string; environmentId: string; serviceAddress: string; targetDigest: string }): Promise<RollbackSafety> {
    const history = await this.store.listRuns(input.workspaceId, { environmentId: input.environmentId, serviceAddress: input.serviceAddress, limit: 200 });
    const dangerous = (r: ReleaseRun) => r.kind === "deploy" && blocksCodeRollback(r.migration.class) && (r.migration.status === "ran" || r.migration.status === "started");
    const touchedData = (r: ReleaseRun) => r.kind === "deploy" && r.migration.class === "data" && (r.migration.status === "ran" || r.migration.status === "started");
    const idx = history.findIndex((r) => r.imageDigest === input.targetDigest && SERVED.includes(r.state));
    const newer = idx >= 0 ? history.slice(0, idx) : history;
    const blocking = newer.find(dangerous);
    const warnings = newer.some(touchedData) ? ["A data migration ran since this digest served. Code rollback does not revert data; restoring data is a separate, reviewed action."] : [];
    if (blocking) {
      return {
        allowed: false,
        blockingRunId: blocking.id,
        warnings,
        reason: `Release ${blocking.id} ran a ${blocking.migration.class} migration after this digest served, so the older code may not understand the current schema. A code rollback will not undo it; plan a reviewed data restore or roll forward.`,
        ...(idx >= 0 ? { restoresRunId: history[idx].id } : {}),
      };
    }
    return { allowed: true, warnings, ...(idx >= 0 ? { restoresRunId: history[idx].id } : { reason: "No release record exists for this digest; no blocking migration is recorded for the service." }) };
  }

  /* ------------------------------ transitions ------------------------------ */

  async markDeployed(run: ReleaseRun, input: { percent: number; detail: string }, actor = "system:release"): Promise<ReleaseRun> {
    if (run.state === "deployed" && run.rollout.percent === input.percent) return run;
    if (run.state !== "verified" && run.state !== "deployed") throw new ReleaseSafetyError("invalid_transition", `A release that is ${run.state.replace("_", " ")} cannot be deployed.`);
    return this.advance(run, "deployed", { rollout: { ...run.rollout, percent: input.percent } }, scrub(input.detail), actor);
  }

  /**
   * Called just before the one-off migration task starts. A migration that needs approval consumes
   * its single-use approval here; a retry of the same dispatch (status `started`) reuses the
   * provider's idempotency key instead of needing a second approval.
   */
  async beginMigration(run: ReleaseRun, actor = "system:release"): Promise<ReleaseRun> {
    if (run.kind === "rollback") throw new ReleaseSafetyError("rollback_unsafe", "A code rollback never runs a migration.");
    if (run.state !== "deployed") throw new ReleaseSafetyError("invalid_transition", `A migration cannot start while the release is ${run.state.replace("_", " ")}.`);
    const m = run.migration;
    if (m.status === "started") return run;
    if (requiresHumanApproval(m.class)) {
      if (m.status !== "approved" || !m.approvalId || !m.bindingDigest) throw new ReleaseSafetyError("migration_approval_required", `Release ${run.id} carries a ${m.class} migration without a current approval.`);
      const usable = await this.store.findUsableApproval(run.workspaceId, m.bindingDigest, this.clock());
      if (!usable || usable.approvedBy === run.requestedBy) throw new ReleaseSafetyError("migration_approval_required", "The migration approval is missing, expired, already used, or not independent of the requester.");
      if (!(await this.store.consumeApproval(run.workspaceId, usable.id, this.clock()))) throw new ReleaseSafetyError("migration_approval_required", "The migration approval was already used.");
    }
    return this.advance(run, "deployed", { migration: { ...m, status: "started" } }, "migration dispatched", actor);
  }

  async markMigrated(run: ReleaseRun, result: { ran: boolean; exitCode?: number; detail?: string }, actor = "system:release"): Promise<ReleaseRun> {
    if (run.state === "migrated" || run.state === "ready" || run.state === "cut_over") return run;
    const m = run.migration;
    if (result.ran && result.exitCode !== undefined && result.exitCode !== 0) {
      return this.advance(run, "failed", { migration: { ...m, status: "failed", exitCode: result.exitCode }, reason: "The migration task failed; the database may be partially migrated. Nothing was reverted." }, "migration failed", actor);
    }
    return this.advance(run, "migrated", { migration: { ...m, status: result.ran ? "ran" : m.status, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) } }, scrub(result.detail ?? (result.ran ? "migration ran" : "no migration")), actor);
  }

  markReady(run: ReleaseRun, detail: string, actor = "system:release"): Promise<ReleaseRun> {
    return run.state === "ready" || run.state === "cut_over" ? Promise.resolve(run) : this.advance(run, "ready", {}, scrub(detail), actor);
  }

  markCutOver(run: ReleaseRun, detail: string, actor = "system:release"): Promise<ReleaseRun> {
    if (run.state === "cut_over") return Promise.resolve(run);
    return this.advance(run, "cut_over", { rollout: { ...run.rollout, percent: 100 } }, scrub(detail), actor);
  }

  /** Record what the provider reports it is serving. Only a matching digest earns `readback_verified`. */
  async recordReadback(run: ReleaseRun, input: { observedDigest?: string; supported: boolean; readable?: boolean; detail?: string }, actor = "system:release"): Promise<ReleaseRun> {
    const at = this.clock().toISOString();
    let readback: ReadbackRecord;
    if (!input.supported) readback = { status: "unsupported", detail: scrub(input.detail ?? "This provider adapter cannot read the serving digest."), at };
    else if (input.readable === false || !input.observedDigest) readback = { status: "unreadable", detail: scrub(input.detail ?? "The serving digest could not be read."), at };
    else readback = { status: input.observedDigest === run.imageDigest ? "verified" : "mismatch", observedDigest: input.observedDigest, ...(input.detail ? { detail: scrub(input.detail) } : {}), at };
    if (run.state === "readback_verified" || run.state === "cut_over_unverified") return run;
    if (readback.status === "verified") return this.advance(run, "readback_verified", { readback }, "readback matches the bound digest", actor);
    if (readback.status === "mismatch") return this.advance(run, "failed", { readback, reason: "After cutover the service reports a different digest than the release bound." }, "readback mismatch", actor);
    return this.advance(run, "cut_over_unverified", { readback }, `cutover not verified by readback (${readback.status})`, actor);
  }

  fail(run: ReleaseRun, reason: string, actor = "system:release"): Promise<ReleaseRun> {
    return isTerminal(run.state) ? Promise.resolve(run) : this.advance(run, "failed", { reason: scrub(reason) }, "failed", actor);
  }

  uncertain(run: ReleaseRun, reason: string, actor = "system:release"): Promise<ReleaseRun> {
    return isTerminal(run.state) ? Promise.resolve(run) : this.advance(run, "uncertain", { reason: scrub(reason) }, "outcome unknown", actor);
  }

  /** The run for the digest a rollback replaced: code only, data untouched. */
  async markRolledBack(workspaceId: string, runId: string, reason: string, actor = "system:release"): Promise<ReleaseRun | null> {
    const run = await this.store.getRun(workspaceId, runId);
    if (!run || run.state === "rolled_back") return run;
    return this.advance(run, "rolled_back", { reason: scrub(reason) }, "code rolled back; data was not changed", actor);
  }

  /**
   * The release that last served this saved revision of this service: what a code rollback to that
   * revision restores, so it restores the SAME digest instead of rebuilding.
   */
  async lastServedForRevision(workspaceId: string, environmentId: string, serviceAddress: string, revisionId: string): Promise<ReleaseRun | null> {
    const runs = await this.store.listRuns(workspaceId, { environmentId, serviceAddress, revisionId, states: SERVED, limit: 20 });
    return runs.find((r) => r.kind === "deploy") ?? runs[0] ?? null;
  }

  /** The currently released run of a service, or null. */
  async currentRelease(workspaceId: string, environmentId: string, serviceAddress: string): Promise<ReleaseRun | null> {
    return (await this.store.listRuns(workspaceId, { environmentId, serviceAddress, states: RELEASED_STATES, limit: 1 }))[0] ?? null;
  }

  async run(workspaceId: string, operationId: string, serviceAddress: string, kind: ReleaseKind): Promise<ReleaseRun | null> {
    return this.store.findRun(workspaceId, operationId, serviceAddress, kind);
  }

  private async advance(run: ReleaseRun, to: ReleaseState, patch: NonNullable<Parameters<ReleaseStore["transition"]>[0]["patch"]>, detail: string, actor: string): Promise<ReleaseRun> {
    assertTransition(run.state, to);
    const moved = await this.store.transition({ workspaceId: run.workspaceId, id: run.id, expectVersion: run.version, to, patch, actor, detail });
    if (moved) return moved;
    // Another writer won. If it already did exactly this, the retry is a success.
    const current = await this.store.getRun(run.workspaceId, run.id);
    if (current && current.state === to && current.version > run.version) return current;
    throw new ReleaseSafetyError("conflict", "The release changed underneath this step; retry it.");
  }
}
