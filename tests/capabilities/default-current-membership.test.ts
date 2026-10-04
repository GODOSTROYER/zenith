/** Real owning PostgreSQL/OPA/signing; product PostgREST, credential-directory and browser identities are explicit models. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/store";
import type { Principal } from "@/lib/controlplane/types";
import type { Grant } from "@/lib/agent-access/control/journal";
import { platformBroker, registerPlatformBrokerPorts, registerPlatformBrokerStore, resetPlatformBrokerForTests } from "@/lib/capabilities/platform";
import { repos } from "@/lib/controlplane/db";
import { verifyCapabilityGrant, type PublicJwk } from "@/lib/credentials";
import { closeSharedPgliteAfterAll, makeHarness, PG_URL, requestFor, sessionFor, systemPrincipal, user, type Harness } from "./support";

type Member = { id: string; workspace_id: string; role: unknown };
type ReadInput = { workspaceId: string; humanId: string; signal: AbortSignal };
type ReadResponse = { data: unknown; error: unknown };
const product = vi.hoisted(() => ({
  // Deliberately stale bulk snapshot: old fallback must not authorize from it.
  snapshot: { workspaces: [] as { id: string }[], members: [] as { id: string; workspaceId: string; role: string }[] },
  members: new Map<string, Member>(),
  credentials: [] as { id: string; workspaceId: string; subject: string; scopes: string[]; projectIds: string[]; environmentIds?: string[]; expiresAt: string; revokedAt?: string }[],
  reads: [] as ReadInput[],
  read: undefined as undefined | ((input: ReadInput) => Promise<ReadResponse>),
  client: vi.fn(),
  credentialReads: vi.fn(),
  select: vi.fn(),
  emptyAdmin: false,
  grants: [] as Grant[],
  grantReads: vi.fn(), retainedGrant: vi.fn(),
}));
vi.mock("@/lib/db/store", () => ({ isPostgres: () => true, db: () => product.snapshot as unknown as Database, q: {}, revisionManifestAsync: async () => undefined }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/auth/policy", () => ({ membershipPolicy: () => ({ emptyWorkspaceGrantsAdmin: product.emptyAdmin }) }));
vi.mock("@/lib/db/postgres-store", () => ({ pgClient: product.client }));
vi.mock("@/lib/agent-access/authority", () => ({ credentialAuthority: () => ({ listCredentials: product.credentialReads }) }));
vi.mock("@/lib/agent-access/control/boundary", () => ({ controlOrigin: () => "https://zenith.example" }));
vi.mock("@/lib/agent-access/control/runtime", () => ({ agentJournal: async () => ({ kind: "postgres", grants: product.grantReads, getGrant: product.retainedGrant }) }));

if (process.env.ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED === "1" && !PG_URL) throw new Error("Default current membership acceptance requires an explicitly owned PostgreSQL database.");
closeSharedPgliteAfterAll();
const key = (workspaceId: string, humanId: string) => `${workspaceId}|${humanId}`;
const fixtures: Harness[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function member(workspaceId: string, humanId: string, role: unknown): Member { return { id: humanId, workspace_id: workspaceId, role }; }
function current(workspaceId: string, humanId: string, role: unknown) { product.members.set(key(workspaceId, humanId), member(workspaceId, humanId, role)); }

beforeEach(() => {
  vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY", "");
  resetPlatformBrokerForTests();
  vi.clearAllMocks();
  product.members.clear(); product.credentials = []; product.reads = []; product.read = undefined; product.emptyAdmin = false; product.grants = [];
  product.snapshot = { workspaces: [], members: [] };
  product.client.mockImplementation(() => ({ from: (table: string) => {
    expect(table).toBe("members");
    const filters = new Map<string, string>();
    let signal: AbortSignal | undefined;
    const query = {
      select: (columns: string) => { product.select(columns); return query; },
      eq: (field: string, value: string) => { filters.set(field, value); return query; },
      abortSignal: (value: AbortSignal) => { signal = value; return query; },
      maybeSingle: async () => {
        expect([...filters.keys()]).toEqual(["workspace_id", "id"]);
        expect(signal).toBeInstanceOf(AbortSignal);
        const input = { workspaceId: filters.get("workspace_id")!, humanId: filters.get("id")!, signal: signal! };
        product.reads.push(input);
        return product.read ? product.read(input) : { data: product.members.get(key(input.workspaceId, input.humanId)) ?? null, error: null };
      },
    };
    return query;
  } }));
  product.grantReads.mockImplementation(async () => product.grants);
  product.retainedGrant.mockImplementation(async (subject: string, clientId: string, workspaceId: string) =>
    product.grants.find(grant => grant.subject === subject && grant.clientId === clientId && grant.workspaceId === workspaceId));
  product.credentialReads.mockImplementation(async (subject: string, workspaceId: string) => product.credentials.filter(credential => credential.subject === subject && credential.workspaceId === workspaceId));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetPlatformBrokerForTests();
  for (const h of fixtures.splice(0)) {
    // Only this test's operation rows; it never creates an outbox, provider job or effect.
    await h.db!.tx(async tx => {
      for (const table of ["capability_grants", "approvals", "policy_decisions", "idempotency_keys", "events", "operations"]) {
        await tx.query(`delete from platform.${table} where workspace_id=$1`, [h.ids.wsA]);
      }
    });
  }
});

async function fixture() {
  const h = await makeHarness({ kind: "postgres" }); fixtures.push(h);
  product.snapshot = { workspaces: [{ id: h.ids.wsA }, { id: h.ids.wsB }], members: [
    { id: "bob", workspaceId: h.ids.wsA, role: "editor" }, { id: "erin", workspaceId: h.ids.wsA, role: "admin" },
  ] };
  current(h.ids.wsA, "bob", "editor"); current(h.ids.wsA, "erin", "admin");
  // Real owning SQL and signer plus explicit modeled product scope. Do not
  // register a roles port: the test must exercise the actual default resolver.
  registerPlatformBrokerStore(h.store);
  registerPlatformBrokerPorts({ scopes: h.deps.scopes, signer: h.deps.signer });
  const broker = await platformBroker();
  expect(broker.deps.store).toBe(h.store);
  expect(await platformBroker()).toBe(broker);
  expect(broker.deps.roles).not.toBe(h.deps.roles);
  return { h, broker, request: requestFor(h, "service.restart", "prod") };
}
async function approved() {
  const f = await fixture();
  const proposal = await f.broker.propose(f.request, user("bob"));
  expect(proposal.decision.outcome).toBe("require_approval");
  await f.broker.approve({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest,
    approver: user("erin"), session: sessionFor("erin") });
  expect((await repos.operations.get(f.h.db!, f.h.ids.wsA, proposal.operation.id))?.status).toBe("approved");
  return { ...f, proposal };
}
async function noClaim(h: Harness, operationId: string) {
  expect(await h.db!.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [h.ids.wsA, operationId])).toEqual([]);
  expect(await h.db!.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null", [h.ids.wsA, operationId])).toEqual([]);
}

describe.skipIf(!PG_URL)("cached default broker current membership [postgres; modeled product reads]", () => {
  it("same owning current requester and approver permit one canonical signed claim", async () => {
    const f = await approved();
    const claim = await f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.proposal.operation.id,
      holder: `workflow:${f.proposal.operation.id}`, audience: "worker", leaseMs: 60_000 });
    expect(await verifyCapabilityGrant(claim.grant, { audience: "worker", keys: [(await f.h.publicJwk()) as unknown as PublicJwk],
      expectedCapability: "service.restart", expectedOperationId: f.proposal.operation.id })).toMatchObject({
      ws: f.h.ids.wsA, sub: "bob", digest: f.proposal.operation.proposalDigest,
    });
    expect((await repos.operations.get(f.h.db!, f.h.ids.wsA, f.proposal.operation.id))?.status).toBe("running");
    expect(await f.h.db!.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null", [f.h.ids.wsA, f.proposal.operation.id])).toHaveLength(1);
    expect(product.select).toHaveBeenCalledWith("id,workspace_id,role");
    expect(product.reads.some(read => read.humanId === "bob" && read.workspaceId === f.h.ids.wsA)).toBe(true);
    expect(product.reads.filter(read => read.humanId === "erin").length).toBeGreaterThan(1);
    expect(await platformBroker()).toBe(f.broker);
  });
  it.each(["demoted", "deleted"])("the same cached broker refuses a %s requester without a snapshot fallback", async change => {
    const f = await fixture();
    expect((await f.broker.check(f.request, user("bob"))).decision.outcome).toBe("require_approval");
    const first = product.reads.at(-1)!;
    if (change === "demoted") current(f.h.ids.wsA, "bob", "viewer"); else product.members.delete(key(f.h.ids.wsA, "bob"));
    expect(product.snapshot.members.find(row => row.id === "bob")?.role).toBe("editor");
    expect(await platformBroker()).toBe(f.broker);
    if (change === "demoted") expect((await f.broker.check(f.request, user("bob"))).decision.outcome).toBe("deny");
    else await expect(f.broker.check(f.request, user("bob"))).rejects.toMatchObject({ code: "not_found" });
    expect(product.reads.at(-1)!.signal).not.toBe(first.signal);
    expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
  });
  it.each(["bob", "local"])("missing hosted member %s receives no empty-workspace or local authority", async humanId => {
    const f = await fixture();
    product.members.clear(); product.snapshot.members = []; product.emptyAdmin = true;
    await expect(f.broker.propose(f.request, user(humanId))).rejects.toMatchObject({ code: "not_found" });
    expect(product.reads.at(-1)).toMatchObject({ workspaceId: f.h.ids.wsA, humanId });
    expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
    expect(await platformBroker()).toBe(f.broker);
  });
  it.each(["demoted", "deleted"])("a cached requester approval cannot survive a %s consumed human approver", async change => {
    const f = await approved();
    if (change === "demoted") current(f.h.ids.wsA, "erin", "viewer"); else product.members.delete(key(f.h.ids.wsA, "erin"));
    expect(product.snapshot.members.find(row => row.id === "erin")?.role).toBe("admin");
    expect(await platformBroker()).toBe(f.broker);
    await expect(f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.proposal.operation.id,
      holder: `workflow:${f.proposal.operation.id}`, audience: "worker", leaseMs: 60_000 })).rejects.toMatchObject({ code: "reapproval_required" });
    expect((await repos.operations.get(f.h.db!, f.h.ids.wsA, f.proposal.operation.id))?.status).toBe("approved");
    await noClaim(f.h, f.proposal.operation.id);
  });
  it.each(["demoted", "deleted"])("a %s requester cannot claim an already approved operation", async change => {
    const f = await approved();
    if (change === "demoted") current(f.h.ids.wsA, "bob", "viewer"); else product.members.delete(key(f.h.ids.wsA, "bob"));
    await expect(f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.proposal.operation.id,
      holder: `workflow:${f.proposal.operation.id}`, audience: "worker", leaseMs: 60_000 })).rejects.toMatchObject({ code: "policy_denied" });
    expect((await repos.operations.get(f.h.db!, f.h.ids.wsA, f.proposal.operation.id))?.status).toBe("denied");
    await noClaim(f.h, f.proposal.operation.id);
    expect(await platformBroker()).toBe(f.broker);
  });
  it.each(["response error", "thrown error", "foreign workspace", "foreign human", "unsupported role"])("current membership %s refuses before proposal authority or privileged fallback", async shape => {
    const f = await fixture(); product.emptyAdmin = true;
    product.read = async input => {
      if (shape === "thrown error") throw new Error("Modeled private upstream diagnostic.");
      if (shape === "response error") return { data: null, error: new Error("Modeled private upstream diagnostic.") };
      return { data: { id: shape === "foreign human" ? "foreign_human" : input.humanId,
        workspace_id: shape === "foreign workspace" ? f.h.ids.wsB : input.workspaceId, role: shape === "unsupported role" ? "owner" : "admin" }, error: null };
    };
    await expect(f.broker.propose(f.request, user("bob"))).rejects.toMatchObject({ code: "current_product_role_unconfirmed", message: "Current workspace membership could not be confirmed." });
    expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
    expect(await platformBroker()).toBe(f.broker);
  });
  it("a real eight-second role deadline refuses late successful modeled PostgREST completion on the cached broker", async () => {
    const f = await fixture();
    const entered = deferred<ReadInput>(), read = deferred<ReadResponse>();
    product.read = input => { entered.resolve(input); return read.promise; }; // Deliberately ignores abort.
    const began = performance.now();
    const pending = f.broker.propose(f.request, user("bob"));
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    const observed = await Promise.race([entered.promise, outcome.then(() => { throw new Error("Proposal completed without its held current membership read."); })]);
    try {
      const refusal = await outcome;
      expect(refusal).toHaveProperty("error.code", "current_product_role_unconfirmed");
      expect(observed.signal.aborted).toBe(true);
      expect(performance.now() - began).toBeGreaterThanOrEqual(7_500);
      expect(performance.now() - began).toBeLessThan(15_000);
      read.resolve({ data: member(f.h.ids.wsA, "bob", "admin"), error: null });
      await Promise.resolve(); await Promise.resolve();
      await expect(pending).rejects.toMatchObject({ code: "current_product_role_unconfirmed" });
      expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
      product.read = undefined; current(f.h.ids.wsA, "bob", "viewer");
      expect((await f.broker.check(f.request, user("bob"))).decision.outcome).toBe("deny");
      expect(product.reads.at(-1)!.signal).not.toBe(observed.signal);
      expect(product.reads.at(-1)!.signal.aborted).toBe(false);
      expect(await platformBroker()).toBe(f.broker);
    } finally { read.resolve({ data: null, error: null }); product.read = undefined; }
  }, 20_000);
  it("integration authority retains credential scope and target attenuation while rereading its human", async () => {
    const f = await fixture();
    const integration: Principal = { kind: "integration", id: "owned_credential", name: "Owned modeled integration", integrationId: "owned_credential", onBehalfOf: "bob" };
    product.credentials = [{ id: "owned_credential", workspaceId: f.h.ids.wsA, subject: "bob", scopes: ["read", "write"], projectIds: [f.h.ids.projA], environmentIds: [f.h.ids.envAProd], expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    expect(await f.broker.deps.roles.resolve(integration, f.h.ids.wsA)).toEqual({ role: "editor", integrationScopes: ["read", "write"], allowedProjectIds: [f.h.ids.projA], allowedEnvironmentIds: [f.h.ids.envAProd] });
    current(f.h.ids.wsA, "bob", "viewer");
    expect(await f.broker.deps.roles.resolve(integration, f.h.ids.wsA)).toMatchObject({ role: "viewer", allowedProjectIds: [f.h.ids.projA], allowedEnvironmentIds: [f.h.ids.envAProd] });
    expect((await f.broker.check(f.request, integration)).decision.outcome).toBe("deny");
    current(f.h.ids.wsA, "bob", "admin");
    // A live credential attenuates scope; its current human role is reread,
    // never capped by the stale enclosing product snapshot.
    expect((await f.broker.deps.roles.resolve(integration, f.h.ids.wsA)).role).toBe("admin");
    expect(product.credentialReads.mock.calls.every(call => call[0] === "bob" && call[1] === f.h.ids.wsA)).toBe(true);
    product.credentials[0].environmentIds = [f.h.ids.envASbx];
    await expect(f.broker.check(f.request, integration)).rejects.toMatchObject({ code: "not_found" });
  });
  it.each(["revoked", "expired", "foreign workspace", "missing"])("a %s integration credential cannot be restored by current admin membership", async state => {
    const f = await fixture(); current(f.h.ids.wsA, "bob", "admin");
    const integration: Principal = { kind: "integration", id: "owned_credential", name: "Owned modeled integration", integrationId: "owned_credential", onBehalfOf: "bob" };
    product.credentials = state === "missing" ? [] : [{ id: "owned_credential", workspaceId: state === "foreign workspace" ? f.h.ids.wsB : f.h.ids.wsA,
      subject: "bob", scopes: ["read", "write"], projectIds: [f.h.ids.projA], expiresAt: new Date(Date.now() + (state === "expired" ? -1_000 : 60_000)).toISOString(), ...(state === "revoked" ? { revokedAt: new Date().toISOString() } : {}) }];
    expect(await f.broker.deps.roles.resolve(integration, f.h.ids.wsA)).toEqual({ role: "none" });
    expect(product.reads).toHaveLength(1);
    expect(product.reads[0]).toMatchObject({ workspaceId: f.h.ids.wsA, humanId: "bob" });
    expect(product.credentialReads).toHaveBeenCalledExactlyOnceWith("bob", f.h.ids.wsA);
    await expect(f.broker.check(f.request, integration)).rejects.toMatchObject({ code: "not_found" });
    expect(product.reads).toHaveLength(2);
    expect(product.reads.every(read => read.workspaceId === f.h.ids.wsA && read.humanId === "bob")).toBe(true);
    expect(product.credentialReads).toHaveBeenCalledTimes(2);
    expect(await f.h.db!.query("select id from platform.operations where workspace_id=$1", [f.h.ids.wsA])).toEqual([]);
  });
  it("system principals remain nonmembers governed by canonical policy, never human approvers", async () => {
    const f = await approved();
    const before = product.reads.length;
    expect(await f.broker.deps.roles.resolve(systemPrincipal(), f.h.ids.wsA)).toEqual({ role: "none" });
    expect((await f.broker.check(requestFor(f.h, "infrastructure.observe", "prod"), systemPrincipal())).decision.outcome).toBe("allow");
    expect(product.reads.length).toBe(before);
    await expect(f.broker.approve({ workspaceId: f.h.ids.wsA, operationId: f.proposal.operation.id, proposalDigest: f.proposal.operation.proposalDigest,
      // Canonical approval first refuses a nonmember; it never reaches the human-session gate.
      approver: systemPrincipal(), session: sessionFor("erin") })).rejects.toMatchObject({ code: "not_found" });
    await noClaim(f.h, f.proposal.operation.id);
  });
  it("the cached native broker admits one current OAuth grant and consumes only its owning approval", async () => {
    const f = await fixture();
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example/"); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example/keys");
    const integrationId = "integration_11111111-1111-4111-8111-111111111111";
    product.grants = [{ subject: "bob", workspaceId: f.h.ids.wsA, integrationId, clientId: "reviewed-client", oauthIssuer: "https://issuer.example/",
      projectIds: [f.h.ids.projA], environmentIds: [f.h.ids.envAProd], scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    const proposal = await f.broker.propose(f.request, { kind: "integration", id: integrationId, name: "Modeled browser-authorized OAuth client", integrationId, onBehalfOf: "bob" });
    await f.broker.approve({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest,
      approver: user("erin"), session: sessionFor("erin") });
    await f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id, holder: `workflow:${proposal.operation.id}`, audience: "worker", leaseMs: 60_000 });
    expect((await repos.operations.get(f.h.db!, f.h.ids.wsA, proposal.operation.id))?.status).toBe("running");
    expect(await f.h.db!.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null", [f.h.ids.wsA, proposal.operation.id])).toHaveLength(1);
    expect(product.grantReads.mock.calls.every(call => call[0] === "bob" && call[1] === f.h.ids.wsA)).toBe(true);
  });
  it.each(["revoked", "expired", "foreign issuer", "duplicate"])("a cached native broker refuses an OAuth grant that became %s before claim", async change => {
    const f = await fixture();
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example/"); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example/keys");
    const integrationId = "integration_11111111-1111-4111-8111-111111111111";
    product.grants = [{ subject: "bob", workspaceId: f.h.ids.wsA, integrationId, clientId: "reviewed-client", oauthIssuer: "https://issuer.example/",
      projectIds: [f.h.ids.projA], environmentIds: [f.h.ids.envAProd], scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    const proposal = await f.broker.propose(f.request, { kind: "integration", id: integrationId, name: "Modeled browser-authorized OAuth client", integrationId, onBehalfOf: "bob" });
    await f.broker.approve({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest,
      approver: user("erin"), session: sessionFor("erin") });
    if (change === "revoked") product.grants[0].revoked = true;
    if (change === "expired") product.grants[0].expiresAt = new Date(0).toISOString();
    if (change === "foreign issuer") product.grants[0].oauthIssuer = "https://foreign-issuer.example/";
    if (change === "duplicate") product.grants.push({ ...product.grants[0], revoked: true });
    await expect(f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id,
      holder: `workflow:${proposal.operation.id}`, audience: "worker", leaseMs: 60_000 })).rejects.toBeDefined();
    await noClaim(f.h, proposal.operation.id);
  });
  it("OAuth revocation committed during the held current membership reply is observed before native claim", async () => {
    const f = await fixture();
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example/"); vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example/keys");
    const integrationId = "integration_11111111-1111-4111-8111-111111111111";
    product.grants = [{ subject: "bob", workspaceId: f.h.ids.wsA, integrationId, clientId: "reviewed-client", oauthIssuer: "https://issuer.example/",
      projectIds: [f.h.ids.projA], environmentIds: [f.h.ids.envAProd], scopes: ["read", "write"], expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    const proposal = await f.broker.propose(f.request, { kind: "integration", id: integrationId, name: "Modeled browser-authorized OAuth client", integrationId, onBehalfOf: "bob" });
    await f.broker.approve({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest,
      approver: user("erin"), session: sessionFor("erin") });
    const entered = deferred<void>(), release = deferred<ReadResponse>();
    product.read = input => { if (input.humanId === "bob") { entered.resolve(); return release.promise; }
      return Promise.resolve({ data: product.members.get(key(input.workspaceId, input.humanId)) ?? null, error: null }); };
    const pending = f.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: proposal.operation.id,
      holder: `workflow:${proposal.operation.id}`, audience: "worker", leaseMs: 60_000 });
    const rejected = expect(pending).rejects.toBeDefined();
    await entered.promise; product.grants[0].revoked = true;
    release.resolve({ data: member(f.h.ids.wsA, "bob", "editor"), error: null });
    await rejected; await noClaim(f.h, proposal.operation.id);
  });

});
