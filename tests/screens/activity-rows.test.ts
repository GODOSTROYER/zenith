/**
 * Grouping, de-duplication, date filtering, CSV and object links behind the
 * Activity feed. All pure over AuditEvents.
 */
import { describe, expect, it } from "vitest";
import {
  dedupe,
  groupByDay,
  inDateRange,
  objectLink,
  toCsv,
} from "@/app/(product)/p/[slug]/activity/rows";
import type { AuditEvent } from "@/lib/domain/types";

const at = (iso: string, over: Partial<AuditEvent> = {}): AuditEvent => ({
  ts: iso,
  id: over.id ?? iso,
  workspaceId: "ws",
  projectId: "p1",
  actor: { type: "user", id: "u1", name: "Ada" },
  actionId: "system.addService",
  input: {},
  result: "ok",
  summary: "added api",
  ...over,
});

/** Local noon, so the test does not straddle a day boundary in any timezone. */
const noon = (day: number) => new Date(2026, 8, day, 12, 0, 0).toISOString();

describe("groupByDay", () => {
  it("groups by calendar day whatever order the events arrive in", () => {
    const days = groupByDay([
      at(noon(1), { id: "a" }),
      at(noon(3), { id: "b" }),
      at(noon(1), { id: "c" }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0].events.map((e) => e.id)).toEqual(["b"]);
    expect(days[1].events.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("puts the newest day first and the newest event first inside it", () => {
    const days = groupByDay([
      at(new Date(2026, 8, 1, 9).toISOString(), { id: "morning" }),
      at(new Date(2026, 8, 1, 17).toISOString(), { id: "evening" }),
      at(noon(2), { id: "next-day" }),
    ]);
    expect(days.map((d) => d.events[0].id)).toEqual(["next-day", "evening"]);
  });

  it("keeps undated events instead of dropping them", () => {
    const days = groupByDay([at("not-a-date", { id: "x" })]);
    expect(days).toHaveLength(1);
    expect(days[0].label).toBe("Undated");
  });
});

describe("dedupe", () => {
  it("keeps one row per id when a poll overlaps a hand-loaded page", () => {
    const rows = dedupe([at(noon(2), { id: "a" }), at(noon(1), { id: "b" }), at(noon(2), { id: "a" })]);
    expect(rows.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("inDateRange", () => {
  const e = at(noon(15));
  it("is inclusive at both ends, in local time", () => {
    expect(inDateRange(e, "2026-09-15", "2026-09-15")).toBe(true);
    expect(inDateRange(e, "2026-09-16", "")).toBe(false);
    expect(inDateRange(e, "", "2026-09-14")).toBe(false);
  });
  it("passes everything through when neither end is set", () => {
    expect(inDateRange(at("nonsense"), "", "")).toBe(true);
  });
});

describe("toCsv", () => {
  it("quotes and escapes, and keeps the column order", () => {
    const csv = toCsv([at(noon(1), { summary: 'said "hi", loudly' })]);
    const [header, row] = csv.trim().split("\r\n");
    expect(header.split(",")[0]).toBe("ts");
    expect(row).toContain('"said ""hi"", loudly"');
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    const csv = toCsv([at(noon(1), { summary: '=HYPERLINK("http://evil","click")' })]);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});

describe("objectLink", () => {
  it("points a node change at the map", () => {
    expect(objectLink(at(noon(1), { input: { serviceId: "svc-api" } }))).toEqual({
      path: "?select=svc-api",
      label: "show on map",
    });
  });

  it("points a deploy at the deploys tab", () => {
    expect(objectLink(at(noon(1), { actionId: "deploy.start", input: {} }))?.path).toBe("/deploys");
  });

  it("returns nothing when the input names no object", () => {
    expect(objectLink(at(noon(1), { actionId: "project.rename", input: { name: "x" } }))).toBeUndefined();
  });
});
