/**
 * A provider step that never returns must not pin a deployment in `applying`
 * forever. The engine gives every step a deadline, fails it with a message that
 * names the provider and the way out, and hands the adapter an abort signal.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Deployment, ProviderId } from "@/lib/domain/types";
import type { ProviderAdapter, StepRuntime } from "@/lib/providers/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-deadline-", { fast: true });
// Short enough to assert in a test; the product default is five minutes.
process.env.ZENITH_STEP_TIMEOUT_MS = "300";

const { db, q, resetDb } = await import("@/lib/db/store");
const { engine, ensureEngine } = await import("@/lib/engine/engine");
const { getProvider, registerProvider } = await import("@/lib/providers/types");

const HANGING: ProviderId = "kubernetes";
const ENV_ID = "env-hang";
const REV_ID = "rev-hang";

let original: ProviderAdapter;
/** true once the engine's abort signal reached the adapter */
let aborted = false;

beforeAll(() => {
  ensureEngine();
  original = getProvider(HANGING);

  registerProvider({
    ...original,
    displayName: "Hanging Provider",
    availability: "available",
    planSteps: () => [
      { phase: "prepare", title: "Wait forever", targetId: "", estMs: 10, detail: "never returns" },
    ],
    executeStep: (rt: StepRuntime) =>
      new Promise<void>(() => {
        const signal = (rt as StepRuntime & { signal?: AbortSignal }).signal;
        signal?.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  });

  const now = new Date().toISOString();
  resetDb({
    workspaces: [{ id: "ws", name: "W", slug: "w", createdAt: now }],
    connections: [
      {
        id: "conn-hang",
        workspaceId: "ws",
        provider: HANGING,
        label: "Hanging",
        region: "in-cluster",
        status: "healthy",
        grantedPermissions: [],
        createdAt: now,
      },
    ],
    environments: [
      {
        id: ENV_ID,
        projectId: "proj",
        name: "hangs",
        class: "sandbox",
        connectionId: "conn-hang",
        region: "in-cluster",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "hang.test",
        createdAt: now,
      },
    ],
    revisions: [
      {
        id: REV_ID,
        projectId: "proj",
        number: 1,
        manifest: { version: 1, services: [], resources: [], routes: [], bindings: [] },
        message: "r1",
        author: { type: "user", id: "local", name: "You" },
        createdAt: now,
      },
    ],
  });
});

afterAll(() => {
  registerProvider(original);
  delete process.env.ZENITH_STEP_TIMEOUT_MS;
});

async function settle(deploymentId: string, ms = 15_000): Promise<Deployment> {
  const until = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    if (Date.now() > until) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("a hung step fails on its deadline, naming the provider and how to change it", async () => {
  const started = await engine.start({
    projectId: "proj",
    environmentId: ENV_ID,
    revisionId: REV_ID,
    changeSummary: "hangs",
    estCostDeltaUsd: 0,
    actorName: "You",
    actorId: "local",
    actorType: "user",
  });

  const done = await settle(started.id);
  expect(done.status).toBe("failed");
  expect(done.error).toMatch(/Hanging Provider/);
  expect(done.error).toMatch(/did not finish/);
  expect(done.error).toMatch(/ZENITH_STEP_TIMEOUT_MS/);
  expect(done.steps[0].status).toBe("failed");
  // the adapter is told to stop, not merely abandoned
  expect(aborted).toBe(true);
});

test("planSteps throwing is the engine's error, not an unhandled crash", async () => {
  registerProvider({
    ...original,
    displayName: "Exploding Provider",
    availability: "available",
    planSteps: () => {
      throw new Error("cluster unreachable.");
    },
  });

  await expect(
    engine.start({
      projectId: "proj",
      environmentId: ENV_ID,
      revisionId: REV_ID,
      changeSummary: "explodes",
      estCostDeltaUsd: 0,
      actorName: "You",
      actorId: "local",
      actorType: "user",
    })
  ).rejects.toThrow(/Exploding Provider could not plan.*cluster unreachable.*Sandbox/s);

  // and nothing was recorded for a deployment that never began
  expect(db().deployments.filter((d) => d.changeSummary === "explodes")).toHaveLength(0);
});
