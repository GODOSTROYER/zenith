import { describe, expect, it } from "vitest";
import { describePlanValue, groupByNode, isDestructiveAction } from "@/components/platform/plan-values";

describe("describePlanValue", () => {
  const change = (over: Record<string, unknown>) => ({ path: "desired_count", forcesReplacement: false, ...over }) as Parameters<typeof describePlanValue>[0];

  it("shows a plain value", () => {
    expect(describePlanValue(change({ before: 2, after: 3 }), "after", "update")).toMatchObject({ text: "3", kind: "value" });
    expect(describePlanValue(change({ before: "web:4" }), "before", "update")).toMatchObject({ text: "web:4", kind: "value" });
    expect(describePlanValue(change({ after: false }), "after", "update")).toMatchObject({ text: "false", kind: "value" });
  });

  it("keeps '(known after apply)' exactly as written", () => {
    expect(describePlanValue(change({ before: "a", after: "(known after apply)" }), "after", "update")).toMatchObject({
      text: "(known after apply)",
      kind: "unknown",
    });
  });

  it("shows a masked value only as '(sensitive)'", () => {
    const c = change({ path: "password", before: "(sensitive)", after: "(sensitive)" });
    expect(describePlanValue(c, "before", "update").text).toBe("(sensitive)");
    expect(describePlanValue(c, "after", "update").text).toBe("(sensitive)");
  });

  it("never prints a value the change is flagged sensitive for, even if one is supplied", () => {
    const c = change({ path: "size", sensitive: true, before: "hunter2", after: "hunter3" });
    expect(describePlanValue(c, "before", "update")).toMatchObject({ text: "(sensitive)", kind: "sensitive" });
    expect(describePlanValue(c, "after", "update")).toMatchObject({ text: "(sensitive)", kind: "sensitive" });
  });

  it("never prints a value at a secret-looking path", () => {
    const c = change({ path: "environment.DATABASE_PASSWORD", before: "hunter2", after: "hunter3" });
    expect(describePlanValue(c, "after", "update").text).toBe("(sensitive)");
  });

  it("still shows a secret reference", () => {
    const c = change({ path: "secret_ref", after: "vault:web/db" });
    expect(describePlanValue(c, "after", "update").text).toBe("vault:web/db");
  });

  it("says a withheld value was withheld, never blank", () => {
    expect(describePlanValue(change({}), "after", "update")).toMatchObject({ text: "(not shown)", kind: "not_shown" });
    expect(describePlanValue(change({ path: "auth.token" }), "after", "update").text).toBe("(sensitive)");
  });

  it("distinguishes 'not set', 'removed' and 'unset'", () => {
    expect(describePlanValue(change({ before: null, after: 30 }), "before", "create").text).toBe("(not set)");
    expect(describePlanValue(change({ before: 30, after: null }), "after", "delete").text).toBe("(removed)");
    expect(describePlanValue(change({ before: 30, after: null }), "after", "update").text).toBe("(unset)");
  });

  it("renders an empty string visibly", () => {
    expect(describePlanValue(change({ after: "" }), "after", "update").text).toBe('""');
  });
});

describe("groupByNode", () => {
  it("groups by node address sorted, with unmapped changes last", () => {
    const groups = groupByNode([
      { nodeAddress: "service/web", n: 1 },
      { nodeAddress: undefined, n: 2 },
      { nodeAddress: "resource/db", n: 3 },
      { nodeAddress: "service/web", n: 4 },
    ]);
    expect(groups.map((g) => g.nodeAddress)).toEqual(["resource/db", "service/web", undefined]);
    expect(groups[1].resources.map((r) => r.n)).toEqual([1, 4]);
  });
});

describe("isDestructiveAction", () => {
  it("is true for delete and replace only", () => {
    expect(["create", "update", "delete", "replace", "read", "no-op"].filter((a) => isDestructiveAction(a as never))).toEqual(["delete", "replace"]);
  });
});
