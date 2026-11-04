/**
 * A rollback marks the deployment it is undoing `rolling_back`. That status is
 * not terminal, so it is only ever left by the rollback landing (`rolled_back`)
 * or — before this suite — by the rollback *failing*. A rollback that ended any
 * other way was forgotten: cancelled by an operator, displaced by a newer
 * deploy that took the environment, or lost with its record across a restart.
 * The origin stayed `rolling_back` for good, the Deploys page showed a rollback
 * in progress that nobody was running, and nothing could clear it.
 *
 * The rules pinned here:
 *   - the rollback deployment records what its origin was (`rollbackOfPreviousStatus`);
 *   - a rollback that ends without succeeding gives the origin that status back —
 *     a `succeeded`/`failed` origin was never touched by a rollback that did not
 *     land, so it goes back exactly as it was;
 *   - an origin that was still in flight when the rollback stopped it cannot be
 *     put back in flight (its steps were skipped), so it is `cancelled`, with the
 *     reason on the record;
 *   - an origin whose previous status is not known is `failed`, saying so;
 *   - `resumeInFlight` repairs whatever a crash left behind.
 *
 * The provider parks inside a step until the test opens its gate, the same way
 * tests/engine/environment-lease.test.ts does, so each interleaving is pinned
 * rather than raced.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { Deployment, DeploymentStatus, Environment, ProviderId } from "@/lib/domain/types";
import type { ProviderAdapter, StepRuntime } from "@/lib/providers/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-rb-origin-", { fast: true });
const { db, q, resetDb, save } = await import("@/lib/db/store");
const { engine, ensureEngine } = await import("@/lib/engine/engine");
const { getProvider, registerProvider } = await import("@/lib/providers/types");

/* --------------------------------- fixture -------------------------------- */

const PROVIDER: ProviderId = "azure";
const ENV_ID = "env-rb";
const REV_A = "rev-a";
const REV_B = "rev-b";
const SLOW = "rev-slow";

let original: ProviderAdapter;
/** Revisions whose steps park until their gate opens. */
let held: Set<string>;
/** Revisions whose steps throw. */
let failing: Set<string>;
let gates: Map<string, { open: () => void; opened: Promise<void> }>;

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
const openGate = (revisionId: string) => gateFor(revisionId).open();

const environment = (): Environment => q.environment(ENV_ID)!;
const deployment = (id: string): Deployment => q.deployment(id)!;
type Stored = Deployment & { rollbackOf?: string; rollbackOfPreviousStatus?: DeploymentStatus };
const stored = (id: string): Stored => deployment(id) as Stored;

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
      if (failing.has(rt.revision.id)) throw new Error(`provider refused ${rt.revision.id}`);
      if (held.has(rt.revision.id)) await gateFor(rt.revision.id).opened;
      rt.log("applied", "provider");
    },
  });
});

afterAll(() => {
  for (const gate of gates.values()) gate.open();
  registerProvider(original);
});

beforeEach(() => {
  held = new Set();
  failing = new Set();
  gates = new Map();
  const ts = new Date().toISOString();
  const manifest = { version: 1 as const, services: [], resources: [], routes: [], bindings: [] };
  const author = { type: "user" as const, id: "local", name: "You" };
  resetDb({
    workspaces: [{ id: "ws", name: "W", slug: "w", createdAt: ts }],
    connections: [
      {
        id: "conn-rb",
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
        connectionId: "conn-rb",
        region: "eastus",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "rb.test",
        createdAt: ts,
      },
    ],
    revisions: [
      { id: REV_A, projectId: "proj", number: 1, manifest, message: "a", author, createdAt: ts },
      { id: REV_B, projectId: "proj", number: 2, manifest, message: "b", author, createdAt: ts },
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

async function settle(deploymentId: string): Promise<Deployment> {
  await until(`deployment ${deploymentId} to settle`, () => TERMINAL.includes(deployment(deploymentId).status));
  return deployment(deploymentId);
}

const deployed = async (revisionId: string): Promise<Deployment> => settle((await start(revisionId)).id);

/** Give a released step time to attempt its late writes. */
const drain = () => new Promise((r) => setTimeout(r, 250));

/** A rollback parked inside its first step, so it is provably in flight. */
async function heldRollback(toRevisionId: string): Promise<Deployment> {
  held.add(toRevisionId);
  const rb = await engine.rollback(ENV_ID, toRevisionId);
  await until("the rollback's first step to start", () => deployment(rb.id).steps[0].status === "running");
  return rb;
}

/** r1 live, then r2 live. Returns the deployment that put r2 live — the one a rollback to r1 undoes. */
async function twoGoodDeploys(): Promise<Deployment> {
  expect((await deployed(REV_A)).status).toBe("succeeded");
  const b = await deployed(REV_B);
  expect(b.status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(REV_B);
  return b;
}

const nothingRollingBack = () =>
  expect(db().deployments.filter((d) => d.status === "rolling_back").map((d) => d.id)).toEqual([]);

/* ---------------------------------- tests --------------------------------- */

test("the rollback records the status its origin had when it started", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);

  expect(stored(rb.id).rollbackOf).toBe(origin.id);
  expect(stored(rb.id).rollbackOfPreviousStatus).toBe("succeeded");
  expect(deployment(origin.id).status).toBe("rolling_back");

  openGate(REV_A);
  expect((await settle(rb.id)).status).toBe("succeeded");
  expect(deployment(origin.id).status).toBe("rolled_back");
});

test("a cancelled rollback gives a succeeded origin its status back", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);

  await engine.cancel(rb.id);

  expect(deployment(rb.id).status).toBe("cancelled");
  expect(deployment(origin.id).status).toBe("succeeded");
  // The rollback never landed: the environment still runs what the origin put there.
  expect(environment().deployedRevisionId).toBe(REV_B);
  expect(environment().activeDeploymentId).toBeUndefined();
  nothingRollingBack();

  openGate(REV_A);
  await drain();
  expect(environment().deployedRevisionId).toBe(REV_B);
  expect(deployment(origin.id).status).toBe("succeeded");
});

test("a cancelled rollback gives a failed origin its failure back, with the error it had", async () => {
  expect((await deployed(REV_A)).status).toBe("succeeded");
  failing.add(REV_B);
  const bad = await deployed(REV_B);
  expect(bad.status).toBe("failed");
  const error = bad.error;
  expect(error).toBeTruthy();
  failing.delete(REV_B);

  const rb = await heldRollback(REV_A);
  expect(deployment(bad.id).status).toBe("rolling_back");
  await engine.cancel(rb.id);

  expect(deployment(bad.id).status).toBe("failed");
  expect(deployment(bad.id).error).toBe(error);
  nothingRollingBack();
  openGate(REV_A);
});

test("a rollback that fails leaves a succeeded origin succeeded, not failed", async () => {
  const origin = await twoGoodDeploys();
  failing.add(REV_A);

  const rb = await engine.rollback(ENV_ID, REV_A);
  expect((await settle(rb.id)).status).toBe("failed");

  expect(deployment(origin.id).status).toBe("succeeded");
  expect(environment().deployedRevisionId).toBe(REV_B);
  nothingRollingBack();
});

test("a rollback superseded by a newer deploy gives its origin its status back", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);

  const taker = await start(REV_B);
  expect(deployment(rb.id).status).toBe("cancelled");
  expect(deployment(rb.id).error).toMatch(/took over/i);
  expect(deployment(origin.id).status).toBe("succeeded");
  nothingRollingBack();

  expect((await settle(taker.id)).status).toBe("succeeded");
  openGate(REV_A);
  await drain();
  expect(environment().deployedRevisionId).toBe(REV_B);
  expect(deployment(origin.id).status).toBe("succeeded");
});

test("a rollback cancelled while it waits for approval gives its origin its status back", async () => {
  const origin = await twoGoodDeploys();
  environment().policies.approvalRequired = true;
  save();

  const rb = await engine.rollback(ENV_ID, REV_A);
  expect(rb.status).toBe("awaiting_approval");
  expect(deployment(origin.id).status).toBe("rolling_back");

  await engine.cancel(rb.id);

  expect(deployment(rb.id).status).toBe("cancelled");
  expect(deployment(origin.id).status).toBe("succeeded");
  nothingRollingBack();
});

test("an origin that was still running when the rollback stopped it becomes cancelled, saying why", async () => {
  held.add(SLOW);
  const origin = await start(SLOW);
  await until("the held step to start", () => deployment(origin.id).steps[0].status === "running");

  const rb = await heldRollback(REV_A);
  expect(stored(rb.id).rollbackOfPreviousStatus).toBe("applying");
  expect(deployment(origin.id).status).toBe("rolling_back");

  await engine.cancel(rb.id);

  const after = deployment(origin.id);
  // Not put back in flight: its steps were skipped and its runner aborted.
  expect(after.status).toBe("cancelled");
  expect(after.error).toMatch(/rollback/i);
  expect(after.error).toMatch(/roll back|deploy again/i); // names the way forward
  expect(after.steps.some((s) => s.status === "pending" || s.status === "running")).toBe(false);
  nothingRollingBack();

  openGate(SLOW);
  openGate(REV_A);
  await drain();
  expect(deployment(origin.id).status).toBe("cancelled");
  expect(environment().deployedRevisionId).toBeUndefined();
});

test("a rollback displaced by a later rollback that lands takes its origin with it", async () => {
  const origin = await twoGoodDeploys();
  const first = await heldRollback(REV_A);

  // The second rollback puts r2 back. It stops the first, which is why the
  // first is `rolling_back` rather than terminal until this one lands.
  const second = await engine.rollback(ENV_ID, REV_B);
  expect(stored(second.id).rollbackOf).toBe(first.id);
  expect(deployment(first.id).status).toBe("rolling_back");
  expect(deployment(origin.id).status).toBe("rolling_back");

  expect((await settle(second.id)).status).toBe("succeeded");
  expect(deployment(first.id).status).toBe("rolled_back");
  expect(deployment(origin.id).status).toBe("rolled_back");
  nothingRollingBack();
  openGate(REV_A);
});

test("a later rollback that fails unwinds the whole chain to where it started", async () => {
  const origin = await twoGoodDeploys();
  const first = await heldRollback(REV_A);
  failing.add(REV_B);

  const second = await engine.rollback(ENV_ID, REV_B);
  expect((await settle(second.id)).status).toBe("failed");

  // The first rollback was running when it was displaced: it cannot resume.
  expect(deployment(first.id).status).toBe("cancelled");
  expect(deployment(origin.id).status).toBe("succeeded");
  nothingRollingBack();
  openGate(REV_A);
});

/* ------------------------------ restart repair ---------------------------- */

test("resumeInFlight repairs an origin whose rollback ended without ever restoring it", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);

  // What a pre-fix process left behind: the rollback is over, the origin was
  // never told. (Written straight to the record, as a crash would leave it.)
  const record = deployment(rb.id);
  record.status = "cancelled";
  for (const s of record.steps) if (s.status === "pending" || s.status === "running") s.status = "skipped";
  delete environment().activeDeploymentId;
  save();
  expect(deployment(origin.id).status).toBe("rolling_back");

  engine.resumeInFlight();

  expect(deployment(origin.id).status).toBe("succeeded");
  nothingRollingBack();
  openGate(REV_A);
});

test("resumeInFlight marks the origin rolled_back when its rollback did land", async () => {
  const origin = await twoGoodDeploys();
  const rb = await deployed(REV_A); // an ordinary deployment, then made a rollback of `origin` by hand
  (rb as Stored).rollbackOf = origin.id;
  deployment(origin.id).status = "rolling_back";
  save();

  engine.resumeInFlight();

  expect(deployment(origin.id).status).toBe("rolled_back");
});

test("resumeInFlight leaves an origin alone while its rollback is still running", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);

  engine.resumeInFlight();

  expect(deployment(origin.id).status).toBe("rolling_back");
  expect(deployment(rb.id).status).toBe("applying");
  openGate(REV_A);
  expect((await settle(rb.id)).status).toBe("succeeded");
  expect(deployment(origin.id).status).toBe("rolled_back");
});

test("resumeInFlight fails an origin whose rollback record is gone, and says what it could not know", async () => {
  const origin = await twoGoodDeploys();
  deployment(origin.id).status = "rolling_back"; // no deployment names it as its origin
  save();

  engine.resumeInFlight();

  const after = deployment(origin.id);
  expect(after.status).toBe("failed");
  expect(after.error).toMatch(/rollback/i);
  expect(after.error).toMatch(/roll back|deploy again/i);
  expect(after.endedAt).toBeTruthy();
});

test("resumeInFlight fails an origin whose rollback predates the recorded previous status", async () => {
  const origin = await twoGoodDeploys();
  const rb = await heldRollback(REV_A);
  const record = deployment(rb.id) as Stored;
  record.status = "cancelled";
  delete record.rollbackOfPreviousStatus; // a record written before the field existed
  for (const s of record.steps) if (s.status === "pending" || s.status === "running") s.status = "skipped";
  delete environment().activeDeploymentId;
  save();

  engine.resumeInFlight();

  const after = deployment(origin.id);
  expect(after.status).toBe("failed");
  expect(after.error).toMatch(/rollback/i);
  nothingRollingBack();
  openGate(REV_A);
});
