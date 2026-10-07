/**
 * Storage seam of the mixed run (PROD-MIX-04): the platform Postgres repo in production and an
 * in-memory store with the same rules (tenant filter, version compare-and-set, append-only ledger)
 * for tests. State read back is re-validated; a malformed or foreign row is an error, never a
 * best-effort state.
 */
import { z } from "zod";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import * as repo from "@/lib/controlplane/db/repos/mixed-runs";
import { digest } from "@/lib/controlplane/digest";
import { ID, MixedOrchestrationError, refuse, SHA } from "./errors";
import { isRunOpen, nextDeadline, type MixedRunState } from "./run";

const Iso = z.string().min(20).max(40);
const ChildSchema = z.object({
  id: z.string().min(1).max(200), dependsOn: z.array(z.string()).max(256), nodes: z.array(z.object({ address: z.string().max(512), ownership: z.enum(["managed", "referenced", "external"]) }).strict()).max(10000), incoming: z.array(z.object({ referenceId: z.string(), materialized: z.boolean() }).strict()).max(512), subplanDigest: z.string().regex(SHA), effectDigest: z.string().regex(SHA),
  status: z.enum(["pending", "blocked", "running", "succeeded", "failed", "timed_out", "outage", "cancel_requested", "cancelled", "expired"]),
  attempts: z.number().int().min(0).max(1000), attemptId: z.string().optional(), startedAt: Iso.optional(), finishedAt: Iso.optional(), receiptDigest: z.string().regex(SHA).optional(),
  effects: z.enum(["none", "possible", "present"]), reconciliationRequired: z.boolean(), reason: z.string().max(100).optional(), blockedBy: z.array(z.string()).optional(),
  rebinds: z.array(z.object({ effectDigest: z.string().regex(SHA), authority: z.enum(["unchanged", "review", "preauthorization"]), authorityRef: z.string().max(2000), at: Iso }).strict()).max(1000),
}).strict();
const StepSchema = z.object({
  childId: z.string(), addresses: z.array(z.string()).max(10000), after: z.array(z.string()), stepDigest: z.string().regex(SHA),
  status: z.enum(["planned", "released", "destroyed", "failed", "uncertain"]), destroyOperationId: z.string().optional(), approvalId: z.string().optional(),
  releasedAt: Iso.optional(), finishedAt: Iso.optional(),
}).strict();
const StateSchema = z.object({
  version: z.literal(1), workspaceId: z.string().regex(ID), environmentId: z.string().regex(ID), parentOperationId: z.string().regex(ID),
  parentDigest: z.string().regex(SHA), desiredDigest: z.string().regex(SHA), order: z.array(z.string()).min(1).max(64), expiresAt: Iso,
  childTimeoutMs: z.number().int(), cancelRequestedAt: Iso.optional(), seq: z.number().int().min(0),
  children: z.record(z.string(), ChildSchema), teardown: z.object({ planDigest: z.string().regex(SHA), createdAt: Iso, steps: z.array(StepSchema).max(64) }).strict().optional(),
}).strict();

export function parseRunState(value: unknown): MixedRunState {
  const parsed = StateSchema.safeParse(value);
  if (!parsed.success) return refuse("invalid_input");
  const state = parsed.data as MixedRunState;
  const ids = new Set(Object.keys(state.children));
  if (state.order.length !== ids.size || state.order.some((id) => !ids.has(id) || state.children[id].id !== id)) return refuse("invalid_input");
  return state;
}

export interface StoredRun { state: MixedRunState; version: number }
export interface LedgerEvent { seq: number; kind: string; childId?: string; data: unknown }
export type LedgerEventKind = "run_created" | "start" | "succeed" | "fail" | "outage" | "tick" | "cancel" | "cancel_confirmed" | "reconciled" | "retry" | "rebind" | "teardown_planned" | "teardown_released" | "teardown_result";

export interface MixedRunStore {
  get(workspaceId: string, parentOperationId: string): Promise<StoredRun | null>;
  create(state: MixedRunState, event: Omit<LedgerEvent, "seq">): Promise<StoredRun>;
  /** Compare-and-set; throws `MixedOrchestrationError("conflict")` when the version moved. */
  save(workspaceId: string, parentOperationId: string, expectedVersion: number, state: MixedRunState, event: Omit<LedgerEvent, "seq">): Promise<StoredRun>;
  events(workspaceId: string, parentOperationId: string, limit?: number): Promise<LedgerEvent[]>;
  listDue(now: Date, limit?: number): Promise<{ workspaceId: string; parentOperationId: string }[]>;
}

const write = (state: MixedRunState) => ({
  workspaceId: state.workspaceId, parentOperationId: state.parentOperationId, environmentId: state.environmentId, parentDigest: state.parentDigest,
  desiredDigest: state.desiredDigest, state, stateDigest: digest(state), open: isRunOpen(state), nextDeadlineAt: nextDeadline(state),
});

function mapStoreError(error: unknown): never {
  if (error instanceof ControlStoreError && error.code === "conflict") throw new MixedOrchestrationError("conflict");
  if (error instanceof MixedOrchestrationError) throw error;
  throw new MixedOrchestrationError("unavailable");
}

export function platformMixedRunStore(sql: Sql): MixedRunStore {
  const toStored = (row: repo.MixedRunRow): StoredRun => {
    const state = parseRunState(row.state);
    if (state.workspaceId !== row.workspaceId || state.parentOperationId !== row.parentOperationId) return refuse("invalid_input");
    return { state, version: row.version };
  };
  return {
    async get(workspaceId, parentOperationId) {
      try { const row = await repo.get(sql, workspaceId, parentOperationId); return row ? toStored(row) : null; } catch (error) { return mapStoreError(error); }
    },
    async create(state, event) {
      try { return toStored(await repo.create(sql, { ...write(state), event: { seq: state.seq, ...event } })); } catch (error) { return mapStoreError(error); }
    },
    async save(workspaceId, parentOperationId, expectedVersion, state, event) {
      if (state.workspaceId !== workspaceId || state.parentOperationId !== parentOperationId) return refuse("invalid_input");
      try { return toStored(await repo.save(sql, { ...write(state), expectedVersion, event: { seq: state.seq, ...event } })); } catch (error) { return mapStoreError(error); }
    },
    async events(workspaceId, parentOperationId, limit) {
      try {
        return (await repo.listEvents(sql, workspaceId, parentOperationId, limit)).map((row) => ({ seq: row.seq, kind: row.kind, ...(row.childId ? { childId: row.childId } : {}), data: row.event }));
      } catch (error) { return mapStoreError(error); }
    },
    async listDue(now, limit) {
      try { return await repo.listDue(sql, now, limit); } catch (error) { return mapStoreError(error); }
    },
  };
}

/** In-process store with the repository's rules, for unit tests and the in-memory development composition. */
export class MemoryMixedRunStore implements MixedRunStore {
  private readonly rows = new Map<string, { state: MixedRunState; version: number; open: boolean; nextDeadlineAt: string | null }>();
  private readonly ledger = new Map<string, LedgerEvent[]>();
  private key = (workspaceId: string, parentOperationId: string): string => `${workspaceId}\u0000${parentOperationId}`;

  async get(workspaceId: string, parentOperationId: string): Promise<StoredRun | null> {
    const row = this.rows.get(this.key(workspaceId, parentOperationId));
    return row ? { state: structuredClone(row.state), version: row.version } : null;
  }

  async create(state: MixedRunState, event: Omit<LedgerEvent, "seq">): Promise<StoredRun> {
    const key = this.key(state.workspaceId, state.parentOperationId);
    if (this.rows.has(key)) throw new MixedOrchestrationError("conflict");
    const clean = parseRunState(structuredClone(state));
    this.rows.set(key, { state: clean, version: 1, open: isRunOpen(clean), nextDeadlineAt: nextDeadline(clean) });
    this.ledger.set(key, [{ seq: clean.seq, ...structuredClone(event) }]);
    return { state: structuredClone(clean), version: 1 };
  }

  async save(workspaceId: string, parentOperationId: string, expectedVersion: number, state: MixedRunState, event: Omit<LedgerEvent, "seq">): Promise<StoredRun> {
    const key = this.key(workspaceId, parentOperationId);
    const row = this.rows.get(key);
    if (!row) return refuse("unknown_child", parentOperationId);
    if (row.version !== expectedVersion) throw new MixedOrchestrationError("conflict");
    if (state.workspaceId !== workspaceId || state.parentOperationId !== parentOperationId || state.desiredDigest !== row.state.desiredDigest) return refuse("invalid_input");
    const clean = parseRunState(structuredClone(state));
    row.state = clean; row.version += 1; row.open = isRunOpen(clean); row.nextDeadlineAt = nextDeadline(clean);
    this.ledger.get(key)!.push({ seq: clean.seq, ...structuredClone(event) });
    return { state: structuredClone(clean), version: row.version };
  }

  async events(workspaceId: string, parentOperationId: string, limit = 200): Promise<LedgerEvent[]> {
    return structuredClone((this.ledger.get(this.key(workspaceId, parentOperationId)) ?? []).slice(0, limit));
  }

  async listDue(now: Date, limit = 50): Promise<{ workspaceId: string; parentOperationId: string }[]> {
    return [...this.rows.values()].filter((row) => row.open && row.nextDeadlineAt !== null && Date.parse(row.nextDeadlineAt) <= now.getTime())
      .slice(0, limit).map((row) => ({ workspaceId: row.state.workspaceId, parentOperationId: row.state.parentOperationId }));
  }
}
