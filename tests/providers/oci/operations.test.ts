/**
 * Day-two operations: secret.write (the one call that carries a secret),
 * service.restart, database.snapshot, firewall.inspect. Each is idempotent per
 * operation id, re-checks the Zenith tags before acting, returns bounded
 * model-safe data, and never echoes a secret.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { syncSecretValue, versionNameFor, MAX_SECRET_BYTES } from "@/lib/providers/oci/ops/secret-sync";
import { driverContext, driverFor, err, expandOci, FakeOci, json, nodeOf, ocid, zenithTagsFor } from "./_support";
import { healthyWorld } from "./_world";
import { ociDrivers } from "@/lib/providers/oci/drivers";

const graph = expandOci();
const secretNode = graph.nodes.find((n) => n.address.startsWith("secret/session-secret"))!;
const web = nodeOf(graph, "container_service/web");
const db = nodeOf(graph, "postgres/db");
const CANARY = "S3CR3T-canary-value-91c4f0";

const secretOp = (ctx: ReturnType<typeof driverContext>, input: Record<string, unknown>) => driverFor(secretNode).operations!["secret.write"](ctx, secretNode, input);
const putCalls = (oci: FakeOci) => oci.calls.filter((c) => c.method === "PUT");

describe("every declared operation is a catalog capability with an implementation", () => {
  it("operations ⊆ CAPABILITIES, evidence is contract, and keys match the declaration", () => {
    for (const d of ociDrivers) {
      expect(Object.keys(d.operations ?? {}).sort(), d.id).toEqual([...d.capabilities.operations].sort());
      for (const op of d.capabilities.operations) {
        expect(Object.keys(CAPABILITIES), `${d.id} ${op}`).toContain(op);
        expect(d.capabilities.evidence[op]).toBe("contract");
      }
    }
  });
});

describe("secret.write", () => {
  it("writes a new CURRENT version through the transport and leaks the value nowhere else", async () => {
    const world = healthyWorld(graph);
    const logged: string[] = [];
    const ctx = driverContext(world.oci, { log: (l) => logged.push(l) });
    const result = await secretOp(ctx, { resolveValue: () => CANARY });
    expect(result).toMatchObject({ ok: true, simulated: false });
    const puts = putCalls(world.oci);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ service: "vault", method: "PUT", path: `/20180608/secrets/${world.ids.get(secretNode.address)}` });
    const body = puts[0].body as { secretContent: { contentType: string; content: string; name: string; stage: string } };
    expect(body.secretContent).toMatchObject({ contentType: "BASE64", stage: "CURRENT", name: versionNameFor("op_test_1") });
    expect(Buffer.from(body.secretContent.content, "base64").toString("utf8")).toBe(CANARY);
    // the value (plain or base64) is in the PUT body and NOWHERE else
    const everythingElse = JSON.stringify([result, logged, world.oci.calls.filter((c) => c.method !== "PUT")]);
    expect(everythingElse).not.toContain(CANARY);
    expect(everythingElse).not.toContain(Buffer.from(CANARY).toString("base64"));
    expect(JSON.stringify(result)).not.toMatch(/sha|digest|hash/i);
    expect(result.data).toEqual({ bytes: Buffer.byteLength(CANARY) });
  });

  it("the version name is stable per operation and different across operations, and is not derived from the value", () => {
    expect(versionNameFor("op-1")).toBe(versionNameFor("op-1"));
    expect(versionNameFor("op-1")).not.toBe(versionNameFor("op-2"));
    expect(versionNameFor("op-1")).toMatch(/^zenith-[0-9a-f]{20}$/);
  });

  it("a retry of the same operation that OCI answers with 409 reports `already applied`", async () => {
    const world = healthyWorld(graph);
    world.oci.route("PUT", /^\/20180608\/secrets\//, err(409, "Conflict", `version already exists for ${CANARY}`));
    const r = await secretOp(driverContext(world.oci), { resolveValue: () => CANARY });
    expect(r).toMatchObject({ ok: true, data: { alreadyApplied: true } });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("OCI's error text is never echoed (it could repeat the request); only status and code", async () => {
    for (const status of [400, 403, 429, 500]) {
      const world = healthyWorld(graph);
      world.oci.route("PUT", /^\/20180608\/secrets\//, err(status, "SomeCode", `bad value ${CANARY}`));
      const r = await secretOp(driverContext(world.oci), { resolveValue: () => CANARY });
      expect(r.ok, String(status)).toBe(false);
      expect(r.summary).toMatch(new RegExp(`HTTP ${status}`));
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });

  it("refuses when the container is missing, not tagged for this node, or unreadable — and never writes", async () => {
    const empty = new FakeOci().on(() => json({ items: [] }));
    expect((await secretOp(driverContext(empty), { resolveValue: () => CANARY })).ok).toBe(false);
    expect(putCalls(empty)).toEqual([]);

    const foreignId = ocid("vaultsecret", "foreign");
    const foreign = new FakeOci()
      .route("GET", "/20180608/secrets", json([{ id: foreignId, lifecycleState: "ACTIVE", freeformTags: zenithTagsFor("secret/someone-else") }]))
      .route("GET", `/20180608/secrets/${foreignId}`, json({ id: foreignId, lifecycleState: "ACTIVE", freeformTags: zenithTagsFor("secret/someone-else") }));
    const viaId = await driverFor(secretNode).operations!["secret.write"](driverContext(foreign), secretNode, { resolveValue: () => CANARY, externalId: foreignId });
    // even with an OCID in hand, an object that is not this node's is refused
    expect(viaId.ok).toBe(false);
    expect(putCalls(foreign)).toEqual([]);

    const denied = new FakeOci().on(() => err(403, "NotAuthenticated"));
    expect((await secretOp(driverContext(denied), { resolveValue: () => CANARY })).ok).toBe(false);
    expect(putCalls(denied)).toEqual([]);
  });

  it("refuses a value passed as input, a missing resolver, an empty or oversize value, a resolver that throws, and a missing operation id", async () => {
    const world = healthyWorld(graph);
    const ctx = driverContext(world.oci);
    expect((await secretOp(ctx, { value: CANARY })).summary).toMatch(/resolveValue\(\), not a value/);
    expect((await secretOp(ctx, {})).summary).toMatch(/needs a resolveValue/);
    expect((await secretOp(ctx, { resolveValue: () => "" })).summary).toMatch(/empty/);
    expect((await secretOp(ctx, { resolveValue: () => "x".repeat(MAX_SECRET_BYTES + 1) })).summary).toMatch(/at most 25600/);
    const thrown = await secretOp(ctx, { resolveValue: () => { throw new Error(`vault lookup failed for ${CANARY}`); } });
    expect(thrown.ok).toBe(false);
    expect(JSON.stringify(thrown)).not.toContain(CANARY);
    expect((await secretOp(driverContext(world.oci, { operationId: undefined }), { resolveValue: () => CANARY })).summary).toMatch(/idempotency key/);
    expect(putCalls(world.oci)).toEqual([]);
    // exactly at the limit is fine
    expect((await secretOp(ctx, { resolveValue: () => "y".repeat(MAX_SECRET_BYTES) })).ok).toBe(true);
  });

  it("supports an async resolver and multi-byte values (size is in bytes)", async () => {
    const world = healthyWorld(graph);
    const r = await secretOp(driverContext(world.oci), { resolveValue: async () => "é".repeat(100) });
    expect(r).toMatchObject({ ok: true, data: { bytes: 200 } });
    const big = await secretOp(driverContext(world.oci), { resolveValue: () => "é".repeat(MAX_SECRET_BYTES / 2 + 1) });
    expect(big.ok).toBe(false);
  });

  it("is exported as a helper that behaves identically", async () => {
    const world = healthyWorld(graph);
    const r = await syncSecretValue(driverContext(world.oci), { node: secretNode, resolveValue: () => CANARY, idempotencyKey: "op-x" });
    expect(r.ok).toBe(true);
    expect((putCalls(world.oci)[0].body as { secretContent: { name: string } }).secretContent.name).toBe(versionNameFor("op-x"));
  });
});

describe("service.restart", () => {
  const restart = (ctx: ReturnType<typeof driverContext>) => driverFor(web).operations!["service.restart"](ctx, web, {});
  const posts = (oci: FakeOci) => oci.calls.filter((c) => c.method === "POST");

  it("restarts each ACTIVE tagged instance once, sequentially, with deterministic retry tokens", async () => {
    const world = healthyWorld(graph);
    const r = await restart(driverContext(world.oci));
    expect(r).toMatchObject({ ok: true, data: { restarted: 2, total: 2 } });
    const p = posts(world.oci);
    expect(p).toHaveLength(2);
    expect(p.every((c) => /^\/20210415\/containerInstances\/[^/]+\/actions\/restart$/.test(c.path))).toBe(true);
    const tokens = p.map((c) => c.headers!["opc-retry-token"]);
    expect(new Set(tokens).size).toBe(2);
    expect(tokens.every((t) => /^zenith-[0-9a-f]{32}$/.test(t))).toBe(true);
    // a retry of the same operation sends the same tokens
    const again = healthyWorld(graph);
    await restart(driverContext(again.oci));
    expect(posts(again.oci).map((c) => c.headers!["opc-retry-token"])).toEqual(tokens);
    // a different operation gets different tokens
    const other = healthyWorld(graph);
    await restart(driverContext(other.oci, { operationId: "op_other" }));
    expect(posts(other.oci).map((c) => c.headers!["opc-retry-token"])).not.toEqual(tokens);
  });

  it("skips instances that are not ACTIVE and instances of other nodes or environments", async () => {
    const world = healthyWorld(graph);
    world.db.instances.get("container_service/web")![0].lifecycleState = "FAILED";
    const worker = world.db.instances.get("container_service/worker")!;
    expect(worker.length).toBeGreaterThan(0);
    const r = await restart(driverContext(world.oci));
    expect(r.data).toEqual({ restarted: 1, total: 1 });
    const restartedIds = posts(world.oci).map((c) => c.path.split("/")[3]);
    expect(restartedIds).toEqual([world.db.instances.get("container_service/web")![1].id]);
    world.db.instances.get("container_service/web")![1].freeformTags = zenithTagsFor("container_service/web", "other-env");
    expect((await restart(driverContext(world.oci))).ok).toBe(false);
  });

  it("stops at the first failure and says how far it got", async () => {
    const world = healthyWorld(graph);
    let n = 0;
    world.oci.route("POST", /\/actions\/restart$/, () => (++n === 1 ? json({}, {}, 202) : err(429, "TooManyRequests", "slow")));
    const r = await restart(driverContext(world.oci));
    expect(r).toMatchObject({ ok: false, data: { restarted: 1, total: 2 } });
    expect(posts(world.oci)).toHaveLength(2);
  });

  it("needs an operation id, a readable listing and an ACTIVE instance", async () => {
    const world = healthyWorld(graph);
    expect((await restart(driverContext(world.oci, { operationId: undefined }))).summary).toMatch(/operation id/);
    expect(posts(world.oci)).toEqual([]);
    expect((await restart(driverContext(new FakeOci().on(() => err(403, "NotAuthenticated"))))).ok).toBe(false);
    const none = new FakeOci().on(() => json({ items: [] }));
    expect((await restart(driverContext(none))).summary).toMatch(/No ACTIVE instance/);
  });
});

describe("database.snapshot", () => {
  const snapshot = (ctx: ReturnType<typeof driverContext>, input: Record<string, unknown> = {}) => driverFor(db).operations!["database.snapshot"](ctx, db, input);

  it("requests one backup with a retry token, the db's id and the operation/fence tags", async () => {
    const world = healthyWorld(graph);
    world.oci.route("POST", "/20220915/backups", json({}, { "opc-work-request-id": "wr-1" }, 202));
    const r = await snapshot(driverContext(world.oci, { fence: { scope: "env-oci", token: 7 } }));
    expect(r).toMatchObject({ ok: true, data: { accepted: true, status: 202 } });
    const post = world.oci.calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0].headers!["opc-retry-token"]).toMatch(/^zenith-[0-9a-f]{32}$/);
    expect(post[0].body).toMatchObject({ dbSystemId: world.ids.get("postgres/db"), freeformTags: { zenith_operation: "op_test_1", zenith_fence: "env-oci:7", zenith_environment: "env-oci", zenith_resource: "postgres/db" } });
    expect(JSON.stringify(r)).not.toMatch(/password|secret/i);
  });

  it("is idempotent per operation id (same token), distinct across operations", async () => {
    const token = async (opId: string) => {
      const w = healthyWorld(graph);
      await snapshot(driverContext(w.oci, { operationId: opId }));
      return w.oci.calls.find((c) => c.method === "POST")!.headers!["opc-retry-token"];
    };
    expect(await token("op-a")).toBe(await token("op-a"));
    expect(await token("op-a")).not.toBe(await token("op-b"));
  });

  it("refuses a database that is not tagged for this node, a missing one, and a missing operation id", async () => {
    const world = healthyWorld(graph);
    expect((await snapshot(driverContext(world.oci, { operationId: undefined }))).summary).toMatch(/operation id/);
    const empty = new FakeOci().on(() => json({ items: [] }));
    expect((await snapshot(driverContext(empty))).ok).toBe(false);
    const foreignId = ocid("postgresqldbsystem", "foreign");
    const foreign = new FakeOci().route("GET", `/20220915/dbSystems/${foreignId}`, json({ id: foreignId, lifecycleState: "ACTIVE", freeformTags: zenithTagsFor("postgres/other") }));
    const r = await snapshot(driverContext(foreign), { externalId: foreignId });
    expect(r.ok).toBe(false);
    expect(foreign.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("surfaces an OCI refusal without throwing", async () => {
    const world = healthyWorld(graph);
    world.oci.route("POST", "/20220915/backups", err(409, "IncorrectState", "db is updating"));
    const r = await snapshot(driverContext(world.oci));
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/409 IncorrectState/);
  });
});

describe("firewall.inspect", () => {
  const rule = nodeOf(graph, "firewall/web-to-db");
  const inspect = (ctx: ReturnType<typeof driverContext>) => driverFor(rule).operations!["firewall.inspect"](ctx, rule, {});

  it("returns the target NSG's rules, bounded and read-only", async () => {
    const world = healthyWorld(graph);
    const r = await inspect(driverContext(world.oci));
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/2 rules/);
    expect((r.data as { rules: unknown[] }).rules).toHaveLength(2);
    expect(world.oci.calls.every((c) => c.method === "GET")).toBe(true);

    for (const [, rules] of world.db.nsgRules) rules.push(...Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, direction: "INGRESS", protocol: "6", source: "10.0.0.0/8", sourceType: "CIDR_BLOCK" })));
    const many = await inspect(driverContext(world.oci));
    expect((many.data as { rules: unknown[]; truncated: boolean }).rules).toHaveLength(100);
    expect((many.data as { truncated: boolean }).truncated).toBe(true);
  });

  it("reports an unreadable or absent NSG as a failure, not an empty rule set", async () => {
    expect((await inspect(driverContext(new FakeOci().on(() => err(403, "NotAuthenticated"))))).ok).toBe(false);
    const none = new FakeOci().on(() => json([]));
    expect((await inspect(driverContext(none))).summary).toMatch(/No network security group/);
  });
});
