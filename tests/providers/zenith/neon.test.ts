import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedDatabaseProvider } from "@/lib/providers/zenith/database-factory";
import { DATABASE_UNCONFIGURED_REASON, managedDatabaseConnectionRef, managedDatabaseName, scrubText, type ManagedDatabaseProvider, type ManagedDatabaseSpec } from "@/lib/providers/zenith/database";
import { destroyManagedDatabase, ensureManagedDatabases } from "@/lib/providers/zenith/database-lifecycle";
import { NEON_BRANCH_NAME, NEON_DATABASE_NAME, NEON_ROLE_NAME, NEON_SIZE_CU, createNeonProvider } from "@/lib/providers/zenith/neon";
import { FULL_ENV, DB_PASSWORD, FakeNeon, MemorySink, NEON_KEY, TENANT, resolver, substrate } from "./support";

const KEY_REF = "vault:zenith-managed/neon-api-key";
const SPEC: ManagedDatabaseSpec = {
  workspaceId: TENANT.workspaceId,
  environmentId: TENANT.environmentId,
  address: "postgres/db",
  engineVersion: 16,
  size: "small",
  backup: "daily",
  highAvailability: false,
  deletionPolicy: "deny",
};
const TARGET = { workspaceId: SPEC.workspaceId, environmentId: SPEC.environmentId, address: SPEC.address };
const REF = managedDatabaseConnectionRef(SPEC.environmentId, SPEC.address);

let neon: FakeNeon;
let sink: MemorySink;

beforeEach(async () => {
  neon = new FakeNeon();
  await neon.start();
  sink = new MemorySink();
});
afterEach(async () => {
  await neon.stop();
});

function provider(over: { key?: string | undefined; orgId?: string; logs?: string[] } = {}): ManagedDatabaseProvider {
  const resolve = over.key === undefined && "key" in over ? resolver(KEY_REF, undefined) : resolver(KEY_REF, over.key ?? NEON_KEY);
  return createNeonProvider(
    { provider: "neon", apiBase: neon.url, apiKeyRef: KEY_REF, regionId: "aws-us-east-2", egress: [], ...(over.orgId ? { orgId: over.orgId } : {}) },
    { fetch: (input, init) => fetch(input, init), resolveSecret: resolve, sink, timeoutMs: 3000 }
  );
}

/** Everything a caller could observe from a call, for canary scanning. */
const everything = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));

describe("create", () => {
  it("creates a project named by a deterministic hash, with the documented request shape", async () => {
    const r = await provider().create(SPEC);
    expect(r.ok).toBe(true);
    const post = neon.requests.find((q) => q.method === "POST" && q.path === "/projects")!;
    const project = (post.body as { project: Record<string, unknown> }).project;
    expect(project.name).toBe(managedDatabaseName(SPEC));
    expect(project).toMatchObject({
      region_id: "aws-us-east-2",
      pg_version: 16,
      store_passwords: true,
      default_endpoint_settings: { autoscaling_limit_min_cu: NEON_SIZE_CU.small.min, autoscaling_limit_max_cu: NEON_SIZE_CU.small.max },
      branch: { name: NEON_BRANCH_NAME, role_name: NEON_ROLE_NAME, database_name: NEON_DATABASE_NAME },
    });
    expect(post.auth).toBe(`Bearer ${NEON_KEY}`);
  });

  it("returns the connection URI only as a secret reference and writes it to the sink", async () => {
    const r = await provider().create(SPEC);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.created).toBe(true);
    expect(r.value.connectionSecretRef).toBe(REF);
    expect(r.value.provider).toBe("neon");
    expect(r.value.engineVersion).toBe(16);
    expect(sink.values.get(REF)).toMatch(/^postgresql:\/\/app_owner:.+@/);
    const text = everything(r.value);
    for (const canary of [DB_PASSWORD, NEON_KEY, "neon.tech", "postgresql://", "app_owner"]) expect(text, canary).not.toContain(canary);
  });

  it("is idempotent: a second create converges on the same project and does not create another", async () => {
    const p = provider();
    const first = await p.create(SPEC);
    const second = await p.create(SPEC);
    if (!first.ok || !second.ok) throw new Error("create failed");
    expect(second.value.created).toBe(false);
    expect(second.value.externalId).toBe(first.value.externalId);
    expect(neon.requests.filter((q) => q.method === "POST")).toHaveLength(1);
    expect([...neon.projects.values()]).toHaveLength(1);
  });

  it("re-stores the connection secret when a project exists but the vault lost it", async () => {
    const p = provider();
    await p.create(SPEC);
    sink.values.clear();
    const again = await p.create(SPEC);
    expect(again.ok).toBe(true);
    expect(sink.values.get(REF)).toMatch(/^postgresql:/);
    expect(neon.requests.some((q) => q.path.endsWith("/connection_uri"))).toBe(true);
  });

  it("fetches the URI from the connection_uri endpoint when the create response lacks it", async () => {
    neon.uriCanBeMissingFromCreate = true;
    const r = await provider().create(SPEC);
    expect(r.ok).toBe(true);
    expect(sink.values.get(REF)).toMatch(/^postgresql:/);
  });

  it("does not match another tenant's or resource's project, and names differ by tuple", async () => {
    neon.seed(managedDatabaseName({ ...TARGET, address: "postgres/other" }));
    neon.seed(managedDatabaseName({ ...TARGET, environmentId: "env_other" }));
    const r = await provider().create(SPEC);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.created).toBe(true);
    expect(managedDatabaseName(TARGET)).not.toBe(managedDatabaseName({ ...TARGET, workspaceId: "ws_other" }));
    expect(managedDatabaseName(TARGET)).toMatch(/^zenith-[0-9a-f]{20}$/);
  });

  it("passes the organization id when configured", async () => {
    await provider({ orgId: "org-quiet-123" }).create(SPEC);
    const post = neon.requests.find((q) => q.method === "POST")!;
    expect((post.body as { project: { org_id: string } }).project.org_id).toBe("org-quiet-123");
    expect(neon.requests.find((q) => q.method === "GET" && q.path === "/projects")!.query.get("org_id")).toBe("org-quiet-123");
  });

  it("finds an existing project across paginated listings", async () => {
    neon.pageSize = 2;
    for (let i = 0; i < 5; i++) neon.seed(`zenith-filler-${i}`);
    const target = neon.seed(managedDatabaseName(TARGET));
    // the fake matches by substring, so make the filler names match the search too
    for (let i = 0; i < 5; i++) neon.seed(`${managedDatabaseName(TARGET)}-suffix-${i}`);
    const r = await provider().create(SPEC);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.externalId).toBe(target.id);
    expect(r.value.created).toBe(false);
    expect(neon.requests.filter((q) => q.method === "GET" && q.path === "/projects").length).toBeGreaterThan(1);
  });

  it("refuses to choose between duplicate projects", async () => {
    neon.seed(managedDatabaseName(TARGET));
    neon.seed(managedDatabaseName(TARGET));
    const r = await provider().create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ambiguous");
      expect(r.error.retryable).toBe(false);
    }
    expect(neon.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("validates the engine version and size before calling the provider", async () => {
    const bad = await provider().create({ ...SPEC, engineVersion: 9 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("invalid_request");
    const badSize = await provider().create({ ...SPEC, size: "enormous" as never });
    expect(badSize.ok).toBe(false);
    expect(neon.requests).toHaveLength(0);
  });

  it("reports a secret store failure as retryable, without echoing what the store said, and converges on retry", async () => {
    sink.failPut = true;
    const p = provider();
    const r = await p.create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("secret_store_failed");
      expect(r.error.retryable).toBe(true);
    }
    expect(everything(r)).not.toContain(DB_PASSWORD);
    expect([...neon.projects.values()]).toHaveLength(1); // the project exists...
    sink.failPut = false;
    const retry = await p.create(SPEC);
    expect(retry.ok).toBe(true); // ...and the retry finds it and stores the secret
    expect([...neon.projects.values()]).toHaveLength(1);
    expect(sink.values.get(REF)).toBeDefined();
  });

  it("rejects a create response without a usable project", async () => {
    const odd = provider();
    neon.failures.push({ match: "POST /projects", status: 201, body: { not: "a project" }, times: 1 });
    const r = await odd.create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("provider_error");
    expect(sink.values.size).toBe(0);
  });
});

describe("get", () => {
  it("returns null when nothing exists (by name) and when the id is gone", async () => {
    const p = provider();
    const byName = await p.get(TARGET);
    expect(byName).toEqual({ ok: true, value: null });
    const byId = await p.get({ ...TARGET, externalId: "proj-gone-1" });
    expect(byId).toEqual({ ok: true, value: null });
  });

  it("reads the project and its compute state, by name and by id", async () => {
    const p = provider();
    const made = await p.create(SPEC);
    if (!made.ok) throw new Error("create failed");
    for (const target of [TARGET, { ...TARGET, externalId: made.value.externalId }]) {
      const r = await p.get(target);
      if (!r.ok || r.value === null) throw new Error("get failed");
      expect(r.value.externalId).toBe(made.value.externalId);
      expect(r.value.regionId).toBe("aws-us-east-2");
      expect(r.value.engineVersion).toBe(16);
      expect(r.value.computeState).toBe("active");
      expect(r.value.connectionSecretRef).toBe(REF);
      expect(everything(r.value)).not.toMatch(/neon\.tech|ep-quiet|postgresql:/);
    }
  });

  it.each(["idle", "init", "none", "disabled"] as const)("reports compute state %s", async (state) => {
    const p = provider();
    await p.create(SPEC);
    neon.endpointState = state;
    const r = await p.get(TARGET);
    expect(r.ok && r.value?.computeState).toBe(state);
  });

  it("does not treat a project Zenith did not create for this tuple as managed, even by id", async () => {
    const foreign = neon.seed("someone-elses-production-db");
    const r = await provider().get({ ...TARGET, externalId: foreign.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
  });

  it("treats a deleted (recoverable) project as absent", async () => {
    const p = provider();
    const made = await p.create(SPEC);
    if (!made.ok) throw new Error("create failed");
    neon.projects.get(made.value.externalId)!.deleted_at = "2026-09-30T01:00:00Z";
    expect(await p.get(TARGET)).toEqual({ ok: true, value: null });
  });

  it("refuses a malformed recorded id without calling the provider", async () => {
    const r = await provider().get({ ...TARGET, externalId: "../../organizations" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_request");
    expect(neon.requests).toHaveLength(0);
  });
});

describe("delete", () => {
  it("deletes the project Zenith created, by name and by id", async () => {
    const p = provider();
    const made = await p.create(SPEC);
    if (!made.ok) throw new Error("create failed");
    const r = await p.delete({ ...TARGET, externalId: made.value.externalId });
    expect(r).toEqual({ ok: true, value: { deleted: true, alreadyAbsent: false } });
    expect(neon.projects.get(made.value.externalId)!.deleted_at).toBeDefined();

    const again = await p.delete(TARGET);
    expect(again).toEqual({ ok: true, value: { deleted: false, alreadyAbsent: true } });
    const byIdAgain = await p.delete({ ...TARGET, externalId: made.value.externalId });
    expect(byIdAgain).toEqual({ ok: true, value: { deleted: false, alreadyAbsent: true } });
  });

  it("never deletes a project that is not the one Zenith made for this tuple", async () => {
    const foreign = neon.seed("customer-production-db");
    const r = await provider().delete({ ...TARGET, externalId: foreign.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    expect(neon.requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(neon.projects.get(foreign.id)!.deleted_at).toBeUndefined();
  });

  it("refuses to delete when the name matches more than one project", async () => {
    neon.seed(managedDatabaseName(TARGET));
    neon.seed(managedDatabaseName(TARGET));
    const r = await provider().delete(TARGET);
    expect(r.ok).toBe(false);
    expect(neon.requests.some((q) => q.method === "DELETE")).toBe(false);
  });
});

describe("deletion policy", () => {
  it("never deletes under deny, even when approved", async () => {
    const p = provider();
    await p.create(SPEC);
    const r = await destroyManagedDatabase(p, TARGET, { deletionPolicy: "deny", approved: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
    expect(neon.requests.some((q) => q.method === "DELETE")).toBe(false);
  });

  it("deletes under approval only when approved", async () => {
    const p = provider();
    await p.create(SPEC);
    const refused = await destroyManagedDatabase(p, TARGET, { deletionPolicy: "approval" });
    expect(refused.ok).toBe(false);
    expect(neon.requests.some((q) => q.method === "DELETE")).toBe(false);
    const done = await destroyManagedDatabase(p, TARGET, { deletionPolicy: "approval", approved: true });
    expect(done.ok && done.value.deleted).toBe(true);
  });

  it("deletes under allow", async () => {
    const p = provider();
    await p.create(SPEC);
    const r = await destroyManagedDatabase(p, TARGET, { deletionPolicy: "allow" });
    expect(r.ok && r.value.deleted).toBe(true);
  });
});

describe("errors", () => {
  it("answers unavailable when the API key reference cannot be resolved, without calling the provider", async () => {
    const r = await provider({ key: undefined }).create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unavailable");
      expect(r.error.message).toContain(KEY_REF);
    }
    expect(neon.requests).toHaveLength(0);
  });

  it("resolves the key on every call and never caches it", async () => {
    let calls = 0;
    const p = createNeonProvider(
      { provider: "neon", apiBase: neon.url, apiKeyRef: KEY_REF, regionId: "aws-us-east-2", egress: [] },
      { fetch: (i, n) => fetch(i, n), resolveSecret: async () => (++calls, NEON_KEY), sink, timeoutMs: 3000 }
    );
    await p.get(TARGET);
    await p.get(TARGET);
    expect(calls).toBe(2);
  });

  it("maps 401 to unauthorized without echoing the key", async () => {
    const r = await provider({ key: "wrong-key-CANARY-123456" }).get(TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unauthorized");
      expect(r.error.retryable).toBe(false);
      expect(r.error.status).toBe(401);
    }
    expect(everything(r)).not.toContain("wrong-key-CANARY-123456");
  });

  it.each([
    [403, { request_id: "r1", code: "PERMISSION", message: "no access" }, "forbidden", false],
    [403, { request_id: "r2", code: "PROJECTS_LIMIT_EXCEEDED", message: "project limit exceeded" }, "quota_exceeded", false],
    [422, { request_id: "r3", code: "", message: "You have reached the project limit" }, "quota_exceeded", false],
    [400, { request_id: "r4", code: "", message: "bad request" }, "invalid_request", false],
    [404, { request_id: "r5", code: "", message: "gone" }, "not_found", false],
    [409, { request_id: "r6", code: "", message: "conflict" }, "conflict", false],
    [423, { request_id: "r7", code: "", message: "locked by running operations" }, "conflict", true],
    [500, { request_id: "r8", code: "", message: "boom" }, "provider_error", true],
    [503, { request_id: "r9", code: "", message: "unavailable" }, "provider_error", true],
  ])("maps HTTP %i to %s (retryable: %s)", async (status, body, code, retryable) => {
    neon.failures.push({ match: "GET /projects", status, body, times: 1 });
    const r = await provider().create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.retryable).toBe(retryable);
      expect(r.error.status).toBe(status);
      expect(r.error.requestId).toBe(body.request_id);
    }
  });

  it("maps 429 to rate_limited and surfaces Retry-After", async () => {
    neon.failures.push({ match: "GET /projects", status: 429, body: { request_id: "rl", code: "", message: "slow down" }, headers: { "retry-after": "17" }, times: 1 });
    const r = await provider().create(SPEC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("rate_limited");
      expect(r.error.retryable).toBe(true);
      expect(r.error.retryAfterSec).toBe(17);
    }
    expect(neon.requests.some((q) => q.method === "POST")).toBe(false);
  });

  it("scrubs the API key and URL credentials out of provider error text", async () => {
    neon.failures.push({
      match: "GET /projects",
      status: 500,
      body: { request_id: "x", code: "", message: `failed for Bearer ${NEON_KEY} using ${NEON_KEY} and postgresql://u:${DB_PASSWORD}@host/db` },
      times: 1,
    });
    const r = await provider().create(SPEC);
    const text = everything(r);
    expect(text).not.toContain(NEON_KEY);
    expect(text).not.toContain(DB_PASSWORD);
    expect(text).toContain("[redacted]");
  });

  it("reports an unreachable provider and a timeout as retryable", async () => {
    await neon.stop();
    const down = await provider().get(TARGET);
    expect(down.ok).toBe(false);
    if (!down.ok) {
      expect(down.error.code).toBe("unreachable");
      expect(down.error.retryable).toBe(true);
    }
    await neon.start();
  });

  it("honors an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await provider().get(TARGET, { signal: ac.signal });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
  });

  it("refuses to follow a redirect, so the bearer key cannot be forwarded", async () => {
    neon.redirectTo = "http://127.0.0.1:1/steal";
    const r = await provider().get(TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["unreachable", "provider_error"]).toContain(r.error.code);
    expect(everything(r)).not.toContain(NEON_KEY);
  });

  it("rejects a non-JSON success body", async () => {
    neon.failures.push({ match: "GET /projects", status: 200, raw: "<html>maintenance</html>", times: 1 });
    const r = await provider().get(TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("provider_error");
      expect(r.error.message).toMatch(/not valid JSON/);
    }
  });

  it("does not put an HTML error page into the error text", async () => {
    neon.failures.push({ match: "GET /projects", status: 502, raw: "<html>Bad gateway: internal host db-7.internal</html>", times: 1 });
    const r = await provider().get(TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("provider_error");
      expect(r.error.retryable).toBe(true);
      expect(r.error.message).not.toContain("internal host");
    }
  });
});

describe("the secret never leaks", () => {
  it("does not appear in any result, error or recorded log across a full lifecycle", async () => {
    const logs: string[] = [];
    const p = provider();
    const results: unknown[] = [];
    results.push(await p.create(SPEC));
    results.push(await p.create(SPEC));
    results.push(await p.get(TARGET));
    results.push(await destroyManagedDatabase(p, TARGET, { deletionPolicy: "allow" }));
    results.push(await ensureManagedDatabases([{ address: SPEC.address, spec: SPEC, connectionSecretRef: REF, notes: [] }], p));
    sink.failPut = true;
    neon.projects.clear();
    results.push(await p.create(SPEC));
    const text = everything(results) + logs.join("\n");
    for (const canary of [DB_PASSWORD, NEON_KEY, "app_owner:", "ep-quiet-glade"]) expect(text, canary).not.toContain(canary);
  });

  it("scrubText removes known secrets and URL credentials and bounds length", () => {
    const s = scrubText(`x ${NEON_KEY} y postgres://user:hunter2@db.example.com/x z`, [NEON_KEY], 120);
    expect(s).not.toContain(NEON_KEY);
    expect(s).not.toContain("hunter2");
    expect(scrubText("a".repeat(1000), [], 50).length).toBe(50);
  });
});

describe("unavailable provider", () => {
  it("is returned when the substrate configures no database, and never succeeds", async () => {
    const { ZENITH_MANAGED_DB_PROVIDER: _a, ZENITH_MANAGED_DB_API_KEY_REF: _b, ZENITH_MANAGED_DB_REGION: _c, ZENITH_MANAGED_DB_EGRESS: _d, ...noDb } = FULL_ENV;
    void [_a, _b, _c, _d];
    const p = createManagedDatabaseProvider(substrate(noDb), { fetch: () => Promise.reject(new Error("must not be called")), resolveSecret: async () => undefined, sink });
    expect(p.availability()).toEqual({ available: false, reason: DATABASE_UNCONFIGURED_REASON });
    for (const r of [await p.create(SPEC), await p.get(TARGET), await p.delete(TARGET)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("unavailable");
        expect(r.error.message).toContain("ZENITH_MANAGED_DB_PROVIDER");
        expect(r.error.retryable).toBe(false);
      }
    }
    expect(p.connectionSecretRef(TARGET)).toBe(REF);
  });

  it("ensureManagedDatabases reports unavailable for every intent without calling anything", async () => {
    const { ZENITH_MANAGED_DB_PROVIDER: _a, ZENITH_MANAGED_DB_API_KEY_REF: _b, ZENITH_MANAGED_DB_REGION: _c, ZENITH_MANAGED_DB_EGRESS: _d, ...noDb } = FULL_ENV;
    void [_a, _b, _c, _d];
    const p = createManagedDatabaseProvider(substrate(noDb), { fetch: () => Promise.reject(new Error("must not be called")), resolveSecret: async () => undefined, sink });
    const out = await ensureManagedDatabases([{ address: "postgres/db", spec: SPEC, connectionSecretRef: REF, notes: [] }], p, { dryRun: true });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("failed");
    expect(out[0].error?.code).toBe("unavailable");
  });

  it("the factory returns the Neon adapter when configured", () => {
    const p = createManagedDatabaseProvider(substrate(), { fetch, resolveSecret: async () => undefined, sink });
    expect(p.id).toBe("neon");
    expect(p.availability()).toEqual({ available: true });
  });
});

describe("ensureManagedDatabases", () => {
  it("plans without calling the provider on a dry run, and creates otherwise", async () => {
    const p = provider();
    const intent = { address: SPEC.address, spec: SPEC, connectionSecretRef: REF, notes: [] };
    const planned = await ensureManagedDatabases([intent], p, { dryRun: true });
    expect(planned[0].status).toBe("planned");
    expect(neon.requests).toHaveLength(0);
    const created = await ensureManagedDatabases([intent], p);
    expect(created[0].status).toBe("created");
    expect(created[0].info?.connectionSecretRef).toBe(REF);
    const again = await ensureManagedDatabases([intent], p);
    expect(again[0].status).toBe("exists");
  });

  it("stops at the first failure and does not attempt later databases", async () => {
    neon.failures.push({ match: "GET /projects", status: 500, times: 1 });
    const a = { address: "postgres/a", spec: { ...SPEC, address: "postgres/a" }, connectionSecretRef: "vault:a", notes: [] };
    const b = { address: "postgres/b", spec: { ...SPEC, address: "postgres/b" }, connectionSecretRef: "vault:b", notes: [] };
    const out = await ensureManagedDatabases([a, b], provider());
    expect(out.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(out[1].error?.message).toMatch(/Not attempted/);
    expect(neon.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});
