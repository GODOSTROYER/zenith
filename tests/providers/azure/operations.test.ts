import { afterEach, describe, expect, it } from "vitest";
import type { AzureSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { driverContext, fakeArm, fakeEntra, sampleGraph, sessionFor, SUB, type FakeArm } from "./_helpers";
import { buildWorld, RG, type World } from "./_world";

const open: FakeArm[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const nodes = sampleGraph();
const node = (a: string) => nodes.find((n) => n.address === a)!;
const driverOf = (n: ResourceNode) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)! as ResourceDriver<AzureSession>;
const APP = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/zn-k3x9q2-web`;

async function setup(world: World = buildWorld(nodes)) {
  const arm = await fakeArm([world.route()], fakeEntra());
  open.push(arm);
  const session = await sessionFor(arm, undefined, "deploy");
  const ctx = (over = {}) => driverContext(session, { fence: { scope: "env:env_azure_1", token: 42 }, ...over }) as never;
  return { world, arm, ctx };
}

const mutations = (arm: FakeArm) => arm.requests.filter((r) => r.method !== "GET");

describe("operations are declared by catalog capability name", () => {
  it("only names that exist in the capability catalog, each mutating one a real operation", () => {
    const declared = AZURE_DRIVERS.flatMap((d) => Object.keys(d.operations ?? {}));
    expect(declared.sort()).toEqual(["database.snapshot", "service.restart", "service.scale"]);
    for (const name of declared) expect(Object.keys(CAPABILITIES)).toContain(name);
    for (const d of AZURE_DRIVERS) expect(d.capabilities.operations.sort()).toEqual(Object.keys(d.operations ?? {}).sort());
  });
});

describe("service.restart", () => {
  const web = node("container_service/web");
  const restart = driverOf(web).operations!["service.restart"];

  function restartRoutes(world: World, status = 200, extra: Record<string, string> = {}) {
    world.extra.push({ method: "POST", match: (p) => p.toLowerCase().endsWith("/restart"), handler: () => ({ status, body: status === 200 ? {} : { error: { code: status === 429 ? "TooManyRequests" : "AuthorizationFailed", message: "no" } }, headers: extra }) });
  }

  it("restarts the ACTIVE revision only, tagging the request with the operation id and fence token", async () => {
    const { ctx, arm, world } = await setup();
    restartRoutes(world);
    const r = await restart(ctx(), web, {});
    expect(r).toMatchObject({ ok: true, simulated: false, data: { revisions: ["zn-k3x9q2-web--r1"] } });
    const posts = mutations(arm);
    expect(posts).toHaveLength(1);
    expect(posts[0].pathname).toBe(`${APP}/revisions/zn-k3x9q2-web--r1/restart`);
    expect(posts[0].query.get("api-version")).toBe("2024-03-01");
    expect(posts[0].authorization).toMatch(/^Bearer /);
    expect(r.requestIds).toContain("req-fake-1");
  });

  it("is idempotent: running it twice restarts the same revision the same way", async () => {
    const { ctx, arm, world } = await setup();
    restartRoutes(world);
    const a = await restart(ctx(), web, {});
    const b = await restart(ctx(), web, {});
    expect(a.data).toEqual(b.data);
    expect(mutations(arm).map((m) => m.pathname)).toEqual([`${APP}/revisions/zn-k3x9q2-web--r1/restart`, `${APP}/revisions/zn-k3x9q2-web--r1/restart`]);
  });

  it("a requested revision must be one of the active ones; nothing from the input reaches a URL", async () => {
    const { ctx, arm, world } = await setup();
    restartRoutes(world);
    for (const revision of ["zn-k3x9q2-web--r0", "../../../../secrets", "x/restart?", "zn-k3x9q2-web--r1/../r0"]) {
      const r = await restart(ctx(), web, { revision });
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/not an active revision/);
    }
    expect(mutations(arm)).toHaveLength(0);
    expect((await restart(ctx(), web, { revision: "zn-k3x9q2-web--r1" })).ok).toBe(true);
  });

  it("refuses a target that is not this environment's Zenith-managed object, before any mutation", async () => {
    for (const patch of [
      (t: Record<string, string>) => (t["zenith:environment"] = "env_other"),
      (t: Record<string, string>) => (t["zenith:managed"] = "false"),
      (t: Record<string, string>) => (t["zenith:resource"] = "container_service/other"),
    ]) {
      const { ctx, arm, world } = await setup();
      restartRoutes(world);
      world.patch(APP, (doc) => patch(doc.tags as Record<string, string>));
      // by externalId the tag check is what protects: the search would not have found it
      const r = await restart(ctx(), web, { externalId: APP });
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/Refusing to restart/);
      expect(mutations(arm)).toHaveLength(0);
    }
  });

  it("reports a missing target, permission errors and throttling as failed results, never as exceptions", async () => {
    const { ctx, world } = await setup();
    restartRoutes(world, 403);
    const denied = await restart(ctx(), web, {});
    expect(denied).toMatchObject({ ok: false, data: { kind: "forbidden", status: 403 } });
    const s2 = await setup();
    restartRoutes(s2.world, 429, { "retry-after": "9" });
    expect(await restart(s2.ctx(), web, {})).toMatchObject({ ok: false, data: { kind: "throttled", retryAfterSec: 9 } });
    const s3 = await setup();
    s3.world.tagged.length = 0;
    expect((await restart(s3.ctx(), web, {})).summary).toMatch(/missing/);
    const s4 = await setup();
    s4.world.setList(`${APP}/revisions`, []);
    expect((await restart(s4.ctx(), web, {})).summary).toMatch(/no active revision/);
  });
});

describe("service.scale", () => {
  const web = node("container_service/web");
  const scale = driverOf(web).operations!["service.scale"];

  function patchRoute(world: World, status = 200, headers: Record<string, string> = {}) {
    world.extra.push({ method: "PATCH", match: (p) => p.toLowerCase() === APP.toLowerCase(), handler: () => ({ status, body: status === 200 ? { properties: { provisioningState: "Succeeded" } } : undefined, headers }) });
  }

  it("sends a JSON merge patch that changes only the scale bounds (and keeps max >= min)", async () => {
    const { ctx, arm, world } = await setup();
    patchRoute(world);
    const r = await scale(ctx(), web, { replicas: 4 });
    expect(r).toMatchObject({ ok: true, data: { minReplicas: 4, maxReplicas: 4, previousMinReplicas: 2 } });
    const [p] = mutations(arm);
    expect(p.method).toBe("PATCH");
    expect(p.pathname).toBe(APP);
    expect(p.query.get("api-version")).toBe("2024-03-01");
    expect(JSON.parse(p.body)).toEqual({ location: "westeurope", properties: { template: { scale: { minReplicas: 4, maxReplicas: 4 } } } });
    // the body never touches containers, secrets, ingress or tags (tags are a whole-map attribute and would surface as drift)
    expect(p.body).not.toMatch(/containers|secret|ingress|tags|identity/);
  });

  it("an explicit maxReplicas is honoured; an existing larger max is kept", async () => {
    const { ctx, arm, world } = await setup();
    patchRoute(world);
    await scale(ctx(), web, { replicas: 3, maxReplicas: 9 });
    expect(JSON.parse(mutations(arm)[0].body).properties.template.scale).toEqual({ minReplicas: 3, maxReplicas: 9 });
    const s = await setup();
    s.world.patch(APP, (doc) => ((doc.properties as { template: { scale: { maxReplicas: number } } }).template.scale.maxReplicas = 20));
    patchRoute(s.world);
    await scale(s.ctx(), web, { replicas: 3 });
    expect(JSON.parse(mutations(s.arm)[0].body).properties.template.scale).toEqual({ minReplicas: 3, maxReplicas: 20 });
  });

  it("validates input before any call", async () => {
    const { ctx, arm, world } = await setup();
    patchRoute(world);
    for (const input of [{}, { replicas: 0 }, { replicas: -1 }, { replicas: 301 }, { replicas: 2.5 }, { replicas: "3" }, { replicas: NaN }, { replicas: 5, maxReplicas: 3 }, { replicas: 2, maxReplicas: "x" }, { replicas: 2, maxReplicas: 1001 }]) {
      const r = await scale(ctx(), web, input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
    }
    expect(arm.requests).toHaveLength(0);
  });

  it("refuses an object that is not this environment's managed resource", async () => {
    const { ctx, arm, world } = await setup();
    patchRoute(world);
    world.patch(APP, (doc) => ((doc.tags as Record<string, string>)["zenith:environment"] = "env_other"));
    const r = await scale(ctx(), web, { replicas: 3, externalId: APP });
    expect(r.ok).toBe(false);
    expect(mutations(arm)).toHaveLength(0);
  });

  it("follows a 202 to completion within a bound; a failed or off-host operation is not reported as done", async () => {
    const s1 = await setup();
    s1.world.extra.push({ method: "PATCH", match: APP, handler: () => ({ status: 202, headers: { "azure-asyncoperation": `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappOperationResults/op1?api-version=2024-03-01` } }) });
    s1.world.set(`/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappOperationResults/op1`, { status: "Succeeded" });
    expect(await scale(s1.ctx(), web, { replicas: 3 })).toMatchObject({ ok: true, data: { operation: "succeeded" } });

    const s2 = await setup();
    s2.world.extra.push({ method: "PATCH", match: APP, handler: () => ({ status: 202, headers: { "azure-asyncoperation": `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappOperationResults/op2?api-version=2024-03-01` } }) });
    s2.world.set(`/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappOperationResults/op2`, { status: "Failed", error: { message: "quota exceeded" } });
    const failed = await scale(s2.ctx(), web, { replicas: 3 });
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain("quota exceeded");

    const s3 = await setup();
    s3.world.extra.push({ method: "PATCH", match: APP, handler: () => ({ status: 202, headers: { "azure-asyncoperation": "https://evil.example/poll?api-version=1" } }) });
    const offHost = await scale(s3.ctx(), web, { replicas: 3 });
    expect(offHost.ok).toBe(true);
    expect(offHost.summary).toMatch(/completion not confirmed/);
    expect(s3.arm.requests.some((r) => r.pathname.includes("poll"))).toBe(false);
  });

  it("surfaces ARM errors as failed results with the provider request id", async () => {
    const { ctx, world } = await setup();
    patchRoute(world, 409);
    const r = await scale(ctx(), web, { replicas: 3 });
    expect(r).toMatchObject({ ok: false, data: { kind: "conflict" } });
    expect(r.requestIds).toContain("req-fake-1");
  });
});

describe("database.snapshot", () => {
  const db = node("postgres/db");
  const snapshot = driverOf(db).operations!["database.snapshot"];
  const DB = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.DBforPostgreSQL/flexibleServers/zn-k3x9q2-db-pg`;

  it("creates an on-demand backup named from the operation id (same id, same name)", async () => {
    const { ctx, arm, world } = await setup();
    world.extra.push({ method: "PUT", match: (p) => p.toLowerCase().startsWith(`${DB.toLowerCase()}/backups/`), handler: () => ({ status: 201, body: { properties: {} } }) });
    const r = await snapshot(ctx({ operationId: "Op_ABC.123" }), db, {});
    expect(r).toMatchObject({ ok: true, data: { backup: "zenith-op-abc-123" } });
    const [put] = mutations(arm);
    expect(put.pathname).toBe(`${DB}/backups/zenith-op-abc-123`);
    expect(put.query.get("api-version")).toBe("2024-08-01");
  });

  it("an existing backup of the same name is the desired end state; other errors are failed results", async () => {
    const s = await setup();
    s.world.extra.push({ method: "PUT", match: (p) => p.includes("/backups/"), status: 409, body: { error: { code: "BackupAlreadyExists", message: "exists" } } });
    expect(await snapshot(s.ctx(), db, {})).toMatchObject({ ok: true, data: { operation: "exists" } });
    const t = await setup();
    t.world.extra.push({ method: "PUT", match: (p) => p.includes("/backups/"), status: 403, body: { error: { code: "AuthorizationFailed", message: "no" } } });
    expect(await snapshot(t.ctx(), db, {})).toMatchObject({ ok: false, data: { kind: "forbidden" } });
  });

  it("refuses an unmanaged target", async () => {
    const { ctx, arm, world } = await setup();
    world.patch(DB, (doc) => ((doc.tags as Record<string, string>)["zenith:managed"] = "false"));
    const r = await snapshot(ctx(), db, { externalId: DB });
    expect(r.ok).toBe(false);
    expect(mutations(arm)).toHaveLength(0);
  });
});
