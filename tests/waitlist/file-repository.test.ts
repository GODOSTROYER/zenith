import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileWaitlistRepository } from "@/lib/waitlist/file";

const tempRoot = realpathSync(tmpdir());
const prefix = "zenith-waitlist-file-";
const initialTime = Date.parse("2026-09-26T10:00:00.000Z");
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

async function seed(count: number, target = repository): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await target.join({ email: `person-${index}@example.test`, occupation: `Role ${index}`, useCase: `Use case ${index}` });
  }
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tempRoot, prefix));
  file = path.join(directory, "waitlist.sqlite");
  now = initialTime;
  repository = openRepository();
});

afterEach(() => {
  for (const connection of connections) close(connection);
  // Delete only the direct temporary child this test created, including WAL files.
  const resolved = realpathSync(directory);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error("Refusing to remove an unexpected waitlist test directory.");
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("file waitlist repository", () => {
  it("persists answers, identity, order and admission across a closed database", async () => {
    await seed(3);
    now += 60_000;
    const admitted = await repository.admit(1, "admin-1", "first-batch");
    const before = await repository.list({ limit: 100 });
    expect(before).toMatchObject({ total: 3, queued: 2, admitted: 1, nextCursor: null });
    expect(admitted[0]).toMatchObject({
      email: "person-1@example.test", occupation: "Role 1", useCase: "Use case 1", position: 1,
      createdAt: new Date(initialTime).toISOString(), status: "admitted", admittedBy: "admin-1",
      admittedAt: new Date(now).toISOString(),
    });
    expect(before.entries[1]).toMatchObject({ status: "queued", admittedAt: null, admittedBy: null });
    expect(new Set(before.entries.map((entry) => entry.id)).size).toBe(3);
    close(repository);

    repository = openRepository();
    expect(await repository.list({ limit: 100 })).toEqual(before);
    expect(await repository.admitted(" PERSON-1@EXAMPLE.TEST ")).toBe(true);
    expect(await repository.admitted("person-2@example.test")).toBe(false);
    expect(await repository.admitted("absent@example.test")).toBe(false);
  });

  it("keeps the original answers, queue position and admission on normalized duplicate joins", async () => {
    await repository.join({ email: " FIRST@EXAMPLE.TEST ", occupation: " Engineer ", useCase: " Deploy services " });
    await repository.join({ email: "second@example.test", occupation: "Designer", useCase: "Preview apps" });
    const original = (await repository.list({ limit: 100 })).entries[0];
    expect(original).toMatchObject({ email: "first@example.test", occupation: "Engineer", useCase: "Deploy services" });
    now += 60_000;
    const replacement = { email: " First@Example.Test ", occupation: "Replacement", useCase: "Replacement answer" };
    await repository.join(replacement);
    expect((await repository.list({ limit: 100 })).entries).toEqual([
      original,
      expect.objectContaining({ email: "second@example.test", position: 2 }),
    ]);
    const admitted = await repository.admit(1, "admin-1", "duplicate-batch");
    await repository.join(replacement);
    close(repository);

    repository = openRepository();
    const page = await repository.list({ limit: 100 });
    expect(page).toMatchObject({ total: 2, queued: 1, admitted: 1 });
    expect(page.entries[0]).toEqual(admitted[0]);
    expect(await repository.admitted("first@example.test")).toBe(true);
  });

  it("admits the first 100 in FIFO order, then only the remaining queued entries", async () => {
    await seed(105);
    const first = await repository.admit(100, "admin-1", "first-100");
    expect(first.map((entry) => entry.position)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(first.every((entry) => entry.status === "admitted" && entry.admittedBy === "admin-1")).toBe(true);
    expect(await repository.list({ status: "queued", limit: 100 })).toMatchObject({
      total: 105, queued: 5, admitted: 100, nextCursor: null,
      entries: Array.from({ length: 5 }, (_, index) => expect.objectContaining({ position: index + 101 })),
    });
    const remaining = await repository.admit(100, "admin-2", "remaining");
    expect(remaining.map((entry) => entry.position)).toEqual([101, 102, 103, 104, 105]);
    expect(remaining.every((entry) => entry.admittedBy === "admin-2")).toBe(true);
    expect(await repository.admit(100, "admin-2", "empty")).toEqual([]);
    expect(await repository.list({ limit: 1 })).toMatchObject({ total: 105, queued: 0, admitted: 105 });
  });

  it("uses exclusive keyset pages and global counts for both status filters", async () => {
    await seed(7);
    await repository.admit(3, "admin", "first-three");
    const first = await repository.list({ limit: 2 });
    expect(first.entries.map((entry) => entry.position)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    const second = await repository.list({ after: first.nextCursor!, limit: 2 });
    expect(second.entries.map((entry) => entry.position)).toEqual([3, 4]);
    expect(second.nextCursor).toBe(4);
    const queued = await repository.list({ status: "queued", after: 2, limit: 2 });
    expect(queued.entries.map((entry) => entry.position)).toEqual([4, 5]);
    expect(queued.nextCursor).toBe(5);
    const queuedTail = await repository.list({ status: "queued", after: queued.nextCursor!, limit: 2 });
    expect(queuedTail.entries.map((entry) => entry.position)).toEqual([6, 7]);
    expect(queuedTail.nextCursor).toBeNull();
    const admitted = await repository.list({ status: "admitted", after: 1, limit: 2 });
    expect(admitted.entries.map((entry) => entry.position)).toEqual([2, 3]);
    expect(admitted.nextCursor).toBeNull();
    const empty = await repository.list({ after: 7, limit: 2 });
    expect(empty.entries).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    for (const page of [first, second, queued, queuedTail, admitted, empty]) {
      expect(page).toMatchObject({ total: 7, queued: 4, admitted: 3 });
    }
  });

  it("replays the exact persisted batch without admitting another person or changing timestamps", async () => {
    await seed(4);
    const first = await repository.admit(2, "admin-1", "retry-me");
    close(repository);
    now += 86_400_000;
    repository = openRepository();
    expect(await repository.admit(2, "admin-1", "retry-me")).toEqual(first);
    expect(await repository.list({ limit: 100 })).toMatchObject({ total: 4, queued: 2, admitted: 2 });
    await expect(repository.admit(2, "admin-2", "retry-me")).rejects.toMatchObject({ status: 409 });
    await expect(repository.admit(3, "admin-1", "retry-me")).rejects.toMatchObject({ status: 409 });
    expect((await repository.admit(2, "admin-2", "next-batch")).map((entry) => entry.position)).toEqual([3, 4]);
    expect(await repository.admit(2, "admin-1", "retry-me")).toEqual(first);
  });

  it("persists an empty batch so a retry cannot admit subsequent joins or change parameters", async () => {
    expect(await repository.admit(100, "admin-1", "empty-retry")).toEqual([]);
    close(repository);
    repository = openRepository();
    await seed(1);
    expect(await repository.admit(100, "admin-1", "empty-retry")).toEqual([]);
    await expect(repository.admit(100, "admin-2", "empty-retry")).rejects.toMatchObject({ status: 409 });
    await expect(repository.admit(1, "admin-1", "empty-retry")).rejects.toMatchObject({ status: 409 });
    expect(await repository.list({ limit: 100 })).toMatchObject({ total: 1, queued: 1, admitted: 0 });
    expect(await repository.admit(100, "admin-1", "fresh-request")).toHaveLength(1);
  });

  it.each([
    ["batch persistence", "BEFORE INSERT ON waitlist_batches"],
    ["a later entry update", "BEFORE UPDATE ON waitlist_entries WHEN OLD.position=2"],
  ])("rolls back every admission when %s fails, allowing a clean retry", async (_label, trigger) => {
    await seed(3);
    const before = await repository.list({ limit: 100 });
    const inspector = inspectDatabase();
    inspector.exec(`CREATE TRIGGER reject_admission ${trigger} BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;`);
    await expect(repository.admit(3, "admin", "failed-batch")).rejects.toThrow("simulated write failure");
    expect(await repository.list({ limit: 100 })).toEqual(before);
    expect(inspector.prepare("SELECT count(*) AS total FROM waitlist_batches").get()).toMatchObject({ total: 0 });
    inspector.exec("DROP TRIGGER reject_admission");
    close(inspector);
    close(repository);
    repository = openRepository();
    expect((await repository.admit(3, "admin", "failed-batch")).map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(await repository.list({ limit: 100 })).toMatchObject({ total: 3, queued: 0, admitted: 3 });
  });

  it("shares durable FIFO and idempotency state across two open connections", async () => {
    const other = openRepository();
    await seed(121);
    // Calls on DatabaseSync execute serially in this process; two independent
    // connections still exercise the shared transaction and retry records.
    const batches = await Promise.all([
      repository.admit(50, "admin-1", "parallel-one"),
      other.admit(50, "admin-2", "parallel-two"),
    ]);
    const positions = batches.flat().map((entry) => entry.position);
    expect(new Set(positions).size).toBe(100);
    expect(positions.toSorted((left, right) => left - right)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(await other.admit(50, "admin-1", "parallel-one")).toEqual(batches[0]);
    expect(await repository.admit(50, "admin-2", "parallel-two")).toEqual(batches[1]);
    expect(await other.list({ status: "queued", limit: 100 })).toMatchObject({
      total: 121, queued: 21, admitted: 100,
      entries: Array.from({ length: 21 }, (_, index) => expect.objectContaining({ position: index + 101 })),
    });
    const final = await other.admit(100, "admin-3", "final-batch");
    expect(final).toHaveLength(21);
    expect(await repository.list({ limit: 1 })).toMatchObject({ total: 121, queued: 0, admitted: 121 });
  });

  it("shares rate limits across connections and restarts, then resets at the window boundary", async () => {
    now = 120_000;
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(true);
    const other = openRepository();
    expect(await other.consumeRateLimit("join:ip-one", 2, 60)).toBe(true);
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(false);
    close(repository);
    close(other);
    repository = openRepository();
    now = 179_999;
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(false);
    expect(await repository.consumeRateLimit("join:ip-two", 2, 60)).toBe(true);
    now = 180_000;
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(true);
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(true);
    expect(await repository.consumeRateLimit("join:ip-one", 2, 60)).toBe(false);
    expect(inspectDatabase().prepare("SELECT count(*) AS total FROM waitlist_rate_limits WHERE expires_at <= ?").get(180))
      .toMatchObject({ total: 0 });
  });

  it("keeps different rate-limit windows independent and accepts supported boundary values", async () => {
    now = 120_000;
    expect(await repository.consumeRateLimit("same-key", 1, 60)).toBe(true);
    expect(await repository.consumeRateLimit("same-key", 1, 60)).toBe(false);
    expect(await repository.consumeRateLimit("same-key", 1, 1)).toBe(true);
    now = 121_000;
    expect(await repository.consumeRateLimit("same-key", 1, 1)).toBe(true);
    expect(await repository.consumeRateLimit("same-key", 1, 60)).toBe(false);
    expect(await repository.consumeRateLimit("k".repeat(128), 10_000, 86_400)).toBe(true);
  });

  it.each([
    ["", 1, 60], ["k".repeat(129), 1, 60], ["key", 0, 60], ["key", -1, 60],
    ["key", 1.5, 60], ["key", 10_001, 60], ["key", Number.NaN, 60],
    ["key", 1, 0], ["key", 1, -1], ["key", 1, 0.5], ["key", 1, 86_401], ["key", 1, Infinity],
  ])("rejects invalid rate-limit configuration (%s, %s, %s) without consuming capacity", async (key, limit, windowSeconds) => {
    await expect(repository.consumeRateLimit(key as string, limit as number, windowSeconds as number))
      .rejects.toMatchObject({ status: 503 });
    expect(inspectDatabase().prepare("SELECT count(*) AS total FROM waitlist_rate_limits").get()).toMatchObject({ total: 0 });
  });

  it.each([0, -1, 1.5, 1001, Number.NaN, Infinity])("rejects admission count %s before mutating the queue", async (count) => {
    await seed(1);
    await expect(repository.admit(count, "admin", "invalid-count")).rejects.toMatchObject({ status: 400 });
    expect(await repository.list({ limit: 100 })).toMatchObject({ total: 1, queued: 1, admitted: 0 });
  });

  it.each([
    ["", "request"], [" ", "request"], ["a".repeat(201), "request"],
    ["admin", ""], ["admin", " "], ["admin", "r".repeat(129)],
  ])("rejects invalid admission identity %j / %j without reserving a batch", async (actor, requestId) => {
    await expect(repository.admit(1, actor, requestId)).rejects.toMatchObject({ status: 400 });
    expect(inspectDatabase().prepare("SELECT count(*) AS total FROM waitlist_batches").get()).toMatchObject({ total: 0 });
  });

  it.each([
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: 10, after: -1 },
    { limit: 10, after: 0.5 }, { limit: 10, after: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid list bounds %j", async (options) => {
    await expect(repository.list(options)).rejects.toThrow();
  });

  it("validates a submission before writing any record", async () => {
    await expect(repository.join({ email: "invalid", occupation: "Engineer", useCase: "Deploy" })).rejects.toThrow();
    await expect(repository.join({ email: "valid@example.test", occupation: " ", useCase: "Deploy" })).rejects.toThrow();
    await expect(repository.join({ email: "valid@example.test", occupation: "Engineer", useCase: " " })).rejects.toThrow();
    expect(await repository.list({ limit: 100 })).toEqual({ entries: [], total: 0, queued: 0, admitted: 0, nextCursor: null });
  });
});
