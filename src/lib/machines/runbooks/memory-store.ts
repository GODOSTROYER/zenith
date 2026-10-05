/**
 * In-memory `RunbookStore` for development and unit tests. Same semantics as the
 * Postgres repository: tenant-scoped, immutable versions/approvals, conditional
 * transitions, unique (schedule, slot) runs, at-most-once step custody and a
 * per-subject audit hash chain. NOT for production: state dies with the process.
 */
import { AUDIT_GENESIS, auditEntryDigest, boundedAuditDetail } from "./audit";
import { RunbookError } from "./definition";
import {
  TERMINAL_RUN_STATUSES,
  type RunbookApprovalRecord,
  type RunbookAuditRecord,
  type RunbookRunRecord,
  type RunbookScheduleRecord,
  type RunbookStepRecord,
  type RunbookStore,
  type RunbookVersionRecord,
  type ScheduleStatus,
} from "./ports";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryRunbookStore implements RunbookStore {
  readonly #versions = new Map<string, RunbookVersionRecord>();
  readonly #approvals: RunbookApprovalRecord[] = [];
  readonly #schedules = new Map<string, RunbookScheduleRecord>();
  readonly #runs = new Map<string, RunbookRunRecord>();
  readonly #steps = new Map<string, RunbookStepRecord>();
  readonly #audit = new Map<string, RunbookAuditRecord[]>();

  async insertVersion(rec: RunbookVersionRecord): Promise<void> {
    const key = `${rec.workspaceId}\0${rec.runbookId}\0${rec.version}`;
    if (this.#versions.has(key)) throw new RunbookError("conflict", "That runbook version already exists; versions are immutable.");
    this.#versions.set(key, clone(rec));
  }
  async getVersion(ws: string, runbookId: string, version: number): Promise<RunbookVersionRecord | null> {
    const v = this.#versions.get(`${ws}\0${runbookId}\0${version}`);
    return v ? clone(v) : null;
  }
  async latestVersion(ws: string, runbookId: string): Promise<RunbookVersionRecord | null> {
    let best: RunbookVersionRecord | undefined;
    for (const v of this.#versions.values()) if (v.workspaceId === ws && v.runbookId === runbookId && (!best || v.version > best.version)) best = v;
    return best ? clone(best) : null;
  }

  async insertApproval(rec: RunbookApprovalRecord): Promise<void> {
    this.#approvals.push(clone(rec));
  }
  async findValidApproval(ws: string, bindingDigest: string, now: Date): Promise<RunbookApprovalRecord | null> {
    const found = this.#approvals
      .filter((a) => a.workspaceId === ws && a.bindingDigest === bindingDigest && Date.parse(a.expiresAt) > now.getTime())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return found ? clone(found) : null;
  }

  async insertSchedule(rec: RunbookScheduleRecord): Promise<void> {
    this.#schedules.set(rec.id, clone(rec));
  }
  async getSchedule(ws: string, id: string): Promise<RunbookScheduleRecord | null> {
    const s = this.#schedules.get(id);
    return s && s.workspaceId === ws ? clone(s) : null;
  }
  async setScheduleStatus(ws: string, id: string, from: readonly ScheduleStatus[], to: ScheduleStatus): Promise<boolean> {
    const s = this.#schedules.get(id);
    if (!s || s.workspaceId !== ws || !from.includes(s.status)) return false;
    s.status = to;
    return true;
  }
  async activateSchedule(ws: string, id: string, from: readonly ScheduleStatus[], nextDueAt: string | null): Promise<boolean> {
    const s = this.#schedules.get(id);
    if (!s || s.workspaceId !== ws || !from.includes(s.status)) return false;
    s.status = nextDueAt === null ? "completed" : "active";
    s.nextDueAt = nextDueAt;
    return true;
  }
  async listDueSchedules(now: Date, limit: number): Promise<RunbookScheduleRecord[]> {
    return [...this.#schedules.values()]
      .filter((s) => s.status === "active" && s.nextDueAt !== null && Date.parse(s.nextDueAt) <= now.getTime())
      .sort((a, b) => (a.nextDueAt! < b.nextDueAt! ? -1 : 1))
      .slice(0, limit)
      .map(clone);
  }
  async advanceSchedule(ws: string, id: string, expectedDueAt: string, nextDueAt: string | null): Promise<boolean> {
    const s = this.#schedules.get(id);
    if (!s || s.workspaceId !== ws || s.status !== "active" || s.nextDueAt !== expectedDueAt) return false;
    s.nextDueAt = nextDueAt;
    if (nextDueAt === null) s.status = "completed";
    return true;
  }

  async insertRun(rec: RunbookRunRecord): Promise<{ run: RunbookRunRecord; created: boolean }> {
    if (rec.scheduleId && rec.dueAt) {
      for (const r of this.#runs.values()) if (r.scheduleId === rec.scheduleId && r.dueAt === rec.dueAt) return { run: clone(r), created: false };
    }
    this.#runs.set(rec.id, clone(rec));
    return { run: clone(rec), created: true };
  }
  async getRun(ws: string, id: string): Promise<RunbookRunRecord | null> {
    const r = this.#runs.get(id);
    return r && r.workspaceId === ws ? clone(r) : null;
  }
  async approveRun(ws: string, id: string): Promise<boolean> {
    const r = this.#runs.get(id);
    if (!r || r.workspaceId !== ws || r.status !== "pending_approval") return false;
    r.status = "approved";
    return true;
  }
  async requestCancel(ws: string, id: string, reason: string, now: Date): Promise<RunbookRunRecord | null> {
    const r = this.#runs.get(id);
    if (!r || r.workspaceId !== ws || TERMINAL_RUN_STATUSES.has(r.status)) return null;
    r.cancelRequestedAt ??= now.toISOString();
    r.cancelReason ??= reason;
    if (r.status === "pending_approval" || r.status === "approved") {
      r.status = "cancelled";
      r.finishedAt = now.toISOString();
    }
    return clone(r);
  }
  async claimRun(ws: string, id: string, now: Date, leaseMs: number): Promise<RunbookRunRecord | undefined> {
    const r = this.#runs.get(id);
    if (!r || r.workspaceId !== ws) return undefined;
    const reclaim = r.status === "running" && r.leaseUntil !== undefined && Date.parse(r.leaseUntil) <= now.getTime();
    if (r.status !== "approved" && !reclaim) return undefined;
    r.status = "running";
    r.startedAt ??= now.toISOString();
    r.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return clone(r);
  }
  async touchLease(ws: string, id: string, now: Date, leaseMs: number): Promise<boolean> {
    const r = this.#runs.get(id);
    if (!r || r.workspaceId !== ws || r.status !== "running") return false;
    r.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    return true;
  }
  async finishRun(ws: string, id: string, status: RunbookRunRecord["status"], failureCode: string | undefined, now: Date): Promise<boolean> {
    const r = this.#runs.get(id);
    if (!r || r.workspaceId !== ws || r.status !== "running") return false;
    r.status = status;
    if (failureCode) r.failureCode = failureCode;
    r.finishedAt = now.toISOString();
    delete r.leaseUntil;
    return true;
  }

  async beginStep(rec: RunbookStepRecord): Promise<{ step: RunbookStepRecord; inserted: boolean }> {
    const key = `${rec.workspaceId}\0${rec.runId}\0${rec.targetIndex}\0${rec.stepId}`;
    const existing = this.#steps.get(key);
    if (existing) return { step: clone(existing), inserted: false };
    this.#steps.set(key, clone(rec));
    return { step: clone(rec), inserted: true };
  }
  async finishStep(ws: string, runId: string, targetIndex: number, stepId: string, patch: { status: Exclude<RunbookStepRecord["status"], "started">; errorCode?: string; evidenceId?: string; finishedAt: string }): Promise<void> {
    const s = this.#steps.get(`${ws}\0${runId}\0${targetIndex}\0${stepId}`);
    if (!s || s.status !== "started") return;
    s.status = patch.status;
    s.finishedAt = patch.finishedAt;
    if (patch.errorCode) s.errorCode = patch.errorCode;
    if (patch.evidenceId) s.evidenceId = patch.evidenceId;
  }
  async listSteps(ws: string, runId: string): Promise<RunbookStepRecord[]> {
    return [...this.#steps.values()].filter((s) => s.workspaceId === ws && s.runId === runId).sort((a, b) => a.targetIndex - b.targetIndex || (a.startedAt < b.startedAt ? -1 : 1)).map(clone);
  }

  async appendAudit(ws: string, subject: string, event: string, actor: string, detail: Record<string, unknown>, now: Date): Promise<RunbookAuditRecord> {
    const key = `${ws}\0${subject}`;
    const chain = this.#audit.get(key) ?? [];
    const prev = chain[chain.length - 1];
    const base = { workspaceId: ws, subject, seq: chain.length + 1, event, actor, detail: boundedAuditDetail(detail), createdAt: now.toISOString() };
    const prevDigest = prev?.entryDigest ?? AUDIT_GENESIS;
    const rec: RunbookAuditRecord = { ...base, prevDigest, entryDigest: auditEntryDigest(prevDigest, base) };
    chain.push(rec);
    this.#audit.set(key, chain);
    return clone(rec);
  }
  async listAudit(ws: string, subject: string): Promise<RunbookAuditRecord[]> {
    return clone(this.#audit.get(`${ws}\0${subject}`) ?? []);
  }
}
