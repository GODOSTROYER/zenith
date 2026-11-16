/** Fake ARM HTTP contracts for all additional drivers. These tests are not live Azure evidence. */
import { afterEach, describe, expect, it } from "vitest";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { driverContext, fakeArm, sessionFor, SUB, type FakeArm } from "./_helpers";
import { moreGraph, moreWorld, MORE_ADDRESSES } from "./_more-fixtures";
import type { ResourceNode } from "@/lib/resources/types";
import type { ArmResource } from "@/lib/providers/azure/arm";

const open: FakeArm[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); });
const nodes = moreGraph();
const nodeOf = (address: string) => nodes.find((n) => n.address === address)!;
const driverOf = (n: ResourceNode) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)!;

async function setup() {
  const { world, ids } = moreWorld(nodes);
  const arm = await fakeArm([world.route()]);
  open.push(arm);
  const session = await sessionFor(arm);
  return { world, ids, arm, ctx: driverContext(session), session };
}

describe("additional drivers read the actual ARM fields", () => {
  it.each(MORE_ADDRESSES)("%s: complete observation, honest runtime/verification and contract declarations", async (address) => {
    const { ctx, arm } = await setup();
    const n = nodeOf(address);
    const d = driverOf(n);
    const obs = await d.observe!(ctx, n);
    expect(obs.presence).toBe("present");
    const expected = d.expectedAttributes!(n);
    for (const [key, value] of Object.entries(expected)) expect(obs.attributes[key], key).toMatchObject({ state: "known", value });
    const runtime = d.runtime ? await d.runtime(ctx, n) : undefined;
    const verify = await d.verify!(ctx, n, obs, runtime);
    expect(verify.status).toBe(address === "mysql/db" || address === "volume/data" ? "passed" : "unknown");
    for (const response of [obs, runtime, verify]) if (response) expect(response.simulated).toBe(false);
    expect(Object.values(d.capabilities.evidence).every((e) => e === "contract")).toBe(true);
    expect(d.capabilities.operations).toEqual([]);
    for (const request of arm.requests) {
      expect(request.method).toBe("GET");
      expect(request.query.get("api-version")).toBeTruthy();
      expect(request.pathname).not.toMatch(/listkeys|listsecrets|publishingcredentials|kube.?config/i);
    }
  });

  it.each(MORE_ADDRESSES)("%s: discovers candidates with exact native kind; no managed ownership", async (address) => {
    const { ctx, world } = await setup();
    const n = nodeOf(address);
    const d = driverOf(n);
    if (n.kind === "function") {
      const unrelated = world.add("Microsoft.Web/sites", ["web-only"], { kind: "app,linux" }, { ...n, address: "not-function" });
      Object.assign(world.tagged.find((t) => t.id === unrelated)!, { kind: "app,linux" });
    }
    const candidates = await d.discover!(ctx);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: n.kind, nativeType: n.nativeType, zenithTagged: true });
    expect(candidates[0]).not.toHaveProperty("ownership");
  });

  it.each(MORE_ADDRESSES)("%s: partial properties remain unknown and cannot pass verification", async (address) => {
    const { ctx, world, ids } = await setup();
    const n = nodeOf(address); const d = driverOf(n);
    world.patch(ids[address], (doc) => { doc.properties = {}; doc.identity = undefined; doc.sku = undefined; });
    const obs = await d.observe!(ctx, n, ids[address]);
    expect(obs.presence).toBe("present");
    expect(Object.values(obs.attributes).some((v) => v.state === "unknown")).toBe(true);
    const verified = await d.verify!(ctx, n, obs, d.runtime ? await d.runtime(ctx, n, ids[address]) : undefined);
    expect(verified.status).toBe("unknown");
    expect(verified.checks.find((c) => c.id === "configuration")?.passed).toBe("unknown");
  });
});

describe.each(MORE_ADDRESSES)("%s ARM failure contracts", (address) => {
  it.each([[404, "missing"], [403, "inaccessible"], [429, "unknown"], [500, "unknown"]] as const)("HTTP %i becomes %s, never success", async (status, presence) => {
    const { ctx, world, ids } = await setup();
    world.fail(ids[address], { status });
    const n = nodeOf(address); const d = driverOf(n);
    const obs = await d.observe!(ctx, n, ids[address]);
    expect(obs.presence).toBe(presence);
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown")).toBe(true);
    const verify = await d.verify!(ctx, n, obs);
    expect(verify.status).toBe(status === 404 ? "failed" : "unknown");
    if (d.runtime) expect((await d.runtime(ctx, n, ids[address])).health).toBe("unknown");
  });

  it("ambiguous tags never select one object", async () => {
    const { ctx, world, ids } = await setup();
    const item = world.tagged.find((t) => t.id === ids[address])!;
    world.tagged.push({ ...item, id: item.id + "-duplicate", name: item.name + "-duplicate" });
    const obs = await driverOf(nodeOf(address)).observe!(ctx, nodeOf(address));
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toContain("ambiguous");
  });

  it("missing tags, a different environment, or a different subscription never invent a match", async () => {
    const { ctx, world } = await setup();
    for (const tagged of world.tagged) tagged.tags["zenith:environment"] = "another-environment";
    const n = nodeOf(address); const d = driverOf(n);
    expect((await d.observe!(ctx, n)).presence).toBe("missing");
    const candidate = world.tagged.find((t) => t.tags["zenith:resource"] === address)!;
    expect((await d.observe!(ctx, n, candidate.id.replace(SUB, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))).presence).toBe("unknown");
  });
});

describe("unknown and security checks", () => {
  it("MySQL Entra/TLS child denial preserves the server and remains unknown", async () => {
    const { ctx, world, ids } = await setup();
    world.fail(`${ids["mysql/db"]}/configurations/aad_auth_only`, { status: 403 });
    const n = nodeOf("mysql/db"); const d = driverOf(n);
    const obs = await d.observe!(ctx, n);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.entraOnly).toEqual({ state: "unknown", reason: "access_denied" });
    const verify = await d.verify!(ctx, n, obs, await d.runtime!(ctx, n));
    expect(verify.status).toBe("unknown");
  });

  it("MySQL native auth or insecure transport fails verification", async () => {
    const { ctx, world, ids } = await setup();
    world.set(`${ids["mysql/db"]}/configurations/aad_auth_only`, { properties: { value: "OFF" } });
    world.set(`${ids["mysql/db"]}/configurations/require_secure_transport`, { properties: { value: "OFF" } });
    const n = nodeOf("mysql/db"); const d = driverOf(n);
    const obs = await d.observe!(ctx, n);
    expect(obs.attributes.entraOnly).toMatchObject({ state: "known", value: false });
    expect((await d.verify!(ctx, n, obs, await d.runtime!(ctx, n))).status).toBe("failed");
  });

  it("malformed MySQL modes stay unknown and HA health must actually be read", async () => {
    const { ctx, world, ids } = await setup();
    const n = nodeOf("mysql/db"); const d = driverOf(n);
    world.set(`${ids[n.address]}/configurations/aad_auth_only`, { properties: { value: "MALFORMED" } });
    world.patch(ids[n.address], (doc) => (doc.properties as Record<string, unknown>).highAvailability = { mode: "MALFORMED" });
    const obs = await d.observe!(ctx, n);
    expect(obs.attributes.entraOnly).toMatchObject({ state: "unknown" });
    expect(obs.attributes.highAvailability).toMatchObject({ state: "unknown" });
    expect((await d.runtime!(ctx, n)).health).toBe("unknown");
    world.patch(ids[n.address], (doc) => (doc.properties as Record<string, unknown>).highAvailability = { mode: "ZoneRedundant", state: "FailingOver" });
    expect((await d.runtime!(ctx, n)).health).toBe("degraded");
  });

  it("VM instance-view errors are unknown; no power count or health is invented", async () => {
    const { ctx, world, ids } = await setup();
    const n = nodeOf("compute_instance/machine");
    world.fail(`${ids[n.address]}/instanceView`, { status: 403 });
    expect(await driverOf(n).runtime!(ctx, n)).toMatchObject({ health: "unknown", counts: {}, signals: ["access_denied"] });
  });

  it("a public VM NIC or missing SSH deny rule fails the network check", async () => {
    const { ctx, world } = await setup();
    const n = nodeOf("compute_instance/machine"); const d = driverOf(n);
    const nicId = world.id("Microsoft.Network/networkInterfaces", "machine-nic");
    world.patch(nicId, (doc) => (doc.properties as Record<string, unknown>).ipConfigurations = [{ properties: { privateIPAddress: "10.0.0.1", publicIPAddress: { id: "/public/ip" } } }]);
    const obs = await d.observe!(ctx, n);
    const verified = await d.verify!(ctx, n, obs, await d.runtime!(ctx, n));
    expect(verified.checks.find((c) => c.id === "private_network")?.passed).toBe(false);
    expect(verified.status).toBe("failed");
    world.patch(nicId, (doc) => (doc.properties as Record<string, unknown>).ipConfigurations = [{ properties: { privateIPAddress: "10.0.0.1" } }]);
    world.patch(world.id("Microsoft.Network/networkSecurityGroups", "machine-nsg"), (doc) => (doc.properties as Record<string, unknown>).securityRules = []);
    expect((await d.verify!(ctx, n, await d.observe!(ctx, n), await d.runtime!(ctx, n))).checks.find((c) => c.id === "private_network")?.passed).toBe(false);
  });

  it("VM NIC permission failure cannot produce a successful security check", async () => {
    const { ctx, world } = await setup();
    const n = nodeOf("compute_instance/machine"); const d = driverOf(n);
    world.fail(world.id("Microsoft.Network/networkInterfaces", "machine-nic"), { status: 403 });
    const obs = await d.observe!(ctx, n);
    expect((await d.verify!(ctx, n, obs, await d.runtime!(ctx, n))).status).toBe("unknown");
  });

  it("a Web App is not labeled as a Function, even with an explicit ID", async () => {
    const { ctx, world, ids } = await setup();
    world.patch(ids["function/worker"], (doc) => doc.kind = "app,linux");
    const n = nodeOf("function/worker");
    expect((await driverOf(n).observe!(ctx, n, ids[n.address])).presence).toBe("unknown");
  });

  it.each([403, 429, 500])("discovery HTTP %i rejects rather than returning an empty success", async (status) => {
    const { ctx, world } = await setup();
    world.searchFailure = { status };
    await expect(driverOf(nodeOf("volume/data")).discover!(ctx)).rejects.toThrow();
  });

  it("a truncated tag search is unknown, and discovery does not hide truncation", async () => {
    const { ctx, world } = await setup();
    world.extra.push({ match: `/subscriptions/${SUB}/resources`, body: { value: [], nextLink: `https://management.azure.com/subscriptions/${SUB}/resources?api-version=2021-04-01` } });
    const n = nodeOf("volume/data"); const d = driverOf(n);
    expect((await d.observe!(ctx, n)).presence).toBe("unknown");
    await expect(d.discover!(ctx)).rejects.toThrow(/truncated/);
  });

  it("malformed values stay unknown, and secret-shaped native fields never escape", async () => {
    const { ctx, world, ids } = await setup();
    world.patch(ids["volume/data"], (doc) => { const p = doc.properties as Record<string, unknown>; p.diskSizeGB = "64"; p.password = "SECRET-MUST-NOT-ESCAPE"; p.apiKey = "SECRET-MUST-NOT-ESCAPE"; });
    const n = nodeOf("volume/data"); const d = driverOf(n);
    const obs = await d.observe!(ctx, n);
    expect(obs.attributes.sizeGb).toMatchObject({ state: "unknown" });
    expect(JSON.stringify(obs)).not.toContain("SECRET-MUST-NOT-ESCAPE");
    expect((await d.verify!(ctx, n, obs)).status).toBe("unknown");
  });

  it("aborted reads stop with unknown state", async () => {
    const { ctx } = await setup();
    const controller = new AbortController(); controller.abort();
    const n = nodeOf("volume/data");
    const obs = await driverOf(n).observe!({ ...ctx, signal: controller.signal }, n);
    expect(obs.presence).toBe("unknown");
  });

  it("a mismatch fails even when another attribute is unknown", async () => {
    const { ctx, world, ids } = await setup();
    world.patch(ids["volume/data"], (doc) => { const p = doc.properties as Record<string, unknown>; p.diskSizeGB = undefined; p.publicNetworkAccess = "Enabled"; });
    const n = nodeOf("volume/data"); const d = driverOf(n);
    expect((await d.verify!(ctx, n, await d.observe!(ctx, n))).status).toBe("failed");
  });

  it("SWA bindings are checked against the site instead of the Container Apps asuid TXT", async () => {
    const { ctx, world, ids } = await setup();
    const n = nodeOf("dns_record/docs.example.com"); const d = driverOf(n);
    const zone = world.add("Microsoft.Network/dnszones", ["example.com"], {});
    world.setList(`/subscriptions/${SUB}/providers/Microsoft.Network/dnszones`, [{ id: zone, name: "example.com" }]);
    world.set(`${zone}/CNAME/docs`, { properties: { TTL: 300 } });
    world.set(`${ids["static_site/docs"]}/customDomains/docs.example.com`, { properties: { status: "Ready" } });
    const observation = await d.observe!(ctx, n);
    expect((await d.verify!(ctx, n, observation)).status).toBe("passed");
  });

  it("fake ARM documents are wire shapes, not synthesized driver expectedAttributes", () => {
    const { world, ids } = moreWorld(nodes);
    const disk = world.docs.get(ids["volume/data"].toLowerCase()) as ArmResource;
    expect(disk.properties).toHaveProperty("diskSizeGB", 64);
    expect(disk.properties).not.toHaveProperty("sizeGb");
  });
});
