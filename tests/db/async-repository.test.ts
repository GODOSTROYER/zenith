import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncRepository } from "@/lib/db/pg/async-repository";

const request = {
  method: "GET" as const,
  path: "audit_events?select=*&limit=1",
  table: "audit_events",
  op: "read",
};

const context = { tenantId: "workspace-a", authorization: "Bearer test-user" };

afterEach(() => vi.restoreAllMocks());

describe("PostgrestAsyncRepository", () => {
  it("awaits a successful request and preserves auth and tenant context", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(
        "https://supabase.test/rest/v1/audit_events?select=*&limit=1&workspace_id=eq.workspace-a"
      );
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-user", apikey: "test-key" });
      return new Response(JSON.stringify([{ id: "event-1" }]), {
        status: 200,
        headers: { "content-range": "0-0/1" },
      });
    });
    const repo = createAsyncRepository({
      baseUrl: "https://supabase.test",
      apiKey: "test-key",
      fetch: fetchMock,
    });

    await expect(repo.request(request, context)).resolves.toEqual({
      rows: [{ id: "event-1" }],
      total: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("propagates PostgREST HTTP failures with store context", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ message: "row violates policy", hint: "check workspace" }), {
        status: 403,
      })
    );
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await expect(repo.request({ ...request, method: "POST", op: "write" }, context)).rejects.toThrow(
      /could not write "audit_events": row violates policy \(check workspace\)/
    );
  });

  it("binds tenant identity into object writes and rejects a mismatched body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ id: "event-1", workspace_id: "workspace-a" });
      return new Response("[]", { status: 201 });
    });
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await repo.request({ ...request, method: "POST", body: { id: "event-1" }, op: "write" }, context);
    await expect(repo.request({ ...request, method: "PATCH", body: { workspace_id: "workspace-b" }, op: "write" }, context))
      .rejects.toThrow(/body tenant does not match/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not let callers select an arbitrary tenant column", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await expect(repo.request({ ...request, tenantColumn: "organization_id" }, context))
      .rejects.toThrow(/table-specific repository/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with a bounded timeout and aborts the underlying request", async () => {
    let aborted = false;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      throw new Error("unreachable");
    });
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock, timeoutMs: 20 });
    await expect(repo.request(request, context)).rejects.toThrow(/within 20 ms/);
    expect(aborted).toBe(true);
  });

  it("honors caller cancellation while keeping the event loop available", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true });
      });
      throw new Error("unreachable");
    });
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock, timeoutMs: 100 });
    const ticks: number[] = [];
    const interval = setInterval(() => ticks.push(Date.now()), 2);
    const pending = repo.request(request, { ...context, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller cancelled")), 12);
    await expect(pending).rejects.toThrow(/caller cancelled/);
    clearInterval(interval);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("rejects an absent tenant before touching the transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await expect(repo.request(request, { tenantId: "  " })).rejects.toThrow(/tenant is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a caller-selected unscoped query", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await expect(repo.request({ ...request, tenantColumn: null } as never, context)).rejects.toThrow(/unscoped async access is not available/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retain failed initialization state across the next request", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const repo = createAsyncRepository({ baseUrl: "https://supabase.test", apiKey: "test-key", fetch: fetchMock });
    await expect(repo.request(request, context)).rejects.toThrow(/connection reset/);
    await expect(repo.request(request, context)).resolves.toEqual({ rows: [], total: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
