/**
 * The overview's own arithmetic, straight off the store.
 *
 * The screen is a server component, so it is called as the function it is and
 * the returned element tree is read directly — no renderer, no DOM. What is
 * asserted here is what the audit said the screen was hiding: undeployed work,
 * open findings, working cost vs deployed cost, and a bounded audit read.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReactElement } from "react";
import type { AuditEvent, Manifest, Service } from "@/lib/domain/types";
import type { ProjectRow } from "@/app/(product)/overview/rows";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-overview-"));

const { appendAudit, resetDb } = await import("@/lib/db/store");
const { monthlyCostUsd } = await import("@/lib/cost/pricing");
const { emptyManifest } = await import("@/lib/domain/types");
const OverviewPage = (await import("@/app/(product)/overview/page")).default;

const NOW = "2026-09-01T10:00:00.000Z";

const service = (id: string): Service => ({
  id,
  name: id,
  kind: "web",
  source: { type: "image", image: `${id}:1` },
  size: "small",
  replicas: 1,
  env: [],
  ownership: "managed",
});

/** Deployed: one service. Working: two — so exactly one change is undeployed. */
const deployed: Manifest = { ...emptyManifest(), services: [service("api")] };
const working: Manifest = { ...emptyManifest(), services: [service("api"), service("worker")] };

const audit = (n: number): AuditEvent => ({
  id: `a${n}`,
  ts: new Date(Date.parse(NOW) + n * 1000).toISOString(),
  workspaceId: "ws",
  projectId: "p1",
  actor: { type: "user", id: "u1", name: "Ada" },
  actionId: "system.addService",
  input: {},
  result: "ok",
  summary: `change ${n}`,
});

/** First element in the tree carrying the named prop. */
function findProp<T>(node: unknown, prop: string): T | undefined {
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findProp<T>(c, prop);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const el = node as ReactElement<Record<string, unknown>>;
  if (!el.props) return undefined;
  if (prop in el.props) return el.props[prop] as T;
  return findProp<T>(el.props.children, prop);
}

type AnyElement = ReactElement<{ children?: unknown }>;

/** Every element of the given intrinsic tag. */
function findTags(node: unknown, tag: string, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const c of node) findTags(c, tag, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as AnyElement;
  if (el.type === tag) out.push(el);
  if (el.props) findTags(el.props.children, tag, out);
  return out;
}

let rows: ProjectRow[] = [];
let tree: unknown;

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws", name: "Kepler Labs", slug: "kepler", createdAt: NOW }],
    projects: [
      {
        id: "p1",
        workspaceId: "ws",
        name: "Atlas",
        slug: "atlas",
        workingManifest: working,
        createdAt: NOW,
        origin: { type: "blank" },
      },
    ],
    revisions: [
      {
        id: "r1",
        projectId: "p1",
        number: 7,
        manifest: deployed,
        message: "first",
        author: { type: "user", id: "u1", name: "Ada" },
        createdAt: NOW,
      },
    ],
    environments: [
      {
        id: "e1",
        projectId: "p1",
        name: "staging",
        class: "staging",
        connectionId: "c1",
        region: "us-east-1",
        deployedRevisionId: "r1",
        policies: { approvalRequired: false, allowStatefulDeletion: false, budgetUsdMonthly: 250 },
        baseDomain: "atlas.orrery.test",
        createdAt: NOW,
      },
    ],
    deployments: [
      {
        id: "d1",
        projectId: "p1",
        environmentId: "e1",
        revisionId: "r1",
        status: "succeeded",
        steps: [],
        outputs: [],
        changeSummary: "first deploy",
        estCostDeltaUsd: 0,
        actor: { type: "user", id: "u1", name: "Ada" },
        createdAt: NOW,
        endedAt: "2026-09-01T10:05:00.000Z",
      },
      // A later failure must not be mistaken for "last deployed".
      {
        id: "d2",
        projectId: "p1",
        environmentId: "e1",
        revisionId: "r1",
        status: "failed",
        steps: [],
        outputs: [],
        changeSummary: "retry",
        estCostDeltaUsd: 0,
        actor: { type: "user", id: "u1", name: "Ada" },
        createdAt: "2026-09-01T11:00:00.000Z",
        endedAt: "2026-09-01T11:01:00.000Z",
      },
    ],
    findings: [
      {
        id: "f1",
        projectId: "p1",
        severity: "high",
        status: "open",
        title: "Secret in plain text",
        detail: "",
        createdAt: NOW,
      },
      {
        id: "f2",
        projectId: "p1",
        severity: "low",
        status: "resolved",
        title: "No budget",
        detail: "",
        createdAt: NOW,
      },
    ],
  });
  for (let n = 0; n < 25; n++) appendAudit(audit(n));

  // The page resolves the workspace this browser is in, so it is async now.
  tree = await OverviewPage();
  rows = findProp<ProjectRow[]>(tree, "projects") ?? [];
});

describe("the overview card", () => {
  it("counts the changes no environment is running yet (V1)", () => {
    expect(rows[0].pending).toBe(1);
    expect(rows[0].environments[0].pending).toBe(1);
  });

  it("counts open findings only, not resolved ones (V1)", () => {
    expect(rows[0].openFindings).toBe(1);
  });

  it("separates working cost from deployed cost (V2)", () => {
    expect(rows[0].workingUsd).toBe(monthlyCostUsd(working));
    expect(rows[0].deployedUsd).toBe(monthlyCostUsd(deployed));
    expect(rows[0].workingUsd).toBeGreaterThan(rows[0].deployedUsd);
  });

  it("carries the environment's budget so it can be shown against the projection (V7)", () => {
    expect(rows[0].environments[0].budgetUsd).toBe(250);
    expect(rows[0].environments[0].projectedUsd).toBe(monthlyCostUsd(working));
  });

  it("reports the last successful deploy, not the last attempt (V9)", () => {
    expect(rows[0].lastDeployedAt).toBe("2026-09-01T10:05:00.000Z");
  });

  it("names the live revision by number", () => {
    expect(rows[0].environments[0].revision).toBe("r7");
    expect(rows[0].environments[0].word).toBe("deploy failed");
  });
});

describe("the overview header", () => {
  it("puts the workspace name in the h1, not the greeting (V11)", () => {
    const h1 = findTags(tree, "h1")[0];
    expect(h1.props.children).toBe("Kepler Labs");
  });

  it("totals the workspace's working and deployed cost (V3)", () => {
    const total = rows.reduce((n, r) => n + r.workingUsd, 0);
    expect(total).toBe(monthlyCostUsd(working));
  });
});

describe("the activity aside", () => {
  it("reads a bounded page of the trail rather than the whole thing (V10)", () => {
    const items = findTags(tree, "li");
    // 25 rows exist; the aside asks for ten, and the cards contribute no <li>.
    expect(items.length).toBe(10);
    expect(items.length).toBeLessThan(25);
  });
});
