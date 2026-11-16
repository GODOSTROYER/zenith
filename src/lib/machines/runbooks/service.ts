/**
 * Runbook service (PROD-MACH-03): publish signed versions, request and approve
 * runs, create/approve/pause schedules, cancel, and the durable schedule tick.
 *
 * Authority stays in deterministic code: `authorize` is the caller's role check,
 * signing uses the control-plane signer, verification uses pinned keys and runs
 * again at request time and at every execution, and approval is bound to the
 * exact immutable effect (`bindingDigestOf`). Nothing here executes a machine
 * operation; `runner.ts` does, one broker-granted step at a time.
 */
import { randomUUID } from "node:crypto";
import type { MachineTransport } from "../types";
import type { Principal } from "@/lib/controlplane/types";

const plainPrincipal = (p: Principal): Principal => ({ kind: p.kind, id: p.id, name: p.name, ...(p.onBehalfOf ? { onBehalfOf: p.onBehalfOf } : {}), ...(p.integrationId ? { integrationId: p.integrationId } : {}) });
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import {
  MAX_PARALLEL_TARGETS,
  MAX_RUN_DURATION_SEC,
  RUNBOOK_ID_RE,
  RunbookError,
  classifyRunbook,
  definitionDigest,
  parseRunbookDefinition,
  parseRunbookTargets,
  type RunbookClassification,
  type RunbookDefinition,
} from "./definition";
import { ESCAPE_HATCH_APPROVAL_MAX_SEC, approvalTtlCapSec, bindingDigestOf, evaluateRunbookGate } from "./policy";
import type { RunbookApprovalRecord, RunbookRunRecord, RunbookScheduleRecord, RunbookStore, RunbookVersionRecord } from "./ports";
import { WindowSchema, adHocDeadline, decideSlot, nextSlotInWindow, parseScheduleSpec, type RunWindow } from "./schedule";
import { signRunbookVersion, verifyRunbookVersion } from "./signing";

export type RunbookAction = "read" | "publish" | "request" | "approve" | "cancel" | "schedule";

export interface RunbookServiceDeps {
  store: RunbookStore;
  signer: JwtSigner;
  /** pinned control-plane verification keys (current plus unexpired rotation keys) */
  verificationKeys: () => Promise<readonly PublicJwk[]>;
  /** role check owned by the caller; a `false` is `forbidden`, never an unscoped fallthrough */
  authorize: (principal: Principal, workspaceId: string, action: RunbookAction) => Promise<boolean>;
  /** transports this deployment can actually dispatch to; other targets are refused up front */
  allowedTransports?: readonly MachineTransport[];
  now?: () => Date;
}

export interface RunRequestInput {
  workspaceId: string;
  runbookId: string;
  /** default: the latest published version */
  version?: number;
  targets: unknown;
  windows?: unknown;
  notAfter?: string;
  maxRunDurationSec?: number;
  maxParallelTargets?: number;
  principal: Principal;
}

const actorOf = (p: Principal): string => `${p.kind}:${p.id}`;
/** The human accountable for a principal: an agent acts for its owner, so an owner cannot approve their own agent's request. */
const accountableOf = (p: Principal): string => (p.onBehalfOf ? `user:${p.onBehalfOf}` : actorOf(p));
const MAX_TICK_SLOTS_PER_SCHEDULE = 50;

export function createRunbookService(deps: RunbookServiceDeps) {
  const { store } = deps;
  const now = (): Date => (deps.now ? deps.now() : new Date());

  async function allow(p: Principal, ws: string, action: RunbookAction): Promise<void> {
    if (!(await deps.authorize(p, ws, action))) throw new RunbookError("forbidden", "You are not allowed to do that in this workspace.");
  }

  async function loadVerified(ws: string, runbookId: string, version?: number): Promise<{ rec: RunbookVersionRecord; classification: RunbookClassification }> {
    const rec = version === undefined ? await store.latestVersion(ws, runbookId) : await store.getVersion(ws, runbookId, version);
    if (!rec) throw new RunbookError("not_found", "That runbook version does not exist.");
    await verifyRunbookVersion({ workspaceId: ws, runbookId, version: rec.version, definition: rec.definition, signature: rec.signature }, await deps.verificationKeys());
    return { rec, classification: classifyRunbook(rec.definition) };
  }

  function checkedTargets(raw: unknown): ReturnType<typeof parseRunbookTargets> {
    const targets = parseRunbookTargets(raw);
    const allowed = deps.allowedTransports;
    if (allowed && targets.some((x) => !allowed.includes(x.transport))) throw new RunbookError("invalid_binding", `Runbooks can target only these transports here: ${allowed.join(", ")}.`);
    return targets;
  }

  function bounds(input: { maxRunDurationSec?: number; maxParallelTargets?: number }): { maxRunDurationSec: number; maxParallelTargets: number } {
    const maxRunDurationSec = input.maxRunDurationSec ?? 1800;
    const maxParallelTargets = input.maxParallelTargets ?? 1;
    if (!Number.isInteger(maxRunDurationSec) || maxRunDurationSec < 10 || maxRunDurationSec > MAX_RUN_DURATION_SEC) throw new RunbookError("invalid_binding", "maxRunDurationSec is out of range.");
    if (!Number.isInteger(maxParallelTargets) || maxParallelTargets < 1 || maxParallelTargets > MAX_PARALLEL_TARGETS) throw new RunbookError("invalid_binding", "maxParallelTargets is out of range.");
    return { maxRunDurationSec, maxParallelTargets };
  }

  function parseWindows(raw: unknown): RunWindow[] | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 14) throw new RunbookError("invalid_binding", "windows must be 1 to 14 windows.");
    return raw.map((w) => {
      const p = WindowSchema.safeParse(w);
      if (!p.success) throw new RunbookError("invalid_binding", "A window is invalid.");
      return p.data;
    });
  }

  return {
    /** Validate, assign the next version number, sign and store an immutable runbook version. */
    async publish(input: { workspaceId: string; runbookId: string; definition: unknown; principal: Principal }): Promise<RunbookVersionRecord> {
      await allow(input.principal, input.workspaceId, "publish");
      if (!RUNBOOK_ID_RE.test(input.runbookId)) throw new RunbookError("invalid_definition", "The runbook id must match [a-z0-9][a-z0-9_-]{0,62}.");
      const definition: RunbookDefinition = parseRunbookDefinition(input.definition);
      const classification = classifyRunbook(definition);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latest = await store.latestVersion(input.workspaceId, input.runbookId);
        const version = (latest?.version ?? 0) + 1;
        const at = now();
        const signed = await signRunbookVersion(deps.signer, { workspaceId: input.workspaceId, runbookId: input.runbookId, version, definition, now: at });
        const rec: RunbookVersionRecord = {
          workspaceId: input.workspaceId,
          runbookId: input.runbookId,
          version,
          name: definition.name,
          definition,
          definitionDigest: signed.digest,
          signature: signed.signature,
          signingKid: signed.kid,
          publishedBy: actorOf(input.principal),
          createdAt: at.toISOString(),
        };
        try {
          await store.insertVersion(rec);
        } catch (e) {
          if (e instanceof RunbookError && e.code === "conflict") continue; // lost the race for this number
          throw e;
        }
        await store.appendAudit(input.workspaceId, `runbook:${input.runbookId}`, "runbook.published", actorOf(input.principal), { version, digest: signed.digest, kid: signed.kid, risk: classification.risk, escapeHatchSteps: classification.escapeHatchSteps.length, steps: definition.steps.length }, at);
        return rec;
      }
      throw new RunbookError("conflict", "Could not assign a version number; retry.");
    },

    /** Request one bounded run. Returns `pending_approval` until an independent approver binds the exact effect. */
    async requestRun(input: RunRequestInput): Promise<RunbookRunRecord> {
      await allow(input.principal, input.workspaceId, "request");
      const { rec, classification } = await loadVerified(input.workspaceId, input.runbookId, input.version);
      const targets = checkedTargets(input.targets);
      const windows = parseWindows(input.windows);
      const { maxRunDurationSec, maxParallelTargets } = bounds(input);
      const at = now();
      const deadlineMs = adHocDeadline({ nowMs: at.getTime(), windows, maxRunDurationSec, notAfter: input.notAfter });
      const bindingDigest = bindingDigestOf({ workspaceId: input.workspaceId, runbookId: input.runbookId, version: rec.version, definitionDigest: rec.definitionDigest, targets, maxRunDurationSec, maxParallelTargets, windows, notAfter: input.notAfter });
      const approval = await store.findValidApproval(input.workspaceId, bindingDigest, at);
      const requestedBy = accountableOf(input.principal);
      const gate = evaluateRunbookGate({ classification, approval, requestedBy, now: at });
      const run: RunbookRunRecord = {
        id: `rbr_${randomUUID()}`,
        workspaceId: input.workspaceId,
        runbookId: input.runbookId,
        version: rec.version,
        definitionDigest: rec.definitionDigest,
        bindingDigest,
        targets,
        maxParallelTargets,
        status: gate.outcome === "allow" ? "approved" : "pending_approval",
        requestedBy,
        requester: plainPrincipal(input.principal),
        deadlineAt: new Date(deadlineMs).toISOString(),
        createdAt: at.toISOString(),
      };
      const { run: stored } = await store.insertRun(run);
      await store.appendAudit(input.workspaceId, `run:${stored.id}`, "run.requested", requestedBy, { runbookId: input.runbookId, version: rec.version, binding: bindingDigest, targets: targets.length, status: stored.status, gate: gate.reason, highRisk: gate.highRisk, deadline: stored.deadlineAt }, at);
      return stored;
    },

    /** An independent human approves exactly this run's binding. The requester cannot approve their own run. */
    async approveRun(input: { workspaceId: string; runId: string; principal: Principal; ttlSec?: number }): Promise<RunbookRunRecord> {
      await allow(input.principal, input.workspaceId, "approve");
      if (input.principal.kind !== "user") throw new RunbookError("forbidden", "Only a signed-in person can approve a runbook run.");
      const run = await store.getRun(input.workspaceId, input.runId);
      if (!run) throw new RunbookError("not_found", "That run does not exist.");
      if (run.status !== "pending_approval") throw new RunbookError("conflict", "That run is not waiting for approval.");
      const at = now();
      if (Date.parse(run.deadlineAt) <= at.getTime()) throw new RunbookError("outside_window", "The run's window has already closed.");
      const { classification } = await loadVerified(input.workspaceId, run.runbookId, run.version);
      const approver = accountableOf(input.principal);
      if (approver === run.requestedBy) throw new RunbookError("forbidden", "You cannot approve your own run.");
      const cap = approvalTtlCapSec(classification);
      const ttl = Math.min(input.ttlSec ?? cap, cap, Math.max(1, Math.floor((Date.parse(run.deadlineAt) - at.getTime()) / 1000)));
      const approval: RunbookApprovalRecord = { id: `rba_${randomUUID()}`, workspaceId: input.workspaceId, bindingDigest: run.bindingDigest, requestedBy: run.requestedBy, approverId: approver, expiresAt: new Date(at.getTime() + ttl * 1000).toISOString(), createdAt: at.toISOString() };
      await store.insertApproval(approval);
      if (!(await store.approveRun(input.workspaceId, run.id))) throw new RunbookError("conflict", "That run is no longer waiting for approval.");
      await store.appendAudit(input.workspaceId, `run:${run.id}`, "run.approved", approver, { approvalId: approval.id, binding: run.bindingDigest, expiresAt: approval.expiresAt, highRisk: classification.escapeHatchSteps.length > 0 }, at);
      return { ...run, status: "approved" };
    },

    /** Cancel a pending run immediately, or flag a running one: the runner stops before its next step and aborts the in-flight one. */
    async cancelRun(input: { workspaceId: string; runId: string; principal: Principal; reason: string }): Promise<RunbookRunRecord> {
      await allow(input.principal, input.workspaceId, "cancel");
      const at = now();
      const reason = input.reason.replace(/[\r\n\t]+/g, " ").slice(0, 200) || "cancelled";
      const run = await store.requestCancel(input.workspaceId, input.runId, reason, at);
      if (!run) throw new RunbookError("conflict", "That run does not exist or has already finished.");
      await store.appendAudit(input.workspaceId, `run:${run.id}`, "run.cancel_requested", actorOf(input.principal), { status: run.status }, at);
      return run;
    },

    /** Create a bounded schedule. It becomes active only once the exact schedule binding is approved (if its runbook needs it). */
    async createSchedule(input: { workspaceId: string; runbookId: string; version?: number; targets: unknown; spec: unknown; principal: Principal }): Promise<RunbookScheduleRecord> {
      await allow(input.principal, input.workspaceId, "schedule");
      const { rec, classification } = await loadVerified(input.workspaceId, input.runbookId, input.version);
      const targets = checkedTargets(input.targets);
      const spec = parseScheduleSpec(input.spec);
      const at = now();
      const bindingDigest = bindingDigestOf({ workspaceId: input.workspaceId, runbookId: input.runbookId, version: rec.version, definitionDigest: rec.definitionDigest, targets, maxRunDurationSec: spec.maxRunDurationSec, maxParallelTargets: spec.maxParallelTargets, schedule: spec });
      const createdBy = accountableOf(input.principal);
      const active = !classification.requiresApproval;
      const first = nextSlotInWindow(spec, at.getTime());
      const sched: RunbookScheduleRecord = {
        id: `rbs_${randomUUID()}`,
        workspaceId: input.workspaceId,
        runbookId: input.runbookId,
        version: rec.version,
        spec,
        targets,
        bindingDigest,
        status: active ? "active" : "pending_approval",
        nextDueAt: active && first !== undefined ? new Date(first).toISOString() : null,
        createdBy,
        creator: plainPrincipal(input.principal),
        createdAt: at.toISOString(),
      };
      await store.insertSchedule(sched);
      await store.appendAudit(input.workspaceId, `schedule:${sched.id}`, "schedule.created", createdBy, { runbookId: input.runbookId, version: rec.version, binding: bindingDigest, targets: targets.length, status: sched.status, highRisk: classification.escapeHatchSteps.length > 0 }, at);
      return sched;
    },

    async approveSchedule(input: { workspaceId: string; scheduleId: string; principal: Principal; ttlSec?: number }): Promise<RunbookScheduleRecord> {
      await allow(input.principal, input.workspaceId, "approve");
      if (input.principal.kind !== "user") throw new RunbookError("forbidden", "Only a signed-in person can approve a schedule.");
      const sched = await store.getSchedule(input.workspaceId, input.scheduleId);
      if (!sched) throw new RunbookError("not_found", "That schedule does not exist.");
      if (sched.status !== "pending_approval") throw new RunbookError("conflict", "That schedule is not waiting for approval.");
      const approver = accountableOf(input.principal);
      if (approver === sched.createdBy) throw new RunbookError("forbidden", "You cannot approve your own schedule.");
      const { classification } = await loadVerified(input.workspaceId, sched.runbookId, sched.version);
      const at = now();
      // A raw-exec schedule only ever runs inside its short-lived approval; it must be re-approved to continue.
      const cap = approvalTtlCapSec(classification);
      const ttl = Math.min(input.ttlSec ?? cap, cap);
      const approval: RunbookApprovalRecord = { id: `rba_${randomUUID()}`, workspaceId: input.workspaceId, bindingDigest: sched.bindingDigest, requestedBy: sched.createdBy, approverId: approver, expiresAt: new Date(at.getTime() + ttl * 1000).toISOString(), createdAt: at.toISOString() };
      await store.insertApproval(approval);
      const first = nextSlotInWindow(sched.spec, at.getTime());
      // the cursor of a freshly activated schedule starts at its first future slot inside a window
      const nextIso = first === undefined ? null : new Date(first).toISOString();
      if (!(await store.activateSchedule(input.workspaceId, sched.id, ["pending_approval"], nextIso))) throw new RunbookError("conflict", "That schedule is no longer waiting for approval.");
      await store.appendAudit(input.workspaceId, `schedule:${sched.id}`, "schedule.approved", approver, { approvalId: approval.id, binding: sched.bindingDigest, expiresAt: approval.expiresAt, escapeHatchApprovalCapSec: ESCAPE_HATCH_APPROVAL_MAX_SEC }, at);
      return { ...sched, status: nextIso === null ? "completed" : "active", nextDueAt: nextIso };
    },

    async setScheduleState(input: { workspaceId: string; scheduleId: string; state: "paused" | "active" | "cancelled"; principal: Principal }): Promise<void> {
      await allow(input.principal, input.workspaceId, "schedule");
      const refuse = (): never => {
        throw new RunbookError("conflict", "The schedule cannot move to that state.");
      };
      if (input.state === "active") {
        const sched = await store.getSchedule(input.workspaceId, input.scheduleId);
        if (!sched) return refuse();
        const first = nextSlotInWindow(sched.spec, now().getTime());
        // resuming never replays slots that passed while paused
        if (!(await store.activateSchedule(input.workspaceId, input.scheduleId, ["paused"], first === undefined ? null : new Date(first).toISOString()))) refuse();
      } else if (!(await store.setScheduleStatus(input.workspaceId, input.scheduleId, ["active", "paused", "pending_approval"], input.state))) refuse();
      await store.appendAudit(input.workspaceId, `schedule:${input.scheduleId}`, `schedule.${input.state}`, actorOf(input.principal), {}, now());
    },

    /**
     * Durable schedule tick: call periodically from any scheduler. Idempotent and safe to run on
     * several instances: a slot becomes at most one run (unique on schedule + slot) and the
     * cursor moves by compare-and-set. Late slots are recorded as missed and never run late.
     */
    async tickSchedules(opts: { limit?: number } = {}): Promise<{ created: number; missed: number; blocked: number }> {
      const out = { created: 0, missed: 0, blocked: 0 };
      const at = now();
      for (const sched of await store.listDueSchedules(at, opts.limit ?? 25)) {
        let dueAt = sched.nextDueAt;
        for (let i = 0; i < MAX_TICK_SLOTS_PER_SCHEDULE && dueAt !== null && Date.parse(dueAt) <= at.getTime(); i += 1) {
          const slotMs = Date.parse(dueAt);
          const decision = decideSlot(sched.spec, slotMs, at.getTime());
          const nextMs = nextSlotInWindow(sched.spec, slotMs);
          const next = nextMs === undefined ? null : new Date(nextMs).toISOString();
          const subject = `schedule:${sched.id}`;
          if (decision.action === "missed") {
            if (!(await store.advanceSchedule(sched.workspaceId, sched.id, dueAt, next))) break;
            out.missed += 1;
            await store.appendAudit(sched.workspaceId, subject, "schedule.slot_missed", "system:scheduler", { slot: dueAt, reason: decision.reason }, at);
            dueAt = next;
            continue;
          }
          let verified: RunbookClassification;
          try {
            verified = (await loadVerified(sched.workspaceId, sched.runbookId, sched.version)).classification;
          } catch {
            // an unverifiable version is never run; the slot is blocked and audited
            if (!(await store.advanceSchedule(sched.workspaceId, sched.id, dueAt, next))) break;
            out.blocked += 1;
            await store.appendAudit(sched.workspaceId, subject, "schedule.slot_blocked", "system:scheduler", { slot: dueAt, reason: "signature_invalid" }, at);
            dueAt = next;
            continue;
          }
          const approval = await store.findValidApproval(sched.workspaceId, sched.bindingDigest, at);
          const gate = evaluateRunbookGate({ classification: verified, approval, requestedBy: sched.createdBy, now: at });
          if (gate.outcome !== "allow") {
            if (!(await store.advanceSchedule(sched.workspaceId, sched.id, dueAt, next))) break;
            out.blocked += 1;
            await store.appendAudit(sched.workspaceId, subject, "schedule.slot_blocked", "system:scheduler", { slot: dueAt, reason: gate.reason }, at);
            dueAt = next;
            continue;
          }
          const run: RunbookRunRecord = {
            id: `rbr_${randomUUID()}`,
            workspaceId: sched.workspaceId,
            runbookId: sched.runbookId,
            version: sched.version,
            definitionDigest: (await store.getVersion(sched.workspaceId, sched.runbookId, sched.version))!.definitionDigest,
            bindingDigest: sched.bindingDigest,
            scheduleId: sched.id,
            dueAt,
            targets: sched.targets,
            maxParallelTargets: sched.spec.maxParallelTargets,
            status: "approved",
            requestedBy: sched.createdBy,
            requester: sched.creator,
            deadlineAt: new Date(decision.deadlineMs).toISOString(),
            createdAt: at.toISOString(),
          };
          const { run: stored, created } = await store.insertRun(run);
          if (created) {
            out.created += 1;
            await store.appendAudit(sched.workspaceId, `run:${stored.id}`, "run.requested", "system:scheduler", { schedule: sched.id, slot: dueAt, binding: sched.bindingDigest, targets: sched.targets.length, status: stored.status, gate: gate.reason, deadline: stored.deadlineAt }, at);
          }
          if (!(await store.advanceSchedule(sched.workspaceId, sched.id, dueAt, next))) break;
          dueAt = next;
        }
      }
      return out;
    },

    async listRunbooks(input: { workspaceId: string; principal: Principal; limit?: number }): Promise<RunbookVersionRecord[]> {
      await allow(input.principal, input.workspaceId, "read");
      return store.listRunbooks(input.workspaceId, input.limit ?? 50);
    },
    async listRuns(input: { workspaceId: string; principal: Principal; limit?: number; status?: RunbookRunRecord["status"] }): Promise<RunbookRunRecord[]> {
      await allow(input.principal, input.workspaceId, "read");
      return store.listRuns(input.workspaceId, input.limit ?? 50, input.status);
    },
    async listSchedules(input: { workspaceId: string; principal: Principal; limit?: number }): Promise<RunbookScheduleRecord[]> {
      await allow(input.principal, input.workspaceId, "read");
      return store.listSchedules(input.workspaceId, input.limit ?? 50);
    },
    /** One run with its per-target step custody and its verified audit trail. */
    async readRun(input: { workspaceId: string; runId: string; principal: Principal }) {
      await allow(input.principal, input.workspaceId, "read");
      const run = await store.getRun(input.workspaceId, input.runId);
      if (!run) return null;
      const [steps, audit] = await Promise.all([store.listSteps(input.workspaceId, run.id), store.listAudit(input.workspaceId, `run:${run.id}`)]);
      return { run, steps, audit };
    },
    getRun: (workspaceId: string, runId: string) => store.getRun(workspaceId, runId),
    listAudit: (workspaceId: string, subject: string) => store.listAudit(workspaceId, subject),
    definitionDigest,
  };
}

export type RunbookService = ReturnType<typeof createRunbookService>;
