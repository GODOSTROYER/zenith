/**
 * One environment, one writer.
 *
 * `Environment.activeDeploymentId` is the lease. A rollback aborts the runner
 * it replaces and takes the lease before the replacement starts, so the deploy
 * it displaced can never publish its revision — not while the rollback is
 * still working, and not minutes later when its provider call finally returns.
 *
 * The provider here parks inside a step until the test opens a gate, so both
 * interleavings are pinned rather than raced: the loser finishing *during* the
 * rollback, and the loser finishing *after* it. ORRERY_FAST collapses every
 * step budget; the held step is held by the gate, never by a timer.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Deployment, Environment, ProviderId } from "@/lib/domain/types";
import type { ProviderAdapter, StepRuntime } from "@/lib/providers/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("orrery-lease-", { fast: true });
const { db, q, resetDb, save } = await import("@/lib/db/store");
const { engine, ensureEngine } = await import("@/lib/engine/engine");
const { getProvider, registerProvider } = await import("@/lib/providers/types");

/* --------------------------------- fixture -------------------------------- */

const PROVIDER: ProviderId = "azure";
const ENV_ID = "env-lease";
const FAST_A = "rev-a";
const FAST_B = "rev-b";
const SLOW = "rev-slow";

let original: ProviderAdapter;

/**
 * Revisions whose steps park until the test opens their gate. Held by revision
 * rather than by deployment id, because the deployment does not exist yet when
 * a test decides which runner has to hang — so the ticker can never win a race
 * against the setup.
 */
let held: Set<string>;
let gates: Map<string, { open: () => void; opened: Promise<void> }>;
/** Deployments whose held step ran to completion — proof it finished late. */
let finishedLate: Set<string>;

function gateFor(revisionId: string) {
  let gate = gates.get(revisionId);
  if (!gate) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gate = { open, opened };
    gates.set(revisionId, gate);
  }
  return gate;
}

/** Let every parked step of this revision return. */
const openGate = (revisionId: string) => gateFor(revisionId).open();

const environment = (): Environment => q.environment(ENV_ID)!;
const deployment = (id: string): Deployment => q.deployment(id)!;

beforeAll(() => {
  ensureEngine();
  original = getProvider(PROVIDER);

  registerProvider({
    ...original,
    displayName: "Gated Provider",
    availability: "available",
    planSteps: () => [
      { phase: "prepare", title: "Prepare", targetId: "", estMs: 10, detail: "gated.prepare" },
      { phase: "release", title: "Release", targetId: "", estMs: 10, detail: "gated.release" },
    ],
    executeStep: async (rt: StepRuntime) => {
      if (!held.has(rt.revision.id)) {
        rt.log("applied", "provider");
        return;
      }
      await gateFor(rt.revision.id).opened;
      // Everything below is a write by a runner that may well have been
      // superseded while it was in here. The engine must drop all of it.
      finishedLate.add(rt.deployment.id);
      rt.log("late log line", "provider");
      rt.output({
        key: "late",
        label: "Late output",
        value: "written after the takeover",
        kind: "text",
      });
    },
  });
});

afterAll(() => {
  for (const gate of gates.values()) gate.open();
  registerProvider(original);
});

beforeEach(() => {
  held = new Set();
  gates = new Map();
  finishedLate = new Set();
  const ts = new Date().toISOString();
  const manifest = { version: 1 as const, services: [], resources: [], routes: [], bindings: [] };
  const author = { type: "user" as const, id: "local", name: "You" };
  resetDb({
    workspaces: [{ id: "ws", name: "W", slug: "w", createdAt: ts }],
    connections: [
      {
        id: "conn-lease",
        workspaceId: "ws",
        provider: PROVIDER,
        label: "Gated",
        region: "eastus",
        status: "healthy",
        grantedPermissions: [],
        createdAt: ts,
      },
    ],
    environments: [
      {
        id: ENV_ID,
        projectId: "proj",
        name: "staging",
        class: "staging",
        connectionId: "conn-lease",
        region: "eastus",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "lease.test",
        createdAt: ts,
      },
    ],
    revisions: [
      { id: FAST_A, projectId: "proj", number: 1, manifest, message: "a", author, createdAt: ts },
      { id: FAST_B, projectId: "proj", number: 2, manifest, message: "b", author, createdAt: ts },
      { id: SLOW, projectId: "proj", number: 3, manifest, message: "slow", author, createdAt: ts },
    ],
  });
  save();
});

/* --------------------------------- helpers -------------------------------- */

const TERMINAL = ["succeeded", "failed", "cancelled", "rolled_back"];

const start = (revisionId: string) =>
  engine.start({
    projectId: "proj",
    environmentId: ENV_ID,
    revisionId,
    changeSummary: `Deploy ${revisionId}`,
    estCostDeltaUsd: 0,
    actorName: "You",
    actorId: "local",
    actorType: "user",
  });

async function until(what: string, pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function settle(deploymentId: string, ms = 10_000): Promise<Deployment> {
  await until(
    `deployment ${deploymentId} to settle`,
    () => TERMINAL.includes(deployment(deploymentId).status),
    ms
  );
  return deployment(deploymentId);
}

/** Deploy `revisionId` and wait for it to land. */
const deployed = async (revisionId: string): Promise<Deployment> =>
  settle((await start(revisionId)).id);

/** A deployment of `revisionId` parked inside its first step, holding the lease. */
async function inFlight(revisionId = SLOW): Promise<Deployment> {
  held.add(revisionId);
  const d = await start(revisionId);
  await until("the held step to start", () => deployment(d.id).steps[0].status === "running");
  return d;
}

/** Give a released step time to attempt its late writes. */
const drain = () => new Promise((r) => setTimeout(r, 250));

/** rev A live, then rev B live: a real earlier revision to roll back to. */
async function twoGoodDeploys(): Promise<void> {
  expect((await deployed(FAST_A)).status).toBe("succeeded");
  expect((await deployed(FAST_B)).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(FAST_B);
}

/* ---------------------------------- tests --------------------------------- */

test("the lease is claimed for the length of a deployment and released when it ends", async () => {
  const d = await start(FAST_A);
  expect(environment().activeDeploymentId).toBe(d.id);

  expect((await settle(d.id)).status).toBe("succeeded");
  // Released the moment the holder reached a terminal status — an environment
  // is never left leased to a deployment that has finished.
  expect(environment().activeDeploymentId).toBeUndefined();
  expect(environment().deployedRevisionId).toBe(FAST_A);
});

test("a deploy superseded by a rollback cannot commit while the rollback is still working", async () => {
  await twoGoodDeploys();
  const loser = await inFlight();
  expect(environment().activeDeploymentId).toBe(loser.id);

  // Hold the rollback's own deployment too, so the two runners are provably
  // alive at the same time — the exact overlap the lease exists to arbitrate.
  held.add(FAST_A);
  const rb = await engine.rollback(ENV_ID, FAST_A);

  // The displaced runner is off the board before the replacement starts: no
  // step left for the ticker to advance, and no lease.
  const stopped = deployment(loser.id);
  expect(stopped.status).toBe("rolling_back");
  expect(stopped.steps.some((s) => s.status === "pending" || s.status === "running")).toBe(false);
  expect(environment().activeDeploymentId).toBe(rb.id);

  await until("the rollback to reach its first step", () => deployment(rb.id).steps[0].status === "running");

  // Now the loser's provider call returns, mid-rollback. Unguarded, this is
  // where it published r3 over an environment it no longer owns.
  openGate(SLOW);
  await drain();
  expect(finishedLate.has(loser.id)).toBe(true);
  expect(environment().deployedRevisionId).toBe(FAST_B); // still the pre-rollback revision
  expect(q.revision(SLOW)?.deployedTo ?? []).not.toContain(ENV_ID);
  expect(deployment(loser.id).outputs.some((o) => o.key === "late")).toBe(false);
  expect(deployment(loser.id).status).not.toBe("succeeded");

  // The rollback holds the lease, so its own commit lands normally.
  openGate(FAST_A);
  expect((await settle(rb.id)).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(FAST_A);
  expect(deployment(loser.id).status).toBe("rolled_back");
  expect(environment().activeDeploymentId).toBeUndefined();
});

test("a superseded deploy that finishes long after the rollback landed still publishes nothing", async () => {
  await twoGoodDeploys();
  const loser = await inFlight();

  const rb = await engine.rollback(ENV_ID, FAST_A);
  expect((await settle(rb.id)).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(FAST_A);

  openGate(SLOW);
  await drain();
  expect(finishedLate.has(loser.id)).toBe(true);

  expect(environment().deployedRevisionId).toBe(FAST_A);
  expect(q.revision(SLOW)?.deployedTo ?? []).not.toContain(ENV_ID);
  expect(deployment(loser.id).outputs.some((o) => o.key === "late")).toBe(false);
  expect(deployment(loser.id).status).toBe("rolled_back");
  expect(environment().activeDeploymentId).toBeUndefined();
});

test("a deploy that takes the environment from another says which deployment took it", async () => {
  const loser = await inFlight();
  const taker = await start(FAST_B);

  const stopped = deployment(loser.id);
  expect(stopped.status).toBe("cancelled");
  expect(stopped.error).toMatch(/took over/i);
  expect(stopped.error).toContain(taker.id);
  expect(stopped.error).toMatch(/still there/i); // says what it left behind
  expect(stopped.steps.some((s) => s.status === "pending" || s.status === "running")).toBe(false);
  expect(environment().activeDeploymentId).toBe(taker.id);

  expect((await settle(taker.id)).status).toBe("succeeded");
  openGate(SLOW);
  await drain();

  expect(environment().deployedRevisionId).toBe(FAST_B);
  expect(deployment(loser.id).status).toBe("cancelled");
  expect(deployment(loser.id).outputs.some((o) => o.key === "late")).toBe(false);
});

test("cancel gives the environment back, and a late step cannot publish a cancelled deploy", async () => {
  await deployed(FAST_A);
  const cancelled = await inFlight();
  await engine.cancel(cancelled.id);

  expect(environment().activeDeploymentId).toBeUndefined();
  openGate(SLOW);
  await drain();
  expect(deployment(cancelled.id).status).toBe("cancelled");
  expect(deployment(cancelled.id).outputs.some((o) => o.key === "late")).toBe(false);
  expect(environment().deployedRevisionId).toBe(FAST_A);
});

test("a stale lease left by a killed process is reconciled, not left blocking the environment", async () => {
  const done = await deployed(FAST_A);

  // A lease naming a deployment that finished without releasing it — the
  // process was killed between the commit and the save.
  environment().activeDeploymentId = done.id;
  save();
  engine.resumeInFlight();
  expect(environment().activeDeploymentId).toBeUndefined();

  // A lease naming a deployment that is not in the store at all — its record
  // was pruned, or never written.
  environment().activeDeploymentId = "dep_ghost";
  save();
  engine.resumeInFlight();
  expect(environment().activeDeploymentId).toBeUndefined();

  // The environment is not locked out: the next deploy claims and commits.
  expect((await deployed(FAST_B)).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(FAST_B);
  expect(environment().activeDeploymentId).toBeUndefined();
});

test("a restart hands the lease back to the deployment that is genuinely still running", async () => {
  const running = await inFlight();

  // A snapshot written before the claim was saved: the runner is mid-step but
  // the environment names nobody.
  delete environment().activeDeploymentId;
  save();
  engine.resumeInFlight();
  expect(environment().activeDeploymentId).toBe(running.id);

  openGate(SLOW);
  expect((await settle(running.id)).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(SLOW);
  expect(environment().activeDeploymentId).toBeUndefined();
  expect(db().deployments.filter((d) => d.status === "succeeded")).toHaveLength(1);
});
