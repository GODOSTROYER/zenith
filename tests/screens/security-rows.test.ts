/**
 * The Security screen's pure logic: filtering, sorting, which automatic fixes
 * the caller can actually run, and the export. The interesting one is
 * `splitFixes` — it is what stops "Fix all N" from meaning "attempt N and
 * report the refusals afterwards".
 */
import { describe, expect, it } from "vitest";
import type { ActionPlan } from "@/lib/actions/core";
import {
  CSV_COLUMNS,
  excludedNote,
  isEnvironmentPolicy,
  matches,
  NO_FILTERS,
  roleReaches,
  sortFindings,
  splitFixes,
  STATUS_LABEL,
  toCsv,
  toJson,
  type FixRow,
} from "@/app/(product)/p/[slug]/security/rows";
import type { SecurityFinding } from "@/lib/domain/types";

const finding = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: over.id ?? "sf_1",
  projectId: "p1",
  severity: "medium",
  title: "api runs a single replica",
  detail: "one replica is one point of failure",
  status: "open",
  createdAt: "2026-09-01T10:00:00.000Z",
  ...over,
});

const plan = (over: Partial<ActionPlan> = {}): ActionPlan => ({
  summary: "does the thing",
  details: [],
  costDeltaUsd: 0,
  risk: "low",
  warnings: [],
  requiresApproval: false,
  ...over,
});

describe("filters", () => {
  const rows = [
    finding({ id: "a", severity: "high", environmentId: "env_prod", fix: { actionId: "system.updateRoute", input: {}, label: "Turn TLS on" } }),
    finding({ id: "b", severity: "low", environmentId: "env_stage" }),
    finding({ id: "c", severity: "high" }),
  ];

  it("shows everything by default", () => {
    expect(rows.filter((f) => matches(f, NO_FILTERS))).toHaveLength(3);
  });

  it("filters by severity, by whether a fix exists, and by environment", () => {
    expect(rows.filter((f) => matches(f, { ...NO_FILTERS, severity: "high" })).map((f) => f.id)).toEqual(["a", "c"]);
    expect(rows.filter((f) => matches(f, { ...NO_FILTERS, fix: "fixable" })).map((f) => f.id)).toEqual(["a"]);
    expect(rows.filter((f) => matches(f, { ...NO_FILTERS, fix: "manual" })).map((f) => f.id)).toEqual(["b", "c"]);
    expect(rows.filter((f) => matches(f, { ...NO_FILTERS, environmentId: "env_prod" })).map((f) => f.id)).toEqual(["a"]);
  });

  it("separates findings that belong to no environment from every environment filter", () => {
    expect(rows.filter((f) => matches(f, { ...NO_FILTERS, environmentId: "none" })).map((f) => f.id)).toEqual(["c"]);
  });
});

describe("sortFindings", () => {
  const older = finding({ id: "old", severity: "high", createdAt: "2026-08-01T00:00:00.000Z" });
  const newer = finding({ id: "new", severity: "low", createdAt: "2026-09-01T00:00:00.000Z" });

  it("orders by severity, then newest, and never sorts the caller's array", () => {
    const input = [newer, older];
    expect(sortFindings(input, "severity").map((f) => f.id)).toEqual(["old", "new"]);
    expect(sortFindings(input, "newest").map((f) => f.id)).toEqual(["new", "old"]);
    expect(sortFindings(input, "oldest").map((f) => f.id)).toEqual(["old", "new"]);
    expect(input.map((f) => f.id)).toEqual(["new", "old"]);
  });
});

describe("splitFixes", () => {
  const rows: FixRow[] = [
    { finding: finding({ id: "ok" }), plan: plan() },
    {
      finding: finding({ id: "needs-admin" }),
      plan: plan({ blocked: "\"Set a $40/mo budget\" cannot run: needs the admin role", requiredRole: "admin" }),
    },
    {
      finding: finding({ id: "no-store" }),
      plan: plan({ blocked: "\"Move to the secret store\" cannot run: there is nowhere to put the value" }),
    },
    { finding: finding({ id: "boom" }), error: "the plan request failed" },
  ];

  it("keeps only fixes that will actually run, and says why each other one is out", () => {
    const split = splitFixes(rows, "editor");
    expect(split.runnable.map((r) => r.finding.id)).toEqual(["ok"]);
    expect(split.roleBlocked.map((r) => r.finding.id)).toEqual(["needs-admin"]);
    expect(split.otherBlocked.map((r) => r.finding.id)).toEqual(["no-store"]);
    expect(split.unplannable.map((r) => r.finding.id)).toEqual(["boom"]);

    const note = excludedNote(split, "editor");
    expect(note).toContain("1 needs the admin role and you are editor");
    expect(note).toContain("1 would be refused by its own action");
    expect(note).toContain("1 could not be previewed");
  });

  it("counts a role the caller does have as an ordinary refusal, not a role problem", () => {
    const split = splitFixes(rows, "admin");
    expect(split.roleBlocked).toHaveLength(0);
    expect(split.otherBlocked.map((r) => r.finding.id)).toEqual(["needs-admin", "no-store"]);
  });

  it("says nothing when nothing is excluded", () => {
    expect(excludedNote(splitFixes([rows[0]], "editor"), "editor")).toBeUndefined();
  });

  it("treats an unknown role the way the server does — as able to run anything", () => {
    expect(roleReaches(null, "admin")).toBe(true);
    expect(roleReaches("viewer", "editor")).toBe(false);
    expect(roleReaches("admin", "editor")).toBe(true);
    expect(roleReaches("viewer", undefined)).toBe(true);
  });
});

describe("status labels", () => {
  it("never calls a working-copy fix 'fixed'", () => {
    expect(STATUS_LABEL.fixed_pending_deploy).toBe("fixed, not deployed");
    expect(STATUS_LABEL.resolved).toBe("resolved");
  });
});

describe("isEnvironmentPolicy", () => {
  it("recognises the findings whose fix lives in Settings → Environments", () => {
    expect(isEnvironmentPolicy(finding({ fix: { actionId: "env.updatePolicies", input: {}, label: "Require approval" } }))).toBe(true);
    expect(isEnvironmentPolicy(finding({ fix: { actionId: "env.setBudget", input: {}, label: "Set a budget" } }))).toBe(true);
    expect(isEnvironmentPolicy(finding({ fix: { actionId: "system.updateRoute", input: {}, label: "Turn TLS on" } }))).toBe(false);
    expect(isEnvironmentPolicy(finding())).toBe(false);
  });
});

describe("export", () => {
  const rows = [
    finding({
      id: "sf_a",
      status: "dismissed",
      environmentId: "env_prod",
      resolvedAt: "2026-09-02T09:00:00.000Z",
      resolvedBy: { type: "user", id: "u1", name: "Ada" },
      resolvedReason: "=SUM(A1) accepted, behind the VPN",
    }),
    finding({ id: "sf_b", status: "fixed_pending_deploy" }),
  ];
  const envName = { env_prod: "production" };

  it("writes a header row, resolves environment names and never emits a live formula", () => {
    const csv = toCsv(rows, envName);
    const [header, first] = csv.split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    expect(first).toContain('"production"');
    expect(first).toContain('"Ada"');
    expect(first).toContain(`"'=SUM(A1) accepted, behind the VPN"`);
  });

  it("labels the JSON export with what it is and counts every status", () => {
    const out = JSON.parse(toJson(rows, { project: "atlas", at: "2026-09-02T10:00:00.000Z", envName })) as {
      note: string;
      counts: Record<string, number>;
      findings: { statusLabel: string; environmentName?: string }[];
    };
    expect(out.note).toMatch(/snapshot/);
    expect(out.counts).toEqual({ dismissed: 1, fixed_pending_deploy: 1 });
    expect(out.findings[0].environmentName).toBe("production");
    expect(out.findings[1].statusLabel).toBe("fixed, not deployed");
  });
});
