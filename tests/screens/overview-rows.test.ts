/**
 * The overview's triage logic: what "needs me" means, and what each sort and
 * filter actually orders by. All pure over the rows the server hands down.
 */
import { describe, expect, it } from "vitest";
import {
  envStatus,
  filterProjects,
  needsAttention,
  sortProjects,
  type EnvRow,
  type ProjectRow,
} from "@/app/(product)/overview/rows";
import type { Deployment, Environment } from "@/lib/domain/types";

const env = (over: Partial<EnvRow> = {}): EnvRow => ({
  id: "e1",
  name: "staging",
  klass: "staging",
  region: "us-east-1",
  dot: "ok",
  word: "live",
  revision: "r3",
  pending: 0,
  projectedUsd: 40,
  ...over,
});

const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: "p1",
  name: "Atlas",
  slug: "atlas",
  workingUsd: 100,
  deployedUsd: 90,
  openFindings: 0,
  pending: 0,
  environments: [env()],
  ...over,
});

describe("needsAttention", () => {
  it("is false when nothing is undeployed and nothing is open", () => {
    expect(needsAttention(project())).toBe(false);
  });

  it("is true for undeployed changes alone", () => {
    expect(needsAttention(project({ pending: 2 }))).toBe(true);
  });

  it("is true for open findings alone", () => {
    expect(needsAttention(project({ openFindings: 1 }))).toBe(true);
  });
});

describe("sortProjects", () => {
  const quiet = project({ id: "a", name: "Aurora", slug: "aurora", workingUsd: 500 });
  const findings = project({ id: "b", name: "Borealis", slug: "borealis", openFindings: 3 });
  const pending = project({ id: "c", name: "Cassini", slug: "cassini", pending: 4 });

  it("puts the most undeployed work first, then findings, then name", () => {
    const order = sortProjects([quiet, findings, pending], "attention").map((p) => p.id);
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("sorts by name, cost and recency on request", () => {
    expect(sortProjects([pending, quiet], "name").map((p) => p.id)).toEqual(["a", "c"]);
    expect(sortProjects([findings, quiet], "cost").map((p) => p.id)).toEqual(["a", "b"]);
    const older = project({ id: "old", lastDeployedAt: "2026-01-01T00:00:00.000Z" });
    const newer = project({ id: "new", lastDeployedAt: "2026-06-01T00:00:00.000Z" });
    expect(sortProjects([older, newer], "recent").map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("never mutates the input", () => {
    const rows = [pending, quiet];
    sortProjects(rows, "name");
    expect(rows.map((p) => p.id)).toEqual(["c", "a"]);
  });

  it("puts a project with no deploy last under 'recent' rather than dropping it", () => {
    const never = project({ id: "never" });
    const once = project({ id: "once", lastDeployedAt: "2026-01-01T00:00:00.000Z" });
    expect(sortProjects([never, once], "recent").map((p) => p.id)).toEqual(["once", "never"]);
  });
});

describe("filterProjects", () => {
  const atlas = project({ id: "p1", name: "Atlas", slug: "atlas" });
  const kepler = project({
    id: "p2",
    name: "Kepler",
    slug: "kepler",
    pending: 1,
    environments: [env({ id: "e2", name: "production", klass: "production" })],
  });

  it("matches project name, slug and environment name", () => {
    expect(filterProjects([atlas, kepler], "atl", false).map((p) => p.id)).toEqual(["p1"]);
    expect(filterProjects([atlas, kepler], "kepler", false).map((p) => p.id)).toEqual(["p2"]);
    expect(filterProjects([atlas, kepler], "production", false).map((p) => p.id)).toEqual(["p2"]);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(filterProjects([atlas, kepler], "  ATLAS ", false).map((p) => p.id)).toEqual(["p1"]);
  });

  it("combines the query with the attention filter", () => {
    expect(filterProjects([atlas, kepler], "", true).map((p) => p.id)).toEqual(["p2"]);
    expect(filterProjects([atlas, kepler], "atlas", true)).toEqual([]);
  });
});

describe("envStatus", () => {
  const environment = (deployed?: string): Environment =>
    ({ deployedRevisionId: deployed }) as Environment;
  const deployment = (status: Deployment["status"]): Deployment => ({ status }) as Deployment;

  it("never reports a state with colour alone — every state has a word", () => {
    for (const s of ["applying", "verifying", "rolling_back", "failed", "awaiting_approval"] as const)
      expect(envStatus(environment("r1"), deployment(s)).word).not.toBe("");
  });

  it("says 'not deployed' rather than 'live' when nothing has been deployed", () => {
    expect(envStatus(environment(), undefined)).toEqual({ dot: "idle", word: "not deployed" });
    expect(envStatus(environment("r1"), undefined)).toEqual({ dot: "ok", word: "live" });
  });

  it("reports a failed deploy as failed even though a revision is live", () => {
    expect(envStatus(environment("r1"), deployment("failed"))).toEqual({
      dot: "err",
      word: "deploy failed",
    });
  });
});
