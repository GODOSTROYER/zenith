/** In-memory `ReleaseStore`: the same contract as the SQL store, for unit tests. Not used in production composition. */
import type { NewRun, ReleaseStore, TransitionInput } from "./store";
import type { MigrationApproval, ReleaseEvent, ReleaseRun } from "./types";

export function createMemoryReleaseStore(clock: () => Date = () => new Date()): ReleaseStore & { runs: Map<string, ReleaseRun> } {
  const runs = new Map<string, ReleaseRun>();
  const events = new Map<string, ReleaseEvent[]>();
  const approvals = new Map<string, MigrationApproval>();
  const order = new Map<string, number>();
  const iso = () => clock().toISOString();
  const key = (ws: string, id: string) => `${ws}\u0000${id}`;
  const clone = <T>(v: T): T => structuredClone(v);

  const log = (run: ReleaseRun, from: ReleaseRun["state"] | null, actor: string, detail: string) => {
    const list = events.get(key(run.workspaceId, run.id)) ?? [];
    list.push({ runId: run.id, seq: list.length + 1, from, to: run.state, detail, actor, at: iso() });
    events.set(key(run.workspaceId, run.id), list);
  };

  return {
    runs,
    async insertRun(input: NewRun) {
      const existing = [...runs.values()].find((r) => r.workspaceId === input.workspaceId && r.operationId === input.operationId && r.serviceAddress === input.serviceAddress && r.kind === input.kind);
      if (existing) return { run: clone(existing), created: false };
      const now = iso();
      const run: ReleaseRun = { ...clone(input), version: 1, createdAt: now, updatedAt: now };
      runs.set(key(run.workspaceId, run.id), run);
      order.set(key(run.workspaceId, run.id), order.size);
      log(run, null, "system", "release run planned");
      return { run: clone(run), created: true };
    },
    async getRun(ws, id) {
      const r = runs.get(key(ws, id));
      return r ? clone(r) : null;
    },
    async findRun(ws, operationId, serviceAddress, kind) {
      const r = [...runs.values()].find((x) => x.workspaceId === ws && x.operationId === operationId && x.serviceAddress === serviceAddress && x.kind === kind);
      return r ? clone(r) : null;
    },
    async listRuns(ws, f) {
      return [...runs.values()]
        .filter((r) => r.workspaceId === ws && (!f.environmentId || r.environmentId === f.environmentId) && (!f.serviceAddress || r.serviceAddress === f.serviceAddress) && (!f.operationId || r.operationId === f.operationId) && (!f.revisionId || r.revisionId === f.revisionId) && (!f.states || f.states.includes(r.state)))
        .sort((a, b) => (a.createdAt === b.createdAt ? order.get(key(b.workspaceId, b.id))! - order.get(key(a.workspaceId, a.id))! : a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, f.limit ?? 100)
        .map(clone);
    },
    async transition(input: TransitionInput) {
      const cur = runs.get(key(input.workspaceId, input.id));
      if (!cur || cur.version !== input.expectVersion) return null;
      const from = cur.state;
      const next: ReleaseRun = { ...cur, ...clone(input.patch ?? {}), state: input.to, version: cur.version + 1, updatedAt: iso() };
      // identity and digest columns are structurally outside the patch type; keep them anyway
      next.imageDigest = cur.imageDigest;
      runs.set(key(next.workspaceId, next.id), next);
      log(next, from, input.actor, input.detail);
      return clone(next);
    },
    async listEvents(ws, runId) {
      return clone(events.get(key(ws, runId)) ?? []);
    },
    async insertApproval(a) {
      const existing = [...approvals.values()].find((x) => x.workspaceId === a.workspaceId && x.runId === a.runId && x.bindingDigest === a.bindingDigest);
      if (existing) return { approval: clone(existing), created: false };
      const row: MigrationApproval = { ...a };
      approvals.set(key(a.workspaceId, a.id), row);
      return { approval: clone(row), created: true };
    },
    async findUsableApproval(ws, bindingDigest, now) {
      const found = [...approvals.values()]
        .filter((a) => a.workspaceId === ws && a.bindingDigest === bindingDigest && !a.consumedAt && new Date(a.expiresAt) > now)
        .sort((a, b) => (a.approvedAt < b.approvedAt ? 1 : -1))[0];
      return found ? clone(found) : null;
    },
    async consumeApproval(ws, id, now) {
      const a = approvals.get(key(ws, id));
      if (!a || a.consumedAt || new Date(a.expiresAt) <= now) return false;
      a.consumedAt = now.toISOString();
      return true;
    },
  };
}

