import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileWaitlistRepository } from "@/lib/waitlist/file";
import type { WaitlistAdmissionSelection, WaitlistEntry } from "@/lib/waitlist/types";

const tempRoot = realpathSync(tmpdir());
const prefix = "zenith-waitlist-admin-";
const initialTime = Date.parse("2026-09-28T10:00:00.000Z");
let directory: string;
let file: string;
let now: number;
let repository: FileWaitlistRepository;
const connections = new Set<{ close(): void }>();

function openRepository(): FileWaitlistRepository {
  const connection = new FileWaitlistRepository(file, () => now);
  connections.add(connection);
  return connection;
}

function close(connection: { close(): void }): void {
  connection.close();
  connections.delete(connection);
}

function inspectDatabase(): DatabaseSync {
  const connection = new DatabaseSync(file);
  connections.add(connection);
  return connection;
}

async function seed(count: number): Promise<WaitlistEntry[]> {
  for (let index = 1; index <= count; index++) {
    await repository.join({ email: `person-${index}@example.test`, name: `Person ${index}` });
  }
  const entries: WaitlistEntry[] = [];
  let after = 0;
  do {
    const page = await repository.list({ limit: 200, after });
    entries.push(...page.entries);
    if (page.nextCursor === null) return entries;
    after = page.nextCursor;
  } while (true);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tempRoot, prefix));
  file = path.join(directory, "waitlist.sqlite");
  now = initialTime;
  repository = openRepository();
});

afterEach(() => {
  for (const connection of connections) close(connection);
  const resolved = realpathSync(directory);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error("Refusing to remove an unexpected waitlist test directory.");
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("file waitlist admission previews", () => {
  it("captures only the selected queued people in FIFO order without changing admission", async () => {
    const entries = await seed(5);
    await repository.admit(1, "previous-operator", "previous-admission");
    const before = await repository.list({ limit: 200 });
    const preview = await repository.preview({
      mode: "selected", entryIds: [entries[4].id, entries[0].id, entries[2].id],
    }, "operator");

    expect(preview).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), mode: "selected", count: 2,
      entries: [entries[2], entries[4]], createdAt: new Date(initialTime).toISOString(),
      expiresAt: new Date(initialTime + 86_400_000).toISOString(),
    });
    expect(await repository.list({ limit: 200 })).toEqual(before);
    expect((await repository.history({ limit: 50 })).batches).toHaveLength(1);
    expect(await repository.admitPreview(preview.id, "operator", "selected-admission"))
      .toEqual({ count: 2, requestId: "selected-admission" });
    expect((await repository.historyDetail("selected-admission")).entries.map((entry) => entry.position)).toEqual([3, 5]);
    expect((await repository.list({ status: "queued", limit: 200 })).entries.map((entry) => entry.position)).toEqual([2, 4]);
  });

  it("captures the next queued people after prior admissions", async () => {
    const entries = await seed(5);
    await repository.admit(1, "operator", "first-person");
    const preview = await repository.preview({ mode: "next", count: 2 }, "operator");
    expect(preview).toMatchObject({ mode: "next", count: 2, entries: [entries[1], entries[2]] });
    await repository.join({ email: "late@example.test" });
    expect(await repository.admitPreview(preview.id, "operator", "next-two")).toEqual({ count: 2, requestId: "next-two" });
    expect((await repository.historyDetail("next-two")).entries.map((entry) => entry.position)).toEqual([2, 3]);
    expect((await repository.list({ status: "queued", limit: 200 })).entries.map((entry) => entry.position)).toEqual([4, 5, 6]);
  });

  it("persists an all-queue snapshot larger than 1000 with compact confirmation and complete paginated history", async () => {
    const entries = await seed(1005);
    const preview = await repository.preview({ mode: "all" }, "operator");
    expect(preview).toMatchObject({ mode: "all", count: 1005, entries: entries.slice(0, 100) });
    close(repository);
    repository = openRepository();
    await repository.join({ email: "after-preview@example.test" });
    expect(await repository.admitPreview(preview.id, "operator", "all-snapshot"))
      .toEqual({ count: 1005, requestId: "all-snapshot" });
    expect((await repository.list({ status: "queued", limit: 200 })).entries).toMatchObject([
      { email: "after-preview@example.test", position: 1006 },
    ]);
    const metadata = {
      requestId: "all-snapshot", actorId: "operator", requestedCount: 1005, admittedCount: 1005,
      createdAt: new Date(initialTime).toISOString(), mode: "all",
    };
    expect(await repository.history({ limit: 50 })).toEqual({ batches: [metadata] });
    const first = await repository.historyDetail("all-snapshot");
    expect(first.batch).toEqual(metadata);
    expect(first.entries).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    const saved = [...first.entries];
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await repository.historyDetail("all-snapshot", { offset, limit: 100 });
      expect(page.batch).toEqual(metadata);
      expect(page.entries.length).toBeLessThanOrEqual(100);
      expect(page.nextOffset).toBe(offset + page.entries.length < 1005 ? offset + page.entries.length : null);
      saved.push(...page.entries);
      offset = page.nextOffset;
    }
    expect(saved.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(saved.every((entry) => entry.status === "admitted" && entry.admittedBy === "operator")).toBe(true);
    expect(await repository.historyDetail("all-snapshot", { offset: 1005, limit: 100 }))
      .toEqual({ batch: metadata, entries: [], nextOffset: null });
    now += 2 * 86_400_000;
    expect(await repository.admitPreview(preview.id, "operator", "all-snapshot"))
      .toEqual({ count: 1005, requestId: "all-snapshot" });
    expect(await repository.list({ limit: 1 })).toMatchObject({ admitted: 1005, queued: 1 });
  });

  it("replays exact committed results after a restart and expiry without expanding the snapshot", async () => {
    await seed(3);
    const preview = await repository.preview({ mode: "next", count: 2 }, "operator");
    now += 60_000;
    const admitted = await repository.admitPreview(preview.id, "operator", "retry-preview");
    expect(admitted).toEqual({ count: 2, requestId: "retry-preview" });
    const originalAudit = await repository.historyDetail("retry-preview");
    close(repository);
    now = initialTime + 2 * 86_400_000;
    repository = openRepository();
    await repository.join({ email: "later@example.test" });
    expect(await repository.admitPreview(preview.id, "operator", "retry-preview")).toEqual(admitted);
    expect(await repository.historyDetail("retry-preview")).toEqual(originalAudit);
    expect(await repository.list({ limit: 200 })).toMatchObject({ total: 4, admitted: 2, queued: 2 });
    expect((await repository.history({ limit: 50 })).batches).toHaveLength(1);
    await expect(repository.admitPreview(preview.id, "different-operator", "retry-preview"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("expires unused previews at the exact 24-hour boundary without recording a batch", async () => {
    await seed(3);
    const beforeBoundary = await repository.preview({ mode: "next", count: 1 }, "operator");
    const expired = await repository.preview({ mode: "all" }, "operator");
    now = initialTime + 86_400_000 - 1;
    expect(await repository.admitPreview(beforeBoundary.id, "operator", "before-expiry"))
      .toEqual({ count: 1, requestId: "before-expiry" });
    now += 1;
    await expect(repository.admitPreview(expired.id, "operator", "expired-request"))
      .rejects.toMatchObject({ status: 409, code: "preview_expired" });
    expect(await repository.list({ limit: 200 })).toMatchObject({ total: 3, admitted: 1, queued: 2 });
    expect((await repository.history({ limit: 50 })).batches.map((batch) => batch.requestId)).toEqual(["before-expiry"]);
  });

  it("applies overlapping snapshots only once and audits only newly admitted IDs", async () => {
    const entries = await seed(5);
    const selected = await repository.preview({ mode: "selected", entryIds: entries.slice(0, 3).map((entry) => entry.id) }, "first-operator");
    const next = await repository.preview({ mode: "next", count: 4 }, "second-operator");
    const other = openRepository();
    now += 1_000;
    const first = await repository.admitPreview(selected.id, "first-operator", "first-overlap");
    now += 1_000;
    const second = await other.admitPreview(next.id, "second-operator", "second-overlap");
    expect(first).toEqual({ count: 3, requestId: "first-overlap" });
    expect(second).toEqual({ count: 1, requestId: "second-overlap" });
    const firstAudit = await repository.historyDetail("first-overlap");
    const secondAudit = await repository.historyDetail("second-overlap");
    expect(firstAudit.entries.map((entry) => entry.id)).toEqual(entries.slice(0, 3).map((entry) => entry.id));
    expect(secondAudit.entries.map((entry) => entry.id)).toEqual([entries[3].id]);
    expect((await repository.list({ limit: 200 })).entries.slice(0, 3)).toEqual(firstAudit.entries);
    expect(await repository.history({ limit: 50 })).toEqual({ batches: [
      {
        requestId: "second-overlap", actorId: "second-operator", requestedCount: 4, admittedCount: 1,
        createdAt: new Date(now).toISOString(), mode: "next",
      },
      {
        requestId: "first-overlap", actorId: "first-operator", requestedCount: 3, admittedCount: 3,
        createdAt: new Date(now - 1_000).toISOString(), mode: "selected",
      },
    ] });
    expect((await repository.history({ limit: 1 })).batches.map((batch) => batch.requestId)).toEqual(["second-overlap"]);
  });

  it("preserves legacy FIFO audit counts and orders batches committed at the same timestamp", async () => {
    await seed(2);
    const admitted = await repository.admit(5, "legacy-operator", "legacy-batch");
    await repository.admit(1000, "legacy-operator", "empty-legacy-batch");
    const expected = { batches: [
      {
        requestId: "empty-legacy-batch", actorId: "legacy-operator", requestedCount: 1000, admittedCount: 0,
        createdAt: new Date(initialTime).toISOString(), mode: "next",
      },
      {
        requestId: "legacy-batch", actorId: "legacy-operator", requestedCount: 5, admittedCount: 2,
        createdAt: new Date(initialTime).toISOString(), mode: "next",
      },
    ] };
    expect(await repository.history({ limit: 50 })).toEqual(expected);
    close(repository);
    now += 60_000;
    repository = openRepository();
    expect(await repository.admit(5, "legacy-operator", "legacy-batch")).toEqual(admitted);
    expect(await repository.history({ limit: 50 })).toEqual(expected);
  });
  it("reads admission history details from the committed snapshot after later profile edits and a restart", async () => {
    const entries = await seed(3);
    const preview = await repository.preview({ mode: "next", count: 2 }, "operator");
    now += 1_000;
    expect(await repository.admitPreview(preview.id, "operator", "saved-detail"))
      .toEqual({ count: 2, requestId: "saved-detail" });
    const admitted = entries.slice(0, 2).map((entry) => ({
      ...entry, status: "admitted", admittedAt: new Date(now).toISOString(), admittedBy: "operator",
    }));
    const expected = {
      batch: {
        requestId: "saved-detail", actorId: "operator", requestedCount: 2, admittedCount: 2,
        createdAt: new Date(now).toISOString(), mode: "next",
      },
      entries: admitted, nextOffset: null,
    };
    expect(await repository.historyDetail("saved-detail")).toEqual(expected);
    expect(await repository.historyDetail("saved-detail", { offset: 0, limit: 1 }))
      .toEqual({ batch: expected.batch, entries: admitted.slice(0, 1), nextOffset: 1 });
    expect(await repository.historyDetail("saved-detail", { offset: 1, limit: 1 }))
      .toEqual({ batch: expected.batch, entries: admitted.slice(1), nextOffset: null });
    const inspector = inspectDatabase();
    inspector.prepare("UPDATE waitlist_entries SET name=?,features_json=?,use_case=?,admitted_by=? WHERE id=?")
      .run("Changed after approval", JSON.stringify(["New feature"]), "Updated profile", "later-operator", entries[0].id);
    close(inspector);
    close(repository);
    repository = openRepository();
    expect((await repository.list({ limit: 200 })).entries[0]).toMatchObject({ name: "Changed after approval" });
    expect(await repository.historyDetail("saved-detail")).toEqual(expected);
  });

  it("returns 404 for an absent admission history batch and rejects invalid identifiers", async () => {
    await expect(repository.historyDetail(randomUUID())).rejects.toMatchObject({ status: 404 });
    for (const requestId of ["", " ", "r".repeat(129)]) {
      await expect(repository.historyDetail(requestId)).rejects.toMatchObject({ status: 400 });
    }
  });
  it("rejects actor changes, reused previews and request IDs shared across admission modes", async () => {
    await seed(3);
    const preview = await repository.preview({ mode: "next", count: 1 }, "operator");
    const another = await repository.preview({ mode: "next", count: 1 }, "operator");
    await expect(repository.admitPreview(preview.id, "other", "wrong-owner")).rejects.toMatchObject({ status: 409 });
    const admitted = await repository.admitPreview(preview.id, "operator", "preview-request");
    await expect(repository.admitPreview(preview.id, "operator", "new-request")).rejects.toMatchObject({ status: 409 });
    await expect(repository.admitPreview(another.id, "operator", "preview-request")).rejects.toMatchObject({ status: 409 });
    await expect(repository.admit(1, "operator", "preview-request")).rejects.toMatchObject({ status: 409 });
    await repository.admit(1, "operator", "legacy-request");
    await expect(repository.admitPreview(another.id, "operator", "legacy-request")).rejects.toMatchObject({ status: 409 });
    expect(await repository.admitPreview(preview.id, "operator", "preview-request")).toEqual(admitted);
    expect(await repository.list({ limit: 200 })).toMatchObject({ queued: 1, admitted: 2 });
    expect((await repository.history({ limit: 50 })).batches).toHaveLength(2);
  });

  it("persists empty previews and empty overlapping batches so retries cannot admit later arrivals", async () => {
    const empty = await repository.preview({ mode: "all" }, "operator");
    expect(empty).toMatchObject({ count: 0, entries: [] });
    await seed(1);
    expect(await repository.admitPreview(empty.id, "operator", "empty-snapshot"))
      .toEqual({ count: 0, requestId: "empty-snapshot" });
    const overlapping = await repository.preview({ mode: "all" }, "operator");
    await repository.admit(1, "operator", "prior-admission");
    expect(await repository.admitPreview(overlapping.id, "operator", "empty-overlap"))
      .toEqual({ count: 0, requestId: "empty-overlap" });
    close(repository);
    repository = openRepository();
    await repository.join({ email: "later@example.test" });
    expect(await repository.admitPreview(empty.id, "operator", "empty-snapshot"))
      .toEqual({ count: 0, requestId: "empty-snapshot" });
    expect(await repository.admitPreview(overlapping.id, "operator", "empty-overlap"))
      .toEqual({ count: 0, requestId: "empty-overlap" });
    expect(await repository.list({ limit: 200 })).toMatchObject({ admitted: 1, queued: 1 });
    const history = (await repository.history({ limit: 50 })).batches;
    expect(history.find((batch) => batch.requestId === "empty-snapshot")).toMatchObject({ requestedCount: 0, admittedCount: 0 });
    expect(history.find((batch) => batch.requestId === "empty-overlap")).toMatchObject({ requestedCount: 1, admittedCount: 0 });
    expect(await repository.historyDetail("empty-overlap")).toMatchObject({ entries: [], nextOffset: null });
  });

  it.each([
    ["batch persistence", "BEFORE INSERT ON waitlist_batches"],
    ["a later entry update", "BEFORE UPDATE ON waitlist_entries WHEN OLD.position=2"],
  ])("rolls back preview consumption, all entries and history when %s fails", async (_label, trigger) => {
    await seed(3);
    const preview = await repository.preview({ mode: "all" }, "operator");
    const before = await repository.list({ limit: 200 });
    const inspector = inspectDatabase();
    inspector.exec(`CREATE TRIGGER reject_preview_admission ${trigger} BEGIN SELECT RAISE(ABORT, 'simulated preview failure'); END;`);
    await expect(repository.admitPreview(preview.id, "operator", "retry-after-rollback")).rejects.toThrow("simulated preview failure");
    expect(await repository.list({ limit: 200 })).toEqual(before);
    expect(await repository.history({ limit: 50 })).toEqual({ batches: [] });
    inspector.exec("DROP TRIGGER reject_preview_admission");
    close(inspector);
    close(repository);
    repository = openRepository();
    expect(await repository.admitPreview(preview.id, "operator", "retry-after-rollback"))
      .toEqual({ count: 3, requestId: "retry-after-rollback" });
    expect((await repository.historyDetail("retry-after-rollback")).entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect((await repository.history({ limit: 50 })).batches).toHaveLength(1);
  });

  it("rejects an absent selected ID without producing a partial snapshot", async () => {
    const entries = await seed(2);
    await expect(repository.preview({ mode: "selected", entryIds: [entries[0].id, randomUUID()] }, "operator"))
      .rejects.toMatchObject({ status: 400 });
    expect(await repository.list({ limit: 200 })).toMatchObject({ admitted: 0, queued: 2 });
    expect(await repository.history({ limit: 50 })).toEqual({ batches: [] });
  });

  it.each([
    { mode: "selected", entryIds: [] },
    { mode: "selected", entryIds: ["not-a-uuid"] },
    { mode: "selected", entryIds: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"] },
    { mode: "selected", entryIds: Array.from({ length: 1001 }, () => randomUUID()) },
    { mode: "next", count: 0 },
    { mode: "next", count: 1001 },
    { mode: "next", count: 1.5 },
    { mode: "all", count: 1 },
  ])("rejects invalid preview selection case %# before writing an admission", async (selection) => {
    await expect(repository.preview(selection as WaitlistAdmissionSelection, "operator")).rejects.toThrow();
    expect(await repository.history({ limit: 50 })).toEqual({ batches: [] });
  });

  it.each([
    { offset: -1 }, { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 },
  ])("rejects invalid history detail pagination %j", async (options) => {
    await expect(repository.historyDetail("some-request", options)).rejects.toMatchObject({ status: 400 });
  });

  it.each([0, 101, 1.5, Number.NaN])("rejects an invalid history limit %s", async (limit) => {
    await expect(repository.history({ limit })).rejects.toThrow();
  });
});

describe("file waitlist operator search", () => {
  beforeEach(async () => {
    await repository.join({ email: "first@example.test", name: "Alice 100% Ready", occupation: "Engineer", features: ["Containers", "Team workflows", 'API "v2"', "C:\\Feature\\Tools"], useCase: "Path C:\\private\\app" });
    await repository.join({ email: "second@example.test", name: "ALICIA", occupation: "Ops_Lead", useCase: "O'Reilly docs" });
    await repository.join({ email: "third@example.test", name: "Bob", occupation: "Engineer", features: ["Autoscaling"], useCase: "ALICE and automation" });
    await repository.join({ email: "fourth@example.test", name: "Percent 100x", occupation: "OpsXLead", useCase: "Path C:xprivateyapp" });
    await repository.join({ email: "fifth@example.test", name: "Carol" });
    await repository.admit(1, "operator", "search-baseline");
  });

  it("matches profile fields case-insensitively and keeps filtered totals independent of pagination", async () => {
    const first = await repository.list({ q: "ALI", limit: 1 });
    expect(first).toMatchObject({ total: 5, admitted: 1, queued: 4, matched: 3, nextCursor: 1 });
    expect(first.entries.map((entry) => entry.position)).toEqual([1]);
    const tail = await repository.list({ q: "ali", status: "queued", after: 2, limit: 1 });
    expect(tail).toMatchObject({ total: 5, admitted: 1, queued: 4, matched: 2, nextCursor: null });
    expect(tail.entries.map((entry) => entry.position)).toEqual([3]);
    expect(await repository.list({ q: "ali", after: 99, limit: 1 })).toMatchObject({ entries: [], matched: 3, nextCursor: null });
    expect(await repository.list({ q: "ali", status: "admitted", limit: 1 })).toMatchObject({ matched: 1 });
  });

  it.each([
    ["%", [1]], ["_", [2]], ["\\", [1]], ["o'reilly", [2]], ["AUTOSCALING", [3]],
    ["team workflows", [1]], ['API "v2"', [1]], ["C:\\Feature\\Tools", [1]],
    ["EXAMPLE.TEST", [1, 2, 3, 4, 5]], ["' OR 1=1 --", []], ["test Alice", []],
  ])("treats %j as a literal substring across profile fields", async (q, positions) => {
    const page = await repository.list({ q: q as string, limit: 200 });
    expect(page.entries.map((entry) => entry.position)).toEqual(positions);
    expect(page.matched).toBe(positions.length);
  });
});
