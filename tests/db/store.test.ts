import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AuditEvent, DeploymentEvent } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-store-");
const { appendAudit, appendEvent, db, flush, readAudit, readAuditPage, readEvents, resetDb, save } =
  await import("@/lib/db/store");

const EVENTS = path.join(DATA, "events.jsonl");
const STATE = path.join(DATA, "state.json");

const event = (deploymentId: string, seq: number): DeploymentEvent => ({
  ts: new Date().toISOString(),
  deploymentId,
  seq,
  type: "log",
  stepId: "s0",
  line: `line ${seq}`,
  stream: "info",
});

const audit = (n: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  ts: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  id: `a${n}`,
  workspaceId: "ws",
  projectId: "proj",
  actor: { type: "user", id: "u", name: "You" },
  actionId: "system.addService",
  input: { name: `svc-${n}` },
  result: "ok",
  summary: `added svc-${n} — a summary long enough to make the log span several chunks ${"·".repeat(40)}`,
  ...over,
});

beforeAll(() => resetDb());

describe("readEvents", () => {
  it("returns only what is new, without re-reading the whole log", () => {
    for (let i = 0; i < 3; i++) appendEvent(event("d1", i));
    appendEvent(event("d2", 0));

    expect(readEvents("d1").map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(readEvents("d1", 1).map((e) => e.seq)).toEqual([2]);
    expect(readEvents("d2")).toHaveLength(1);

    const before = fs.statSync(EVENTS).size;
    appendEvent(event("d1", 3));
    expect(readEvents("d1", 2).map((e) => e.seq)).toEqual([3]);
    expect(fs.statSync(EVENTS).size).toBeGreaterThan(before);
  });

  it("ignores a half-written line until it is complete", () => {
    const partial = JSON.stringify(event("d1", 4)).slice(0, 30);
    fs.appendFileSync(EVENTS, partial, "utf8");
    expect(readEvents("d1", 3)).toHaveLength(0);

    fs.appendFileSync(EVENTS, JSON.stringify(event("d1", 4)).slice(30) + "\n", "utf8");
    expect(readEvents("d1", 3).map((e) => e.seq)).toEqual([4]);
  });

  it("starts over when the log is reset underneath it", () => {
    resetDb();
    expect(readEvents("d1")).toHaveLength(0);
    appendEvent(event("d1", 0));
    expect(readEvents("d1")).toHaveLength(1);
  });
});

describe("readAudit", () => {
  beforeAll(() => {
    resetDb();
    appendAudit(audit(0, { actor: { type: "navigator", id: "navigator", name: "Navigator" } }));
    for (let i = 1; i <= 300; i++)
      appendAudit(audit(i, i % 50 === 0 ? { actionId: "deploy.apply", result: "denied" } : {}));
  });

  it("returns the newest entries first, capped at the limit", () => {
    const events = readAudit({ projectId: "proj", limit: 10 });
    expect(events).toHaveLength(10);
    expect(events[0].id).toBe("a300");
    expect(events[9].id).toBe("a291");
  });

  it("pages backwards through the whole log with no gaps or duplicates", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const { events, nextCursor } = readAuditPage({ projectId: "proj", limit: 40, cursor });
      seen.push(...events.map((e) => e.id));
      cursor = nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(301);
    expect(new Set(seen).size).toBe(301);
    expect(seen[0]).toBe("a300");
    expect(seen[300]).toBe("a0");
  });

  it("filters by actor type across the whole log, not just the last window", () => {
    // The only navigator entry is the oldest line in the file.
    const events = readAudit({ projectId: "proj", actorType: "navigator", limit: 10 });
    expect(events.map((e) => e.id)).toEqual(["a0"]);
  });

  it("filters by action id, exactly or by prefix", () => {
    expect(readAudit({ actionId: "deploy.apply" }).length).toBe(6);
    expect(readAudit({ actionId: "deploy." }).length).toBe(6);
    expect(readAudit({ actionId: "system.addService" }).length).toBe(295);
    expect(readAudit({ result: "denied" }).length).toBe(6);
  });

  it("excludes other projects", () => {
    appendAudit(audit(999, { projectId: "other" }));
    expect(readAudit({ projectId: "proj", limit: 1 })[0].id).toBe("a300");
  });
});

describe("save", () => {
  it("coalesces writes, stays atomic, and never pretty-prints", async () => {
    resetDb();
    db().settings.autonomy = "bounded";
    for (let i = 0; i < 20; i++) save();
    await new Promise((r) => setTimeout(r, 200));

    const raw = fs.readFileSync(STATE, "utf8");
    expect(raw.startsWith('{"workspaces":')).toBe(true); // compact, not indented
    expect(JSON.parse(raw).settings.autonomy).toBe("bounded");
    // written to a temp file and renamed, so nothing half-written is left behind
    expect(fs.existsSync(`${STATE}.tmp`)).toBe(false);
  });

  it("flush() persists immediately", () => {
    db().settings.autonomy = "approve";
    save();
    flush();
    expect(JSON.parse(fs.readFileSync(STATE, "utf8")).settings.autonomy).toBe("approve");
  });
});
