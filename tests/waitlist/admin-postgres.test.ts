/**
 * Supabase adapter unit tests: mocks verify RPC routing and payload mapping only.
 * SQL selection, concurrency and permissions belong to pg-contract.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/server/errors";
import { WaitlistPreviewExpiredError } from "@/lib/waitlist/errors";
import { postgresWaitlistRepository } from "@/lib/waitlist/postgres";
import type { WaitlistAdmissionBatch, WaitlistAdmissionSelection, WaitlistEntry, WaitlistRepository } from "@/lib/waitlist/types";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

const ACTOR = "operator-1";
const ENTRY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_ID = "approval-request-1";
const row = {
  id: ENTRY_ID, email: "person@example.test", name: "Saved Person",
  features: ["Deployments"], occupation: "Engineer", use_case: "Private projects",
  position: 7, status: "queued" as const, created_at: "2026-09-01T05:30:00+05:30",
  admitted_at: null, admitted_by: null,
};
const mapped: WaitlistEntry = {
  id: ENTRY_ID, email: "person@example.test", name: "Saved Person",
  features: ["Deployments"], occupation: "Engineer", useCase: "Private projects",
  position: 7, status: "queued", createdAt: "2026-09-01T00:00:00.000Z",
  admittedAt: null, admittedBy: null,
};
const admittedRow = {
  ...row, status: "admitted" as const,
  admitted_at: "2026-09-28T05:30:00+05:30", admitted_by: ACTOR,
};
const admittedEntry: WaitlistEntry = {
  ...mapped, status: "admitted",
  admittedAt: "2026-09-28T00:00:00.000Z", admittedBy: ACTOR,
};
const batch: WaitlistAdmissionBatch = {
  requestId: REQUEST_ID, actorId: ACTOR, requestedCount: 3, admittedCount: 1,
  createdAt: "2026-09-28T05:30:00+05:30", mode: "selected",
};
const mappedBatch = { ...batch, createdAt: "2026-09-28T00:00:00.000Z" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createAdminClient.mockReturnValue({ rpc: mocks.rpc });
});

describe("PostgreSQL admin waitlist adapter", () => {
  it("constructs the admin client lazily and reuses it across RPCs", async () => {
    const repository = postgresWaitlistRepository();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: { batches: [] }, error: null });
    await repository.history({ limit: 10 });
    await repository.history({ limit: 20 });
    expect(mocks.createAdminClient).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("routes literal search, status and cursor without deriving matched or global totals from the page", async () => {
    const legacyRow = {
      id: SECOND_ID, email: "legacy@example.test", occupation: "", use_case: "",
      position: 9, status: "admitted", created_at: "2026-08-31T20:00:00-04:00",
      admitted_at: "2026-09-27T20:00:00-04:00", admitted_by: ACTOR,
    };
    mocks.rpc.mockResolvedValue({ data: {
      entries: [row, legacyRow], total: 400, queued: 350, admitted: 50, matched: 17, nextCursor: 9,
    }, error: null });

    const result = await postgresWaitlistRepository().list({
      status: "queued", after: 6, limit: 2, q: "  Dev_100%+team@example.test  ",
    });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_list_filtered", {
      p_status: "queued", p_after: 6, p_limit: 2, p_query: "Dev_100%+team@example.test",
    });
    expect(result).toEqual({
      entries: [mapped, {
        id: SECOND_ID, email: "legacy@example.test", name: "", features: [],
        occupation: "", useCase: "", position: 9, status: "admitted",
        createdAt: "2026-09-01T00:00:00.000Z", admittedAt: "2026-09-28T00:00:00.000Z", admittedBy: ACTOR,
      }],
      total: 400, queued: 350, admitted: 50, matched: 17, nextCursor: 9,
    });
  });

  it("uses list defaults when runtime options omit optional schema values", async () => {
    mocks.rpc.mockResolvedValue({ data: {
      entries: [], total: 0, queued: 0, admitted: 0, matched: 0, nextCursor: null,
    }, error: null });
    // The parser accepts an omitted limit even though internal callers supply it.
    await postgresWaitlistRepository().list({} as Parameters<WaitlistRepository["list"]>[0]);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_list_filtered", {
      p_status: null, p_after: 0, p_limit: 100, p_query: "",
    });
  });

  it.each([1, 200])("forwards the valid list limit boundary %s", async (limit) => {
    mocks.rpc.mockResolvedValue({ data: {
      entries: [], total: 0, queued: 0, admitted: 0, matched: 0, nextCursor: null,
    }, error: null });
    await postgresWaitlistRepository().list({ limit });
    expect(mocks.rpc).toHaveBeenCalledWith("zenith_waitlist_list_filtered", expect.objectContaining({ p_limit: limit }));
  });

  it.each([0, 201, 1.5])("rejects list limit %s before constructing the client", async (limit) => {
    await expect(postgresWaitlistRepository().list({ limit })).rejects.toThrow();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  const selections: { selection: WaitlistAdmissionSelection; count: number | null; ids: string[] | null }[] = [
    { selection: { mode: "selected", entryIds: [SECOND_ID.toUpperCase(), ENTRY_ID.toUpperCase()] }, count: null, ids: [SECOND_ID, ENTRY_ID] },
    { selection: { mode: "next", count: 250 }, count: 250, ids: null },
    { selection: { mode: "all" }, count: null, ids: null },
  ];
  it.each(selections)("routes $selection.mode previews and maps their object payload", async ({ selection, count, ids }) => {
    mocks.rpc.mockResolvedValue({ data: {
      id: PREVIEW_ID, mode: selection.mode, count: 250, entries: [row],
      createdAt: "2026-09-28T05:30:00+05:30", expiresAt: "2026-09-28T05:45:00+05:30",
    }, error: null });

    const result = await postgresWaitlistRepository().preview(selection, ACTOR);

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_preview", {
      p_mode: selection.mode, p_actor_id: ACTOR, p_count: count, p_entry_ids: ids,
    });
    expect(result).toEqual({
      id: PREVIEW_ID, mode: selection.mode, count: 250, entries: [mapped],
      createdAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-09-28T00:15:00.000Z",
    });
  });

  it("preserves an empty saved preview", async () => {
    mocks.rpc.mockResolvedValue({ data: {
      id: PREVIEW_ID, mode: "all", count: 0, entries: [],
      createdAt: "2026-09-28T00:00:00Z", expiresAt: "2026-09-28T00:15:00Z",
    }, error: null });
    expect(await postgresWaitlistRepository().preview({ mode: "all" }, ACTOR))
      .toMatchObject({ id: PREVIEW_ID, count: 0, entries: [] });
  });

  it("rejects a duplicate selection after canonicalizing UUID case, without issuing an RPC", async () => {
    await expect(postgresWaitlistRepository().preview({
      mode: "selected", entryIds: [ENTRY_ID, ENTRY_ID.toUpperCase()],
    }, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  const admissions = [
    {
      name: "preview confirmation", rpc: "zenith_waitlist_admit_preview",
      invoke: (repository: WaitlistRepository) => repository.admitPreview(PREVIEW_ID.toUpperCase(), ACTOR, REQUEST_ID),
      parameters: { p_preview_id: PREVIEW_ID, p_actor_id: ACTOR, p_request_id: REQUEST_ID },
      data: { count: 250000, requestId: REQUEST_ID }, expected: { count: 250000, requestId: REQUEST_ID },
    },
    {
      name: "legacy FIFO admission", rpc: "zenith_waitlist_admit",
      invoke: (repository: WaitlistRepository) => repository.admit(3, ACTOR, REQUEST_ID),
      parameters: { p_count: 3, p_actor_id: ACTOR, p_request_id: REQUEST_ID },
      data: [admittedRow], expected: [admittedEntry],
    },
  ];
  it.each(admissions)("routes $name and returns its expected payload shape", async ({ invoke, rpc, parameters, data, expected }) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect(await invoke(postgresWaitlistRepository())).toEqual(expected);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(rpc, parameters);
  });

  it.each([0, 250000])("keeps repeated preview confirmation responses compact for an RPC count of %s", async (count) => {
    const summary = { count, requestId: REQUEST_ID };
    mocks.rpc.mockResolvedValue({ data: summary, error: null });
    const repository = postgresWaitlistRepository();
    expect(await repository.admitPreview(PREVIEW_ID, ACTOR, REQUEST_ID)).toEqual(summary);
    expect(await repository.admitPreview(PREVIEW_ID, ACTOR, REQUEST_ID)).toEqual(summary);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    for (const call of mocks.rpc.mock.calls) {
      expect(call).toEqual(["zenith_waitlist_admit_preview", {
        p_preview_id: PREVIEW_ID, p_actor_id: ACTOR, p_request_id: REQUEST_ID,
      }]);
    }
  });

  it.each(admissions)("returns safe request-conflict errors for $name", async ({ invoke }) => {
    mocks.rpc.mockResolvedValue({ data: null, error: {
      code: "ZW409", message: "Conflict involving private@example.test", details: "sensitive record",
    } });
    const failure = await invoke(postgresWaitlistRepository()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(WaitlistPreviewExpiredError);
    expect(failure).toMatchObject({ status: 409, message: "This approval request conflicts with an earlier action or an unavailable preview. Refresh the queue and review a new approval." });
    expect(String(failure)).not.toContain("private@example.test");
  });

  it("distinguishes an expired preview from an admission conflict", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "ZW410", message: "private database detail" } });
    const failure = await postgresWaitlistRepository().admitPreview(PREVIEW_ID, ACTOR, REQUEST_ID)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WaitlistPreviewExpiredError);
    expect(failure).toMatchObject({
      status: 409, code: "preview_expired",
      message: "This approval preview expired. Review a new preview before approving.",
    });
  });

  it.each(["22023", "22001", "22P02", "23502", "23514"])("sanitizes PostgreSQL input error %s", async (code) => {
    mocks.rpc.mockResolvedValue({ data: null, error: {
      code, message: "Invalid private@example.test", details: "private profile",
    } });
    await expect(postgresWaitlistRepository().preview({ mode: "all" }, ACTOR))
      .rejects.toMatchObject({ status: 400, message: "Invalid waitlist input." });
  });

  it("sanitizes unexpected database failures", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: {
      code: "42501", message: "Denied private@example.test", details: "database internals",
    } });
    await expect(postgresWaitlistRepository().history({ limit: 50 })).rejects.toMatchObject({
      status: 500, message: "Waitlist storage is unavailable. Please try again.",
    });
  });

  it("maps history dates while preserving compact saved batch metadata", async () => {
    mocks.rpc.mockResolvedValue({ data: { batches: [batch] }, error: null });
    expect(await postgresWaitlistRepository().history({ limit: 12 })).toEqual({ batches: [mappedBatch] });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history", { p_limit: 12 });
  });

  it("defaults an omitted history limit to 50", async () => {
    mocks.rpc.mockResolvedValue({ data: { batches: [] }, error: null });
    await postgresWaitlistRepository().history({} as Parameters<WaitlistRepository["history"]>[0]);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history", { p_limit: 50 });
  });

  it.each([1, 100])("forwards the valid history limit boundary %s", async (limit) => {
    mocks.rpc.mockResolvedValue({ data: { batches: [] }, error: null });
    await postgresWaitlistRepository().history({ limit });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history", { p_limit: limit });
  });

  it.each([0, 101, 1.5])("rejects history limit %s before constructing the client", async (limit) => {
    await expect(postgresWaitlistRepository().history({ limit })).rejects.toMatchObject({ status: 400 });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { options: undefined, offset: 0, limit: 100 },
    { options: {}, offset: 0, limit: 100 },
    { options: { offset: 100 }, offset: 100, limit: 100 },
    { options: { limit: 1 }, offset: 0, limit: 1 },
  ])("forwards detail pagination defaults for $options", async ({ options, offset, limit }) => {
    mocks.rpc.mockResolvedValue({ data: { batch, entries: [], nextOffset: null }, error: null });
    expect(await postgresWaitlistRepository().historyDetail(REQUEST_ID, options)).toEqual({
      batch: mappedBatch, entries: [], nextOffset: null,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history_detail", {
      p_request_id: REQUEST_ID, p_offset: offset, p_limit: limit,
    });
  });

  it("maps a saved history page and preserves its RPC continuation offset", async () => {
    const savedRows = [
      { ...admittedRow, id: ENTRY_ID, name: "Saved person 101", position: 101 },
      { ...admittedRow, id: SECOND_ID, name: "Saved person 102", position: 102 },
    ];
    const savedBatch = { ...batch, requestedCount: 210, admittedCount: 205, mode: "all" };
    mocks.rpc.mockResolvedValue({ data: { batch: savedBatch, entries: savedRows, nextOffset: 102 }, error: null });

    const result = await postgresWaitlistRepository().historyDetail(REQUEST_ID, { offset: 100, limit: 2 });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history_detail", {
      p_request_id: REQUEST_ID, p_offset: 100, p_limit: 2,
    });
    expect(result).toEqual({
      batch: { ...savedBatch, createdAt: mappedBatch.createdAt },
      entries: [
        { ...admittedEntry, id: ENTRY_ID, name: "Saved person 101", position: 101 },
        { ...admittedEntry, id: SECOND_ID, name: "Saved person 102", position: 102 },
      ],
      nextOffset: 102,
    });
  });

  it("preserves the final page and terminal offset with the maximum detail limit", async () => {
    mocks.rpc.mockResolvedValue({ data: {
      batch: { ...batch, requestedCount: 210, admittedCount: 201 },
      entries: [{ ...admittedRow, position: 201 }], nextOffset: null,
    }, error: null });
    const result = await postgresWaitlistRepository().historyDetail(REQUEST_ID, { offset: 200, limit: 100 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history_detail", {
      p_request_id: REQUEST_ID, p_offset: 200, p_limit: 100,
    });
    expect(result.entries).toEqual([{ ...admittedEntry, position: 201 }]);
    expect(result.nextOffset).toBeNull();
    expect(result.batch.admittedCount).toBe(201);
  });

  it.each([
    { offset: -1 }, { offset: 0.5 },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 },
  ])("rejects invalid history detail pagination %j before opening storage", async (options) => {
    await expect(postgresWaitlistRepository().historyDetail(REQUEST_ID, options))
      .rejects.toMatchObject({ status: 400 });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 when no saved batch matches the request ID", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(postgresWaitlistRepository().historyDetail(REQUEST_ID))
      .rejects.toMatchObject({ status: 404, message: "This approval batch was not found." });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("zenith_waitlist_history_detail", {
      p_request_id: REQUEST_ID, p_offset: 0, p_limit: 100,
    });
  });

  it.each([" ", "x".repeat(129)])("rejects invalid history request IDs before opening storage", async (requestId) => {
    await expect(postgresWaitlistRepository().historyDetail(requestId)).rejects.toMatchObject({ status: 400 });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
