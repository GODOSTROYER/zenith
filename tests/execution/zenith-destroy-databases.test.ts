/**
 * PROD-MAN-01: managed Zenith teardown inventories the environment's managed databases from trusted worker state and
 * attaches the inventory to the tenant session, so the provider teardown can account for (and delete) them. Contract
 * level: the provider teardown, the opener and the database port are fakes; no cluster or database provider is called.
 * NOT live evidence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { ENV, OP, REVISION, webDbManifest } from "./fakes/fixtures";
import { createRuntime } from "@/lib/execution/runtime";
import { createDestroyActivities, type DestroyProviderPorts, type TeardownInput, type TeardownResult } from "@/lib/execution/destroy";

const worlds: World[] = [];
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); vi.restoreAllMocks(); });

interface Inventory { address: string; deletionPolicy: string; approved?: boolean; externalId?: string }
const seen = (input: TeardownInput): Inventory[] | undefined =>
  (input.session as { teardown?: { databases?: Inventory[] } }).teardown?.databases;

function setup(deletionPolicy?: "allow" | "approval" | "deny") {
  const w = createWorld({ op: { capability: "infrastructure.destroy", status: "running" } }); worlds.push(w);
  w.product.base.environment.provider = "zenith";
  w.product.base.environment.deployedRevisionId = REVISION;
  const manifest = webDbManifest(); manifest.routes = []; manifest.bindings = [];
  if (deletionPolicy) (manifest.resources[0] as { config: Record<string, unknown> }).config = { deletionPolicy };
  w.product.setManifest(manifest);
  const calls: TeardownInput[] = [];
  const transport = vi.fn(async (input: TeardownInput): Promise<TeardownResult> => {
    calls.push(input);
    return { deleted: [], retained: [], skipped: [], uncertain: [] };
  });
  const ports: DestroyProviderPorts = {
    teardownZenithEnvironment: transport,
    withZenithSession: async (_input, fn) => fn({ provider: "zenith", expiresAt: "2099-01-01T00:00:00Z" }),
  };
  return { w, calls, activities: createDestroyActivities(createRuntime(w.deps), ports) };
}

describe("managed Zenith teardown: database inventory", () => {
  it("attaches a complete inventory (never an absent one) to the tenant session at review", async () => {
    const s = setup();
    await s.activities.planDestroyInfrastructure({ operationId: OP, lease: await s.w.lease() });
    const inventory = seen(s.calls[0]);
    expect(inventory, "an absent inventory is unknown to the provider teardown; it must always be attached").toBeDefined();
    expect(inventory).toHaveLength(1);
    expect(inventory![0]).toMatchObject({ deletionPolicy: "deny" });
    expect(inventory![0].address).toMatch(/postgres/);
  });

  it("is attached on apply too, with approved set only after the digest-bound human approval is re-checked", async () => {
    const s = setup("approval");
    const lease = await s.w.lease();
    const plan = await s.activities.planDestroyInfrastructure({ operationId: OP, lease });
    s.w.broker.approval = { approved: true, rejected: false, approvalId: "human-fixture" };
    await s.activities.applyDestroyInfrastructure({ operationId: OP, lease, planDigest: plan.planDigest });
    const applied = s.calls.filter((c) => !c.dryRun);
    expect(applied).toHaveLength(1);
    expect(seen(applied[0])).toEqual([expect.objectContaining({ deletionPolicy: "approval", approved: true })]);
  });

  it("never reaches the provider on apply without a human approval, so no database is ever offered for deletion", async () => {
    const s = setup("allow");
    const lease = await s.w.lease();
    const plan = await s.activities.planDestroyInfrastructure({ operationId: OP, lease });
    s.w.broker.approval = { approved: false, rejected: false, approvalId: "human-fixture" };
    await expect(s.activities.applyDestroyInfrastructure({ operationId: OP, lease, planDigest: plan.planDigest })).rejects.toThrow(/approval/);
    expect(s.calls.every((c) => c.dryRun)).toBe(true);
  });

  it("keeps the environment id in the request so the provider can refuse a session for another tenant", async () => {
    const s = setup();
    await s.activities.planDestroyInfrastructure({ operationId: OP, lease: await s.w.lease() });
    expect(s.calls[0]).toMatchObject({ environmentId: ENV, dryRun: true });
  });
});
