/** Teardown through the existing local Neon HTTP contract fake, never the live service. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedDatabaseName, type DatabaseTarget, type ManagedDatabaseProvider, type ManagedDatabaseSpec } from "@/lib/providers/zenith/database";
import { createNeonProvider } from "@/lib/providers/zenith/neon";
import { teardownZenithEnvironment, type ZenithTeardownDatabase, type ZenithTeardownSession } from "@/lib/providers/zenith/teardown";
import { startFakeK8s, type FakeK8s } from "../kubernetes/fake-api";
import { sessionFor } from "../kubernetes/helpers";
import { DB_PASSWORD, FakeNeon, MemorySink, NEON_KEY, NS, TENANT, resolver, session } from "./support";
import { FakeTlsClient } from "./tls-support";

const KEY_REF = "vault:zenith-managed/neon-api-key";
const target: DatabaseTarget = { workspaceId: TENANT.workspaceId, environmentId: TENANT.environmentId, address: "postgres/db" };
const spec: ManagedDatabaseSpec = { ...target, engineVersion: 16, size: "small", backup: "daily", highAvailability: false, deletionPolicy: "allow" };
const ref = `ManagedDatabase/${NS}/${managedDatabaseName(target)}`;

describe("managed teardown through the Neon contract adapter", () => {
  let neon: FakeNeon;
  let k8s: FakeK8s;
  let provider: ManagedDatabaseProvider;
  let managed: ZenithTeardownSession;

  beforeEach(async () => {
    neon = new FakeNeon();
    await neon.start();
    k8s = await startFakeK8s();
    provider = createNeonProvider(
      { provider: "neon", apiBase: neon.url, apiKeyRef: KEY_REF, regionId: "aws-us-east-2", egress: [] },
      { fetch: (i, init) => fetch(i, init), resolveSecret: resolver(KEY_REF, NEON_KEY), sink: new MemorySink(), timeoutMs: 3000 }
    );
    const kubernetes = await sessionFor(k8s, [NS]);
    managed = { ...session(provider, { kubernetes, expiresAt: kubernetes.expiresAt }), teardown: { databases: [], tlsClient: new FakeTlsClient() } };
  });
  afterEach(async () => { await neon.stop(); await k8s.close(); });

  async function created() {
    const made = await provider.create(spec);
    expect(made.ok).toBe(true);
    if (!made.ok) throw new Error("Fixture database creation failed.");
    neon.requests.length = 0;
    return made.value.externalId;
  }
  function teardown(database: ZenithTeardownDatabase, dryRun = false, retainStateful = false) {
    return teardownZenithEnvironment({ ...TENANT, session: { ...managed, teardown: { ...managed.teardown, databases: [database] } }, dryRun, retainStateful });
  }

  it("deletes exactly the created tenant project through its ownership guard", async () => {
    const externalId = await created();
    const foreign = neon.seed("another-tenant-project");
    const result = await teardown({ ...target, externalId, deletionPolicy: "allow" });
    expect(result.deleted).toContain(ref);
    expect(result.uncertain).toEqual([]);
    expect(neon.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/projects/${externalId}`]);
    expect(neon.projects.get(externalId)?.deleted_at).toBeDefined();
    expect(neon.projects.get(foreign.id)?.deleted_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(NEON_KEY);
    expect(JSON.stringify(result)).not.toContain(DB_PASSWORD);
    expect(JSON.stringify(result)).not.toContain("postgresql://");
  });

  it("finds the tenant project by its deterministic name when no id was recorded", async () => {
    const externalId = await created();
    expect((await teardown({ ...target, deletionPolicy: "allow" })).deleted).toContain(ref);
    expect(neon.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/projects/${externalId}`]);
  });

  it("refuses an external id belonging to a project Zenith did not create for this tuple", async () => {
    const foreign = neon.seed("customer-database");
    const result = await teardown({ ...target, externalId: foreign.id, deletionPolicy: "allow" });
    expect(result.uncertain).toContain(ref);
    expect(neon.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(neon.projects.get(foreign.id)?.deleted_at).toBeUndefined();
  });

  it("refuses an id created for another workspace", async () => {
    const foreign = neon.seed(managedDatabaseName({ ...target, workspaceId: "other" }));
    expect((await teardown({ ...target, externalId: foreign.id, deletionPolicy: "allow" })).uncertain).toContain(ref);
    expect(neon.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("refuses ambiguous project names rather than choosing one", async () => {
    neon.seed(managedDatabaseName(target));
    neon.seed(managedDatabaseName(target));
    expect((await teardown({ ...target, deletionPolicy: "allow" })).uncertain).toContain(ref);
    expect(neon.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it.each([
    { deletionPolicy: "deny" as const, approved: true },
    { deletionPolicy: "approval" as const },
  ])("does not call Neon when policy $deletionPolicy refuses deletion", async (policy) => {
    const externalId = await created();
    expect((await teardown({ ...target, externalId, ...policy })).retained).toContain(ref);
    expect(neon.requests).toEqual([]);
    expect(neon.projects.get(externalId)?.deleted_at).toBeUndefined();
  });

  it("deletes approval-policy databases only with explicit approval", async () => {
    const externalId = await created();
    expect((await teardown({ ...target, externalId, deletionPolicy: "approval", approved: true })).deleted).toContain(ref);
    expect(neon.projects.get(externalId)?.deleted_at).toBeDefined();
  });

  it("retention overrides an allow policy and does not call Neon", async () => {
    const externalId = await created();
    expect((await teardown({ ...target, externalId, deletionPolicy: "allow" }, false, true)).retained).toContain(ref);
    expect(neon.requests).toEqual([]);
  });

  it("dry-runs with read-only ownership checks and no project deletion", async () => {
    const externalId = await created();
    expect((await teardown({ ...target, externalId, deletionPolicy: "allow" }, true)).deleted).toContain(ref);
    expect(neon.requests.length).toBeGreaterThan(0);
    expect(neon.requests.every((r) => r.method === "GET")).toBe(true);
    expect(neon.projects.get(externalId)?.deleted_at).toBeUndefined();
  });

  it("dry-run also refuses a foreign project", async () => {
    const foreign = neon.seed("customer-database");
    expect((await teardown({ ...target, externalId: foreign.id, deletionPolicy: "allow" }, true)).uncertain).toContain(ref);
    expect(neon.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("reports absent projects skipped on repeated teardown", async () => {
    const externalId = await created();
    await teardown({ ...target, externalId, deletionPolicy: "allow" });
    neon.requests.length = 0;
    const repeated = await teardown({ ...target, externalId, deletionPolicy: "allow" });
    expect(repeated.deleted).toEqual([]);
    expect(repeated.skipped).toContain(ref);
    expect(repeated.uncertain).toEqual([]);
    expect(neon.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("reports a rejected delete uncertain without leaking Neon errors or credentials", async () => {
    const externalId = await created();
    neon.failures.push({ match: `DELETE /projects/${externalId}`, status: 500, body: { message: `${NEON_KEY} ${DB_PASSWORD}` }, times: 1 });
    const result = await teardown({ ...target, externalId, deletionPolicy: "allow" });
    expect(result.uncertain).toContain(ref);
    expect(result.deleted).not.toContain(ref);
    expect(JSON.stringify(result)).not.toContain(NEON_KEY);
    expect(JSON.stringify(result)).not.toContain(DB_PASSWORD);
  });
});
