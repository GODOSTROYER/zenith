import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  postgres: true,
  user: { id: "user-editor", email: "editor@example.test", name: "Editor" } as { id: string; email: string; name: string } | null,
  workspace: { id: "workspace-one", name: "Shared workspace", slug: "shared", createdAt: "2026-01-01T00:00:00.000Z" },
  graph: { workspaces: [] as { id: string }[], members: [] as { id: string; email: string; workspaceId: string }[] },
  rows: [] as { id: string; workspace_id: string }[],
  error: null as { message: string } | null,
  reject: false,
  queries: [] as Record<string, string>[],
}));

vi.mock("@/lib/db/store", () => ({ db: () => state.graph, isPostgres: () => state.postgres }));
vi.mock("@/lib/server/request", () => ({ currentRequest: () => ({ user: state.user, workspace: state.workspace }) }));
vi.mock("@/lib/server/membership", () => ({ ensureMember: vi.fn() }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/db/postgres-store", () => ({
  pgClient: () => ({
    from(table: string) {
      const filters: Record<string, string> = { table };
      const query = {
        select: (columns: string) => { filters.columns = columns; return query; },
        eq: (column: string, value: string) => { filters[column] = value; return query; },
        async maybeSingle() {
          state.queries.push(filters);
          if (state.reject) throw new Error("Database transport is unavailable");
          const data = state.rows.find((row) => row.id === filters.id && row.workspace_id === filters.workspace_id);
          return { data: data ?? null, error: state.error };
        },
      };
      return query;
    },
  }),
}));

const { membershipCheck } = await import("@/lib/server/workspace");
const { sseResponse } = await import("@/lib/server/sse");

beforeEach(() => {
  vi.useFakeTimers();
  state.postgres = true;
  state.user = { id: "user-editor", email: "editor@example.test", name: "Editor" };
  state.graph = {
    workspaces: [state.workspace],
    members: [{ ...state.user, workspaceId: state.workspace.id }],
  };
  state.rows = [{ id: state.user.id, workspace_id: state.workspace.id }];
  state.error = null;
  state.reject = false;
  state.queries = [];
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("workspace streams revalidate PostgreSQL membership", () => {
  it("reads the current identity and workspace rather than the connect-time member snapshot", async () => {
    const guard = membershipCheck();
    expect(await guard()).toBeUndefined();
    state.rows = [];
    expect(state.graph.members).toHaveLength(1); // the old request graph still grants access
    expect(await guard()).toMatchObject({ message: expect.stringContaining("membership") });
    expect(state.queries).toEqual([
      { table: "members", columns: "id", workspace_id: "workspace-one", id: "user-editor" },
      { table: "members", columns: "id", workspace_id: "workspace-one", id: "user-editor" },
    ]);
  });

  it("does not count membership in another workspace as access to this stream", async () => {
    state.rows = [{ id: "user-editor", workspace_id: "workspace-other" }];
    expect(await membershipCheck()()).toMatchObject({ message: expect.stringContaining("membership") });
  });

  it.each(["response", "transport"])("fails closed when the database %s fails", async (failure) => {
    if (failure === "response") state.error = { message: "Database read failed" };
    else state.reject = true;
    const pull = vi.fn(() => [{ event: "log", data: "private deployment output" }]);
    const response = sseResponse(new AbortController().signal, membershipCheck(), pull);
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain("could not be verified");
    expect(body).not.toContain("private deployment output");
    expect(pull).not.toHaveBeenCalled();
  });

  it("closes an open stream after removal without pulling another batch", async () => {
    const pull = vi.fn(() => [{ event: "log", data: "authorized output" }]);
    const response = sseResponse(new AbortController().signal, membershipCheck(), pull);
    const reading = response.text();
    await vi.advanceTimersByTimeAsync(1);
    expect(pull).toHaveBeenCalledTimes(1);
    state.rows = [];
    await vi.advanceTimersByTimeAsync(300);
    const body = await reading;
    expect(body).toContain("authorized output");
    expect(body).toContain("event: error");
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("discards a batch if the member is removed while its asynchronous read is running", async () => {
    const pull = vi.fn(async () => {
      state.rows = [];
      return [{ event: "log", data: "must never reach the removed user" }];
    });
    const response = sseResponse(new AbortController().signal, membershipCheck(), pull);
    const body = await response.text();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(state.queries).toHaveLength(2);
    expect(body).toContain("event: error");
    expect(body).not.toContain("must never reach the removed user");
  });

  it("does not read a payload after the connection is aborted during a membership check", async () => {
    const abort = new AbortController();
    const guard = async () => { abort.abort(); return undefined; };
    const pull = vi.fn(() => [{ data: "private" }]);
    const response = sseResponse(abort.signal, guard, pull);
    expect(await response.text()).not.toContain("private");
    expect(pull).not.toHaveBeenCalled();
  });

  it("keeps synchronous file-store membership checks live without querying PostgreSQL", () => {
    state.postgres = false;
    const guard = membershipCheck();
    expect(guard()).toBeUndefined();
    state.graph.members = [];
    expect(guard()).toMatchObject({ message: expect.stringContaining("membership") });
    expect(state.queries).toEqual([]);
  });
});
