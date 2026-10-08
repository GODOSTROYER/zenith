/** Direct route contracts: real product auth boundary, PGlite/native platform
 * SQL and signed runner registration. Identity provider responses are fixtures;
 * this is not operated browser, cloud or default-stack evidence. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { MFA_REQUIRED } from "@/lib/auth/mfa";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-runner-connections-", { fast: true });
process.env.ZENITH_STORE = "file";
const auth = vi.hoisted(() => ({ user: { id: "admin", email: "admin@zenith.test", name: "Admin" } as SessionUser | null, unavailable: false, credentialWorkspace: "", credentialSubject: "admin", aal: "aal2" as "aal1" | "aal2", sql: null as PlatformDbHandle | null }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "https://identity.zenith.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: {
  getClaims: async () => ({ data: { claims: { sub: auth.user?.id, aal: auth.aal, exp: Date.now() / 1000 + 600 } }, error: auth.unavailable ? { status: 503 } : null }),
  getUser: async () => ({ data: { user: auth.user ? { ...auth.user, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } : null }, error: auth.unavailable ? { status: 503 } : null }),
} }) }));
vi.mock("@/lib/controlplane/db/open", async original => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => auth.sql! }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => auth.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => ({ verify: async () => ({ id: "linked-fixture", workspaceId: auth.credentialWorkspace, subject: auth.credentialSubject }) }) }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => {
  if (auth.unavailable) throw new Error("identity fixture unavailable");
  return { subject: auth.user?.id, emailVerified: true };
} }));

const { NextRequest } = await import("next/server");
const { POST: create } = await import("@/app/api/platform/v1/connections/route");
const { POST: verify } = await import("@/app/api/platform/v1/connections/[id]/verify/route");
const { POST: rotate } = await import("@/app/api/platform/v1/connections/[id]/rotate/route");
const { POST: revoke } = await import("@/app/api/platform/v1/connections/[id]/revoke/route");
const { POST: promote } = await import("@/app/api/platform/v1/connections/[id]/rotation/promote/route");
const { POST: abort } = await import("@/app/api/platform/v1/connections/[id]/rotation/abort/route");
const { POST: register } = await import("@/app/api/platform/v1/runners/register/route");
const { POST: centralAction } = await import("@/app/api/actions/[actionId]/route");
const { registerAllActions } = await import("@/lib/actions/defs");
registerAllActions();
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { resetDb, q, readAudit } = await import("@/lib/db/store");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { createPlatformRunnerStore } = await import("@/lib/runners/db/pg-store");
const { createPlane, registerFakeAgent, teardownPlane, call } = await import("../runners/_support");

const inputs = {
  aws: { accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" },
  gcp: { projectId: "runner-fixture-123", region: "us-central1", workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc", observeServiceAccount: "observe@runner-fixture-123.iam.gserviceaccount.com", deployServiceAccount: "deploy@runner-fixture-123.iam.gserviceaccount.com" },
  azure: { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", subscriptionId: "33333333-3333-4333-8333-333333333333", region: "eastus" },
  oci: { tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaafixture", compartmentOcid: "ocid1.compartment.oc1..aaaaaaaafixture", region: "us-ashburn-1" },
  kubernetes: { server: "https://kubernetes.zenith.test", namespaces: ["customer"] },
} as const;
type Provider = keyof typeof inputs;
const kinds = { aws: "aws.http", gcp: "tofu.run", azure: "tofu.run", oci: "oci.http", kubernetes: "k8s.http" };
const origin = "https://zenith.test";
const invalidBrowserHeaders: Record<string, string>[] = [{ origin: "https://attacker.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "x-zenith-actor": "navigator" }];
async function http(handler: unknown, connectionId: string, body: unknown = {}, headers: Record<string, string> = {}, suffix = "") {
  suffix ||= new Map<unknown, string>([[verify, "/verify"], [rotate, "/rotate"], [revoke, "/revoke"], [promote, "/rotation/promote"], [abort, "/rotation/abort"]]).get(handler) ?? "";
  if (handler === create) connectionId = "";
  return call(handler, new NextRequest(`${origin}/api/platform/v1/connections${connectionId ? `/${connectionId}${suffix}` : ""}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { id: connectionId });
}
const data = (res: Awaited<ReturnType<typeof http>>) => res.body.data as { connectionId: string; rotationId: string; status: string; scope: string; promoted: boolean; runnerKept?: string; runnerRevoked?: { id: string } };

function suite(native: boolean) {
  describe.skipIf(native && !process.env.ZENITH_TEST_PLATFORM_PG_URL)(native ? "native PostgreSQL route contracts (needs ZENITH_TEST_PLATFORM_PG_URL)" : "PGlite route contracts", () => {
    let sql: PlatformDbHandle;
    let plane: Awaited<ReturnType<typeof createPlane>>;
    const workspaceId = `ws-runner-${randomUUID()}`;
    const foreign = `ws-foreign-${randomUUID()}`;
    beforeAll(async () => {
      sql = await openPlatformDb(native ? { kind: "postgres", url: process.env.ZENITH_TEST_PLATFORM_PG_URL!, max: 1, migrate: true } : { kind: "pglite" });
    }, 60_000);
    afterAll(async () => {
      if (!sql) return;
      if (native) {
        for (const table of ["connection_rotations", "provider_connections", "runners", "runner_registration_tokens", "events"]) await sql.query(`delete from platform.${table} where workspace_id in ($1,$2)`, [workspaceId, foreign]);
      }
      await sql.close();
    });
    beforeEach(async () => {
      const createdAt = new Date().toISOString();
      resetDb({ workspaces: [workspaceId, foreign].map(id => ({ id, name: id, slug: id, createdAt })), members: ["admin", "editor", "viewer"].map(id => ({ id, workspaceId, role: id as "admin" | "editor" | "viewer", name: id, email: `${id}@zenith.test` })) });
      auth.user = { id: "admin", email: "admin@zenith.test", name: "Admin" }; auth.unavailable = false; auth.aal = "aal2"; auth.sql = sql;
      auth.credentialWorkspace = workspaceId; auth.credentialSubject = "admin";
      vi.stubEnv("ZENITH_OIDC_ISSUER", "");
      vi.stubEnv("ZENITH_PLATFORM_ORIGIN", origin);
      setBridgeDepsForTests({ connectionSql: async () => sql, providerBroker: async () => { throw new Error("Runner readiness must not open a cloud broker"); }, credentialBroker: async () => { throw new Error("Runner readiness must not open an AWS broker"); } });
      plane = await createPlane("real", {}, createPlatformRunnerStore(sql));
    });
    afterEach(() => { teardownPlane(); setBridgeDepsForTests(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    const runner = async (provider: Provider = "aws", overrides: { workspaceId?: string; capabilities?: string[]; labels?: Record<string, string> } = {}) => registerFakeAgent(plane, register, { workspaceId, capabilities: [kinds[provider]], ...overrides });
    const body = (provider: Provider, runnerId: string) => ({ provider, mode: "runner", ...inputs[provider], runnerId });
    const make = async (provider: Provider = "aws", runnerId?: string) => {
      const res = await http(create, "", body(provider, runnerId ?? (await runner(provider)).id));
      expect(res.status).toBe(201); expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
      return data(res).connectionId;
    };
    const action = async (actionId: string, input: unknown, headers: Record<string, string> = {}, mode = "execute") => call(centralAction, new NextRequest(`${origin}/api/actions/${actionId}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify({ mode, input }) }), { actionId });
    it.each(["connection.createRunner", "connection.rotate", "connection.promoteRotation", "connection.abortRotation"])("central %s has the same browser-only boundary", async actionId => {
      for (const headers of [...invalidBrowserHeaders, { authorization: `Bearer ${randomBytes(24).toString("base64url")}` }]) expect((await action(actionId, {}, headers)).status).toBe(403);
      auth.unavailable = true; expect((await action(actionId, {})).status).toBe(503); auth.unavailable = false;
      auth.user = null; expect((await action(actionId, {})).status).toBe(401);
      expect(readAudit().filter(row => row.actionId === actionId)).toEqual([]);
    });
    it("central create/verify/rotate/promote/abort/revoke preserve lifecycle and human confirmation", async () => {
      const first = await runner(), next = await runner();
      const made = await action("connection.createRunner", body("aws", first.id));
      expect(made.status).toBe(200);
      const created = made.body.result as { ok: boolean; data: { connectionId: string } };
      expect(created.ok).toBe(true); const id = created.data.connectionId;
      const checkedPlan = await action("connection.verify", { connectionId: id }, {}, "plan");
      expect(JSON.stringify(checkedPlan.body.plan)).toContain("readiness pass does not prove cloud identity");
      expect((await action("connection.verify", { connectionId: id })).body.result).toMatchObject({ ok: true });
      const rotationPlan = await action("connection.rotate", { connectionId: id, patch: { runnerId: next.id } }, {}, "plan");
      expect(rotationPlan.body.plan).toMatchObject({ requiredRole: "admin", requiresApproval: true });
      const staged = await action("connection.rotate", { connectionId: id, patch: { runnerId: next.id } });
      const candidate = staged.body.result as { ok: boolean; data: { rotationId: string } };
      expect(candidate.ok).toBe(true); expect((await repos.connections.get(sql, workspaceId, id))?.config).toMatchObject({ runnerId: first.id });
      for (const actionId of ["connection.promoteRotation", "connection.abortRotation"]) expect((await action(actionId, { connectionId: id, rotationId: candidate.data.rotationId }, {}, "plan")).body.plan).toMatchObject({ requiresApproval: true, requiredRole: "admin" });
      expect((await action("connection.abortRotation", { connectionId: id, rotationId: candidate.data.rotationId })).body.result).toMatchObject({ ok: true });
      const rotated = await action("connection.rotate", { connectionId: id, patch: { runnerId: next.id } });
      const rotationId = (rotated.body.result as { data: { rotationId: string } }).data.rotationId;
      expect((await action("connection.promoteRotation", { connectionId: id, rotationId })).body.result).toMatchObject({ ok: true });
      expect((await repos.connections.get(sql, workspaceId, id))?.config).toMatchObject({ runnerId: next.id });
      auth.user = { id: "editor", name: "Editor", email: "editor@zenith.test" };
      expect((await action("connection.revoke", { connectionId: id })).body.result).toMatchObject({ ok: false });
      auth.user = { id: "admin", name: "Admin", email: "admin@zenith.test" };
      expect((await action("connection.revoke", { connectionId: id })).body.result).toMatchObject({ ok: true });
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("revoked");
      expect(readAudit().filter(row => row.actionId.startsWith("connection.")).map(row => row.actionId)).toEqual(expect.arrayContaining(["connection.createRunner", "connection.verify", "connection.rotate", "connection.promoteRotation", "connection.abortRotation", "connection.revoke"]));
    });
    it("requires current AAL2 before creating a runner connection", async () => {
      const agent = await runner();
      const before = await repos.connections.list(sql, workspaceId, { includeRevoked: true });
      auth.aal = "aal1";
      expect((await http(create, "", body("aws", agent.id))).status).toBe(403);
      expect(await repos.connections.list(sql, workspaceId, { includeRevoked: true })).toEqual(before);
    });

    it.each(Object.keys(inputs) as Provider[])("creates, verifies, rotates and revokes a %s customer runner through handlers", async provider => {
      const first = await runner(provider), next = await runner(provider);
      const id = await make(provider, first.id);
      expect(await repos.connections.get(sql, workspaceId, id)).toMatchObject({ status: "pending_verification", config: { mode: "runner", runnerId: first.id } });
      const checked = await http(verify, id);
      expect(checked.body.ok).toBe(true); expect(data(checked).scope).toContain("permissions remain unverified");
      if (provider !== "oci") expect(q.connection(id)).toMatchObject({ status: "healthy", platformConnectionId: id });
      const staged = await http(rotate, id, { patch: { runnerId: next.id } });
      expect(staged.body.ok).toBe(true); expect(data(staged).promoted).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))?.config).toMatchObject({ runnerId: first.id });
      const swapped = await http(promote, id, { rotationId: data(staged).rotationId });
      expect(swapped.body.ok).toBe(true);
      expect((await repos.connections.get(sql, workspaceId, id))?.config).toMatchObject({ runnerId: next.id });
      expect((await http(revoke, id)).body.ok).toBe(true);
      expect((await http(verify, id)).body.ok).toBe(false);
      expect((await http(rotate, id, { patch: { runnerId: first.id }, promote: true })).body.ok).toBe(false);
      expect(await repos.connections.get(sql, workspaceId, id)).toMatchObject({ status: "revoked" });
      const events = (await repos.events.list(sql, workspaceId, { limit: 500 })).filter(e => e.data.connectionId === id);
      expect(events.map(e => e.type)).toEqual(["connection.created", "connection.verified", "connection.rotation_staged", "connection.rotated", "connection.revoked"]);
      expect(events.every(e => e.actor?.id === "admin")).toBe(true);
      expect(readAudit().filter(e => e.actionId.startsWith("connection.")).map(e => e.actionId)).toEqual(expect.arrayContaining(["connection.createRunner", "connection.verify", "connection.rotate", "connection.promoteRotation", "connection.revoke"]));
    });
    it.each([create, rotate, promote, abort])("refuses bearer credentials at a browser-only handler", async handler => {
      const before = await repos.connections.list(sql, workspaceId, { includeRevoked: true });
      const auditBefore = readAudit();
      const res = await http(handler, "conn-fixture", {}, { authorization: `Bearer ${randomBytes(24).toString("base64url")}` });
      expect(res.status).toBe(403); expect(res.body.error?.message).toBe(MFA_REQUIRED);
      expect(await repos.connections.list(sql, workspaceId, { includeRevoked: true })).toEqual(before);
      expect(readAudit()).toEqual(auditBefore);
    });
    it.each(invalidBrowserHeaders)("refuses browser proof %j", async headers => {
      expect((await http(create, "", {}, headers)).status).toBe(403);
    });
    it("refuses an identity-authority outage", async () => {
      auth.unavailable = true;
      expect((await http(create, "", {})).status).toBe(503);
    });
    it("refuses a missing browser session", async () => {
      auth.user = null;
      expect((await http(create, "", {})).status).toBe(401);
    });
    it("allows linked-human verify/revoke, requires exact confirmation and re-reads the role", async () => {
      const id = await make();
      const headers = { authorization: `Bearer za_${randomBytes(24).toString("base64url")}` };
      auth.user = null;
      const refused = await http(verify, id, {}, { authorization: `Bearer ${randomBytes(24).toString("base64url")}` });
      expect(refused.status).toBe(401); expect(refused.body.error?.code).toBe("unauthenticated");
      const verified = await http(verify, id, {}, headers);
      expect(verified.body.ok, JSON.stringify(verified.body)).toBe(true);
      expect((await http(revoke, id, {}, headers)).status).toBe(400);
      expect((await http(revoke, id, { confirm: "different" }, headers)).status).toBe(400);
      auth.credentialSubject = "viewer";
      expect((await http(verify, id, {}, headers)).status).toBe(403);
      expect((await http(revoke, id, { confirm: id }, headers)).status).toBe(403);
      auth.credentialSubject = "admin";
      expect((await http(revoke, id, { confirm: id }, headers)).body.ok).toBe(true);
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("revoked");
    });
    it.each(["editor", "viewer"])("refuses %s creation/rotation/revocation and re-reads current role", async who => {
      const id = await make();
      auth.user = { id: who, name: who, email: `${who}@zenith.test` };
      expect((await http(create, "", body("aws", (await runner()).id))).status).toBe(403);
      expect((await http(rotate, id, { patch: { runnerId: (await runner()).id } })).status).toBe(403);
      expect((await http(revoke, id)).status).toBe(403);
      expect((await http(verify, id)).status).toBe(who === "editor" ? 200 : 403);
    });
    it("treats unknown and foreign runner ids identically without writes", async () => {
      const other = await runner("aws", { workspaceId: foreign });
      const before = (await repos.connections.list(sql, workspaceId)).length;
      for (const id of [other.id, "run_missing"]) {
        const res = await http(create, "", body("aws", id));
        expect(res.body.ok).toBe(false); expect(String(res.body.error)).toContain("not registered in this workspace");
        expect(JSON.stringify(res.body)).not.toContain(foreign);
      }
      expect((await repos.connections.list(sql, workspaceId)).length).toBe(before);
    });
    it("refuses a revoked runner at creation", async () => {
      const agent = await runner(); await repos.runners.revokeRunner(sql, workspaceId, agent.id);
      expect((await http(create, "", body("aws", agent.id))).body.ok).toBe(false);
    });
    it.each(["revoked", "stale", "protocol", "kind", "custody"])("records failed verification for %s runner readiness", async failure => {
      const agent = await runner(); const id = await make("aws", agent.id);
      if (failure === "revoked") await repos.runners.revokeRunner(sql, workspaceId, agent.id);
      if (failure === "stale") await sql.query("update platform.runners set last_heartbeat_at=clock_timestamp()-interval '91 seconds' where workspace_id=$1 and id=$2", [workspaceId, agent.id]);
      if (failure === "protocol") await sql.query("update platform.runners set protocol=$3 where workspace_id=$1 and id=$2", [workspaceId, agent.id, "unsupported/v99"]);
      if (failure === "kind") await sql.query("update platform.runners set capabilities='[]'::jsonb where workspace_id=$1 and id=$2", [workspaceId, agent.id]);
      if (failure === "custody") await sql.query("update platform.runners set labels=$3::text::jsonb where workspace_id=$1 and id=$2", [workspaceId, agent.id, JSON.stringify({ "zenith.credentialMode": "federated" })]);
      const res = await http(verify, id);
      expect(res.body.ok).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("failed");
    });
    it("keeps live access when a candidate fails and refuses promotion after its runner is revoked", async () => {
      const id = await make(); const original = (await repos.connections.get(sql, workspaceId, id))!.config;
      const bad = await runner("aws", { capabilities: ["probe.tcp"] });
      const failed = await http(rotate, id, { patch: { runnerId: bad.id }, promote: true });
      expect(failed.body.ok).toBe(false); expect(data(failed).promoted).toBe(false);
      expect((await http(promote, id, { rotationId: data(failed).rotationId })).body.ok).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))!.config).toEqual(original);
      const good = await runner(); const staged = await http(rotate, id, { patch: { runnerId: good.id } });
      await repos.runners.revokeRunner(sql, workspaceId, good.id);
      expect((await http(promote, id, { rotationId: data(staged).rotationId })).body.ok).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))!.config).toEqual(original);
      expect((await http(abort, id, { rotationId: data(staged).rotationId })).body.ok).toBe(true);
    });
    it("retires only unused runners during promotion and revocation", async () => {
      const first = await runner(), next = await runner();
      const id = await make("aws", first.id), shared = await make("aws", first.id);
      const result = await http(rotate, id, { patch: { runnerId: next.id }, promote: true, retirePreviousRunner: true });
      expect(result.body.ok).toBe(true); expect(data(result).runnerKept).toBe(first.id);
      expect((await repos.runners.getRunner(sql, workspaceId, first.id))?.status).toBe("active");
      expect(data(await http(revoke, shared, { revokeRunner: true })).runnerRevoked?.id).toBe(first.id);
      expect((await repos.runners.getRunner(sql, workspaceId, first.id))?.status).toBe("revoked");
      const last = await runner();
      const final = await http(rotate, id, { patch: { runnerId: last.id }, promote: true, retirePreviousRunner: true });
      expect(data(final).runnerRevoked?.id).toBe(next.id);
      expect((await repos.runners.getRunner(sql, workspaceId, next.id))?.status).toBe("revoked");
    });
    it("preserves identity and refuses secrets, invalid accounts and runner mode conversion", async () => {
      const agent = await runner(); const id = await make("aws", agent.id);
      const secret = randomBytes(32).toString("base64url");
      for (const extra of [{ privateKey: secret }, { observeRoleArn: "arn:aws:iam::999999999999:role/Observe" }]) {
        const res = await http(create, "", { ...body("aws", agent.id), ...extra });
        expect(res.status).toBe(400); expect(JSON.stringify(res.body)).not.toContain(secret);
      }
      for (const server of ["not-a-url", "http://kubernetes.zenith.test", "https://kubernetes.zenith.test/?token=inline"]) {
        expect((await http(create, "", { ...body("kubernetes", agent.id), server })).status).toBe(400);
      }
      for (const patch of [{ accountId: "999999999999" }, { mode: "oidc_web_identity" }, { runnerCustody: "federated" }]) expect((await http(rotate, id, { patch })).body.ok).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))!.config).toMatchObject({ accountId: inputs.aws.accountId, mode: "runner", runnerId: agent.id });
    });
    it("retains existing provider access-field rotation on runner connections", async () => {
      const cases = [
        { provider: "aws" as const, patch: { observeRoleArn: "arn:aws:iam::123456789012:role/ObserveV2" } },
        { provider: "gcp" as const, patch: { observeServiceAccount: "observe-v2@runner-fixture-123.iam.gserviceaccount.com" } },
        { provider: "azure" as const, patch: { clientId: "44444444-4444-4444-8444-444444444444" } },
      ];
      for (const { provider, patch } of cases) {
        const agent = await runner(provider), id = await make(provider, agent.id);
        const result = await http(rotate, id, { patch, promote: true });
        expect(result.body.ok).toBe(true);
        expect((await repos.connections.get(sql, workspaceId, id))!.config).toMatchObject({ ...inputs[provider], ...patch, runnerId: agent.id, mode: "runner" });
      }
    });
    it("replays a browser creation once and refuses an invalid idempotency key", async () => {
      const agent = await runner(); const input = body("aws", agent.id);
      const headers = { "idempotency-key": `create-${randomUUID()}` };
      const first = await http(create, "", input, headers), replay = await http(create, "", input, headers);
      expect(data(replay).connectionId).toBe(data(first).connectionId);
      expect((await repos.events.list(sql, workspaceId, { type: "connection.created", limit: 500 })).filter(e => e.data.connectionId === data(first).connectionId)).toHaveLength(1);
      expect((await http(create, "", input, { "idempotency-key": "short" })).status).toBe(400);
    });
    it("rolls back runner creation and verification when their platform event cannot be written", async () => {
      const agent = await runner();
      const before = (await repos.connections.list(sql, workspaceId)).length;
      const event = vi.spyOn(repos.connections, "appendLifecycleEvent").mockRejectedValue(new Error("event fixture unavailable"));
      expect((await http(create, "", body("aws", agent.id))).body.ok).toBe(false);
      expect((await repos.connections.list(sql, workspaceId)).length).toBe(before);
      event.mockRestore();
      const id = await make("aws", agent.id);
      vi.spyOn(repos.connections, "appendLifecycleEvent").mockRejectedValue(new Error("event fixture unavailable"));
      expect((await http(verify, id)).body.ok).toBe(false);
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("pending_verification");
    });
    if (!native) it("refuses a production verification capture on a PGlite handle without falling back", async () => {
      const id = await make();
      const store = await import("@/lib/db/store");
      const { verifyAnyConnection } = await import("@/lib/connections/service");
      vi.spyOn(store, "isPostgres").mockReturnValue(true);
      await expect(verifyAnyConnection({ workspaceId, actor: { type: "user", id: "admin", name: "Admin" } }, id)).rejects.toThrow("could not be captured");
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("pending_verification");
    });
    it("refuses foreign connection ids for every lifecycle handler", async () => {
      const id = await make();
      resetDb({ workspaces: [{ id: foreign, name: foreign, slug: foreign, createdAt: new Date().toISOString() }], members: [{ id: "admin", workspaceId: foreign, role: "admin", email: "admin@zenith.test", name: "Admin" }] });
      for (const [handler, input] of [[verify, {}], [rotate, { patch: { runnerId: "run_missing" } }], [revoke, {}], [promote, { rotationId: "rot_missing" }], [abort, { rotationId: "rot_missing" }]]) expect((await http(handler, id, input)).status).toBe(404);
      expect((await repos.connections.get(sql, workspaceId, id))?.status).toBe("pending_verification");
    });
  });
}
suite(false);
suite(true);
