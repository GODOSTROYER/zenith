/**
 * Simulated health keeps a last-hour history. It is derived from the durable
 * deployment records rather than retained in memory, so it has to survive a
 * restart and repeat itself exactly.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Deployment, Environment, Manifest, Revision } from "@/lib/domain/types";
import * as fixtures from "../alerts/_fixtures";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-logsim-"));

const { resetDb } = await import("@/lib/db/store");
const { healthHistory } = await import("@/lib/logsim");

const { NOW, ago, manifest } = fixtures;

const revision = (n: number, m: Manifest): Revision => ({
  id: `rev${n}`,
  projectId: "p1",
  number: n,
  manifest: m,
  message: `r${n}`,
  author: { type: "user", id: "u1", name: "Ada" },
  createdAt: ago(200),
});

const deployment = (n: number, minutesAgo: number): Deployment =>
  ({
    id: `dep${n}`,
    projectId: "p1",
    environmentId: "env1",
    revisionId: `rev${n}`,
    status: "succeeded",
    createdAt: ago(minutesAgo),
    endedAt: ago(minutesAgo),
    steps: [],
    outputs: [],
    approved: true,
    actor: { type: "user", id: "u1", name: "Ada" },
  }) as unknown as Deployment;

const environment = {
  id: "env1",
  projectId: "p1",
  name: "sandbox",
  class: "sandbox",
  connectionId: "c1",
  region: "local",
  deployedRevisionId: "rev4",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "test",
  createdAt: ago(500),
} as unknown as Environment;

beforeAll(() => {
  resetDb({
    environments: [environment],
    revisions: [
      revision(1, manifest()), // healthy
      revision(2, manifest()), // still healthy — no transition
      revision(3, manifest("degrade")), // degraded
      revision(4, manifest(undefined, false)), // service removed
    ],
    deployments: [
      deployment(1, 90),
      deployment(2, 70),
      deployment(3, 40),
      deployment(4, 5),
    ],
  });
});

describe("healthHistory", () => {
  it("records one entry per change, not one per deployment", () => {
    const history = healthHistory("env1", "svc-api", NOW);
    expect(history.map((e) => e.status)).toEqual(["ok", "degraded", "absent"]);
    expect(history.map((e) => e.revisionNumber)).toEqual([1, 3, 4]);
  });

  it("keeps the state the window opened in, dated when it actually started", () => {
    const [opening] = healthHistory("env1", "svc-api", NOW);
    expect(opening.at).toBe(ago(90)); // outside the hour, still the state at the start
    expect(opening.reason).toContain("r1");
  });

  it("says why, every time", () => {
    for (const e of healthHistory("env1", "svc-api", NOW)) expect(e.reason).not.toBe("");
  });

  it("is deterministic — same inputs, same answer", () => {
    expect(healthHistory("env1", "svc-api", NOW)).toEqual(healthHistory("env1", "svc-api", NOW));
  });

  it("reports nothing for a service that was never deployed here", () => {
    expect(healthHistory("env1", "svc-ghost", NOW)).toEqual([]);
  });

  it("narrows to the window it is asked for", () => {
    const lastTenMinutes = healthHistory("env1", "svc-api", NOW, 10 * 60_000);
    expect(lastTenMinutes.map((e) => e.status)).toEqual(["degraded", "absent"]);
  });
});
