/**
 * Run storage seam (PROD-MACH-06): the platform Postgres repo in production, a
 * semantically identical in-memory store for unit tests of the loop. The
 * memory store mirrors the repo's rules (tenant filter, version CAS, only a
 * running row accepts progress, one resume claim) so the loop is tested against
 * the same contract the SQL enforces.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import * as repo from "@/lib/controlplane/db/repos/coding-agent-runs";
import type { CodingAgentRunRow, CreateRunInput, SaveRunInput } from "@/lib/controlplane/db/repos/coding-agent-runs";

export type { CodingAgentRunRow, CreateRunInput, SaveRunInput };

export interface RunStore {
  create(input: CreateRunInput): Promise<CodingAgentRunRow>;
  get(workspaceId: string, id: string): Promise<CodingAgentRunRow | null>;
  list(workspaceId: string, limit?: number): Promise<CodingAgentRunRow[]>;
  save(input: SaveRunInput): Promise<CodingAgentRunRow>;
  attachOutcome(input: { workspaceId: string; id: string; result?: unknown; proposalOperationId?: string }): Promise<CodingAgentRunRow>;
  claimResume(input: { workspaceId: string; id: string; limits: unknown; workflowId: string }): Promise<CodingAgentRunRow>;
  cancel(input: { workspaceId: string; id: string }): Promise<CodingAgentRunRow>;
  fail(input: { workspaceId: string; id: string; stopReason: unknown }): Promise<CodingAgentRunRow | null>;
}

export const platformRunStore = (sql: Sql): RunStore => ({
  create: (i) => repo.createRun(sql, i),
  get: (w, id) => repo.getRun(sql, w, id),
  list: (w, n) => repo.listRuns(sql, w, n),
  save: (i) => repo.saveRun(sql, i),
  attachOutcome: (i) => repo.attachOutcome(sql, i),
  claimResume: (i) => repo.claimResume(sql, i),
  cancel: (i) => repo.cancelRun(sql, i),
  fail: (i) => repo.failRun(sql, i),
});

export function memoryRunStore(): RunStore {
  const rows = new Map<string, CodingAgentRunRow>();
  const key = (w: string, id: string): string => `${w}\u0000${id}`;
  const clone = <T>(v: T): T => structuredClone(v);
  const stamp = (): string => new Date().toISOString();
  const find = (w: string, id: string): CodingAgentRunRow | undefined => rows.get(key(w, id));
  return {
    async create(i) {
      const row: CodingAgentRunRow = {
        id: i.id, workspaceId: i.workspaceId, ...(i.projectId ? { projectId: i.projectId } : {}), ...(i.environmentId ? { environmentId: i.environmentId } : {}),
        createdBy: i.createdBy, status: "running", model: i.model, task: i.task, source: clone(i.source), limits: clone(i.limits), usage: clone(i.usage), checkpoint: clone(i.checkpoint),
        workflowId: i.workflowId, version: 1, createdAt: stamp(), updatedAt: stamp(),
      };
      if (rows.has(key(i.workspaceId, i.id))) throw new ControlStoreError("conflict", "Run exists.", { id: i.id });
      rows.set(key(i.workspaceId, i.id), row);
      return clone(row);
    },
    async get(w, id) {
      const r = find(w, id);
      return r ? clone(r) : null;
    },
    async list(w, n = 25) {
      return [...rows.values()].filter((r) => r.workspaceId === w).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, n).map(clone);
    },
    async save(i) {
      const r = find(i.workspaceId, i.id);
      if (!r) throw new ControlStoreError("not_found", "Run not found.", { id: i.id });
      if (r.version !== i.expectedVersion || r.status !== "running") throw new ControlStoreError("conflict", "The run changed or is not running.", { id: i.id, status: r.status, currentVersion: r.version });
      r.status = i.status;
      if (i.stopReason === undefined) delete r.stopReason;
      else r.stopReason = clone(i.stopReason);
      r.limits = clone(i.limits);
      r.usage = clone(i.usage);
      r.checkpoint = clone(i.checkpoint);
      if (i.result !== undefined) r.result = clone(i.result);
      if (i.proposalOperationId && !r.proposalOperationId) r.proposalOperationId = i.proposalOperationId;
      r.version += 1;
      r.updatedAt = stamp();
      return clone(r);
    },
    async attachOutcome(i) {
      const r = find(i.workspaceId, i.id);
      if (!r || r.status === "running") throw new ControlStoreError("not_found", "Run not found or still running.", { id: i.id });
      if (i.result !== undefined && r.result === undefined) r.result = clone(i.result);
      if (i.proposalOperationId && !r.proposalOperationId) r.proposalOperationId = i.proposalOperationId;
      r.version += 1;
      r.updatedAt = stamp();
      return clone(r);
    },
    async claimResume(i) {
      const r = find(i.workspaceId, i.id);
      if (!r) throw new ControlStoreError("not_found", "Run not found.", { id: i.id });
      const crashed = r.status === "running" && Date.now() - Date.parse(r.updatedAt) > 10 * 60_000;
      if (r.status !== "budget_exhausted" && r.status !== "failed" && !crashed) throw new ControlStoreError("invalid_state", "Only a run stopped by a budget or an error can be resumed.", { id: i.id, status: r.status });
      r.status = "running";
      delete r.stopReason;
      r.workflowId = i.workflowId;
      r.limits = clone(i.limits);
      r.version += 1;
      r.updatedAt = stamp();
      return clone(r);
    },
    async cancel(i) {
      const r = find(i.workspaceId, i.id);
      if (!r) throw new ControlStoreError("not_found", "Run not found.", { id: i.id });
      if (r.status !== "running" && r.status !== "budget_exhausted" && r.status !== "failed") throw new ControlStoreError("invalid_state", "The run already finished.", { id: i.id, status: r.status });
      r.status = "cancelled";
      r.stopReason = { kind: "cancelled" };
      r.version += 1;
      r.updatedAt = stamp();
      return clone(r);
    },
    async fail(i) {
      const r = find(i.workspaceId, i.id);
      if (!r || r.status !== "running") return null;
      r.status = "failed";
      r.stopReason = clone(i.stopReason);
      r.version += 1;
      r.updatedAt = stamp();
      return clone(r);
    },
  };
}
