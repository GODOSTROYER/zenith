/**
 * Where a notification leads is a property of the notification, not of the
 * panel it is listed in. The panel used to derive one URL from "the project in
 * the route, or else the first one" and hand it to every row, so a message
 * about a project you deleted opened a different project's trail.
 */
import { describe, expect, it } from "vitest";
import {
  activityTarget,
  normalizeActivity,
  UNAVAILABLE_NOTE,
  type AuthorizedProject,
} from "@/components/shell/activity-target";

const PROJECTS: AuthorizedProject[] = [
  { id: "p1", name: "Atlas", slug: "atlas" },
  { id: "p2", name: "Borealis", slug: "borealis" },
];

describe("activityTarget", () => {
  it("routes each row to its own project, not to the first or the current one", () => {
    expect(activityTarget({ projectId: "p2" }, PROJECTS)).toEqual({
      kind: "link",
      href: "/p/borealis/activity",
      projectName: "Borealis",
    });
    expect(activityTarget({ projectId: "p1" }, PROJECTS)).toEqual({
      kind: "link",
      href: "/p/atlas/activity",
      projectName: "Atlas",
    });
  });

  it("resolves a slug-only record, and url-encodes what it puts in the path", () => {
    expect(activityTarget({ projectSlug: "borealis" }, PROJECTS)).toMatchObject({
      href: "/p/borealis/activity",
    });
    expect(
      activityTarget({ projectSlug: "a b" }, [{ id: "p3", name: "Odd", slug: "a b" }])
    ).toMatchObject({ href: "/p/a%20b/activity" });
  });

  it("calls a deleted or unauthorized project unavailable instead of falling back", () => {
    expect(activityTarget({ projectId: "gone" }, PROJECTS)).toEqual({ kind: "unavailable" });
    expect(activityTarget({ projectSlug: "nowhere" }, PROJECTS)).toEqual({ kind: "unavailable" });
    expect(activityTarget({ projectId: "p9" }, [])).toEqual({ kind: "unavailable" });
  });

  it("trusts the id over a slug another project has since taken", () => {
    // "atlas" was deleted and the name reused. The record's own id is gone, so
    // the honest answer is "unavailable", never the new project's trail.
    expect(activityTarget({ projectId: "old", projectSlug: "atlas" }, PROJECTS)).toEqual({
      kind: "unavailable",
    });
  });

  it("leaves records without project identity as plain rows", () => {
    expect(activityTarget({}, PROJECTS)).toEqual({ kind: "none" });
    expect(activityTarget({ projectId: "  " }, PROJECTS)).toEqual({ kind: "none" });
  });

  it("does not declare a row dead while the workspace list is still loading", () => {
    expect(activityTarget({ projectId: "p1" }, undefined)).toEqual({ kind: "pending" });
    expect(activityTarget({}, undefined)).toEqual({ kind: "none" });
  });

  it("states the unavailable case in words the row can show", () => {
    expect(UNAVAILABLE_NOTE).toMatch(/no longer available/i);
  });
});

describe("normalizeActivity", () => {
  it("loads records written before notifications carried a project", () => {
    const legacy = [{ id: "a", title: "Deployed", ts: "2026-09-01T00:00:00.000Z", kind: "ok" }];
    expect(normalizeActivity(legacy, 20)).toEqual([
      { id: "a", title: "Deployed", ts: "2026-09-01T00:00:00.000Z", kind: "ok" },
    ]);
    expect(activityTarget(normalizeActivity(legacy, 20)[0], PROJECTS)).toEqual({ kind: "none" });
  });

  it("keeps project identity when it is there, and drops junk rows", () => {
    const stored = [
      { id: "a", title: "Deployed", ts: "t", kind: "ok", projectId: "p2", projectSlug: "borealis" },
      null,
      "nonsense",
      { title: "no id", ts: "t" },
      { id: "b", title: "Odd kind", ts: "t", kind: "whatever", projectId: 7 },
    ];
    expect(normalizeActivity(stored, 20)).toEqual([
      { id: "a", title: "Deployed", ts: "t", kind: "ok", projectId: "p2", projectSlug: "borealis" },
      { id: "b", title: "Odd kind", ts: "t", kind: "info" },
    ]);
  });

  it("returns an empty buffer for anything that is not a list, and honours the cap", () => {
    expect(normalizeActivity(null, 20)).toEqual([]);
    expect(normalizeActivity({ id: "a" }, 20)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, title: "x", ts: "t" }));
    expect(normalizeActivity(many, 20)).toHaveLength(20);
  });
});
