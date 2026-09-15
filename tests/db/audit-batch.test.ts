/**
 * `appendAuditBatch` — the two properties A-4 says it did not have.
 *
 * **Nothing is lost to a torn tail.** `appendAudit` is a bare `appendFileSync`,
 * so an interrupted write leaves a line with no trailing newline. The old
 * implementation read the whole log, concatenated the batch onto that remnant
 * and renamed a full copy over the file — which glued the batch's *first* row
 * onto the broken line. Every reader parses a line in a `try/catch` and skips
 * what will not parse, so that row disappeared with no error while the caller
 * was told 204.
 *
 * **The cost is the batch, not the log.** The rewrite read the entire file into
 * a JS string to emit one to three rows.
 *
 * Both are asserted against the file on disk rather than against the
 * implementation, except for the one spy that pins "the log is never read" —
 * which is the only way to state a *cost* claim as a test.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-audit-batch-");

const { FileStore } = await import("@/lib/db/file-store");

const AUDIT = path.join(DATA, "audit.jsonl");

const event = (id: string): AuditEvent => ({
  ts: "2026-01-02T00:00:00.000Z",
  id,
  workspaceId: "w-atlas",
  actor: { type: "user", id: "u-me", name: "Mika" },
  actionId: "workspace.removeMember",
  input: { memberId: "u-me" },
  result: "ok",
  summary: `row ${id}`,
});

const idsOnDisk = (): string[] =>
  fs
    .readFileSync(AUDIT, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line) return [];
      try {
        return [(JSON.parse(line) as AuditEvent).id];
      } catch {
        return [];
      }
    });

beforeEach(() => {
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(AUDIT)) fs.unlinkSync(AUDIT);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appending a batch", () => {
  it("writes every row, newline-terminated, on an empty log", () => {
    FileStore.appendAuditBatch([event("a"), event("b")]);
    expect(idsOnDisk()).toEqual(["a", "b"]);
    expect(fs.readFileSync(AUDIT, "utf8").endsWith("\n")).toBe(true);
  });

  it("does nothing at all for an empty batch", () => {
    FileStore.appendAuditBatch([]);
    expect(fs.existsSync(AUDIT)).toBe(false);
  });

  it("leaves rows written by the plain append path alone", () => {
    FileStore.appendAudit(event("first"));
    FileStore.appendAuditBatch([event("second")]);
    expect(idsOnDisk()).toEqual(["first", "second"]);
  });
});

describe("a torn tail", () => {
  it("does not swallow the batch's first row when the last line lost its newline", () => {
    // A crash after the record was written and before its newline was: the line
    // itself is complete, so nothing about it should be lost either.
    fs.writeFileSync(AUDIT, JSON.stringify(event("survivor")), "utf8");

    FileStore.appendAuditBatch([event("a"), event("b")]);

    expect(idsOnDisk()).toEqual(["survivor", "a", "b"]);
  });

  it("keeps the whole batch when the last line is genuinely half-written", () => {
    // A crash *inside* the record. That one is unrecoverable and stays lost —
    // but it must not take the batch's first row down with it.
    fs.writeFileSync(AUDIT, `${JSON.stringify(event("done"))}\n{"id":"half","ts":`, "utf8");

    FileStore.appendAuditBatch([event("a"), event("b")]);

    expect(idsOnDisk()).toEqual(["done", "a", "b"]);
    // The repair is one newline, so the broken record is now its own line
    // rather than a prefix of a good one.
    const lines = fs.readFileSync(AUDIT, "utf8").split("\n");
    expect(lines.filter((l) => l.startsWith('{"id":"half"'))).toEqual(['{"id":"half","ts":']);
  });

  it("repairs the tail once, not on every later append", () => {
    fs.writeFileSync(AUDIT, JSON.stringify(event("survivor")), "utf8");
    FileStore.appendAuditBatch([event("a")]);
    const after = fs.readFileSync(AUDIT, "utf8");
    FileStore.appendAuditBatch([event("b")]);
    expect(fs.readFileSync(AUDIT, "utf8")).toBe(`${after}${JSON.stringify(event("b"))}\n`);
  });
});

describe("the cost of a batch is the batch", () => {
  it("never reads the log", () => {
    FileStore.appendAudit(event("existing"));
    const readFileSync = vi.spyOn(fs, "readFileSync");

    FileStore.appendAuditBatch([event("a"), event("b")]);

    const readsOfTheLog = () =>
      readFileSync.mock.calls.filter((call) => String(call[0]) === AUDIT);
    expect(readsOfTheLog()).toEqual([]);
    // …and the spy is wired, so the assertion above is not vacuous.
    fs.readFileSync(AUDIT);
    expect(readsOfTheLog()).toHaveLength(1);
  });

  it("grows the file by exactly the batch, leaving earlier bytes untouched", () => {
    FileStore.appendAudit(event("existing"));
    const before = fs.readFileSync(AUDIT);

    const batch = [event("a"), event("b")];
    FileStore.appendAuditBatch(batch);

    const after = fs.readFileSync(AUDIT);
    const expected = Buffer.byteLength(
      `${batch.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8"
    );
    expect(after.length - before.length).toBe(expected);
    // Byte-for-byte prefix: a rewrite could have produced the same length.
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
  });

  it("leaves no temporary copy of the log behind", () => {
    FileStore.appendAuditBatch([event("a")]);
    expect(fs.readdirSync(DATA).filter((f) => f.includes("audit.jsonl."))).toEqual([]);
  });
});

describe("the reader agrees with the file", () => {
  it("returns every row of a batch appended after a torn tail", () => {
    fs.writeFileSync(AUDIT, JSON.stringify(event("survivor")), "utf8");
    FileStore.appendAuditBatch([event("a"), event("b")]);

    const ids = FileStore.readAudit({ workspaceId: "w-atlas" }).map((e) => e.id);
    expect(ids.sort()).toEqual(["a", "b", "survivor"]);
    expect(FileStore.countAudit({ workspaceId: "w-atlas" }).total).toBe(3);
  });
});
