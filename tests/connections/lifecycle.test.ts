/**
 * PROD-LIFE-01 connection administration lifecycle: create, verify, revoke and
 * rotate across GCP, Azure, OCI and AWS, through the registered actions (the same
 * ones the UI and REST routes call). Real PGlite platform store and the real
 * platform credential broker over a synthetic cloud fetch; no live cloud is
 * contacted and nothing here is live-cloud evidence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { GcpConnectionConfig } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-connection-lifecycle-", { fast: true });
const { ctx, seed } = await import("../bridge/support");
const { db, q, readAudit } = await import("@/lib/db/store");
const { runAction } = await import("@/lib/actions/core");
const { ensureEngine } = await import("@/lib/engine/engine");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { executionRoute } = await import("@/lib/bridge/deploy");
const { grant } = await import("../credentials/helpers");
await import("@/lib/actions/defs");

const ws = ctx.workspaceId;
const GCP = {
  region: "asia-south1", projectId: "acme-prod-123456",
  workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc",
  observeServiceAccount: "zenith-observe@acme-prod-123456.iam.gserviceaccount.com",
  deployServiceAccount: "zenith-deploy@acme-prod-123456.iam.gserviceaccount.com",
};
const NEW_OBSERVE = "zenith-observe-v2@acme-prod-123456.iam.gserviceaccount.com";
const AZURE = { region: "eastus", tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", subscriptionId: "33333333-3333-4333-8333-333333333333" };
const OCI = { region: "us-ashburn-1", tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaafixture", compartmentOcid: "ocid1.compartment.oc1..aaaaaaaafixture" };
const AWS = { accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/ZenithObserve", deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeploy" };

let sql: PlatformDbHandle;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
/** Service accounts the synthetic Google refuses to impersonate. */
const denied = new Set<string>();
const impersonated: string[] = [];
const awsSeen: unknown[] = [];

function syntheticCloud() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "https://sts.googleapis.com/v1/token") return Response.json({ access_token: "synthetic-federated-token" });
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      const account = [...denied, GCP.observeServiceAccount, GCP.deployServiceAccount, NEW_OBSERVE].find((sa) => url.includes(encodeURIComponent(sa)));
      if (account) impersonated.push(account);
      if (account && denied.has(account)) return new Response("{}", { status: 403 });
      return Response.json({ accessToken: "synthetic-access-token", expireTime: new Date(Date.now() + 900_000).toISOString() });
    }
    if (url.startsWith("https://cloudresourcemanager.googleapis.com/v3/projects/")) return Response.json({ projectId: GCP.projectId });
    if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "synthetic-azure-token", token_type: "Bearer", expires_in: 900 });
    if (url.startsWith("https://management.azure.com/subscriptions/")) return Response.json({ subscriptionId: AZURE.subscriptionId });
    return new Response("{}", { status: 404 });
  });
}
let fetchImpl = syntheticCloud();
const realBroker = (candidate?: { workspaceId: string; connectionId: string; config: GcpConnectionConfig }) =>
  platformCredentialBroker(sql, { oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl, ...(candidate ? { verifyCandidate: candidate } : {}) });

const exec = async (action: string, value: unknown, actorId = "admin-a") =>
  (await runAction(action, { ...ctx, actor: { ...ctx.actor, id: actorId } }, value, { mode: "execute" })).result!;
const planOf = async (action: string, value: unknown) => (await runAction(action, ctx, value, { mode: "plan" })).plan!;
const data = <T,>(result: { data?: unknown }) => result.data as T;

async function createGcp(): Promise<string> {
  const r = await exec("connection.createGcp", GCP);
  expect(r.ok, r.error).toBe(true);
  return data<{ connectionId: string }>(r).connectionId;
}
async function registerRunner(capabilities: string[] = ["oci.http"], name = "oci-runner") {
  const token = repos.runners.generateRegistrationToken("runner");
  await repos.runners.createRegistrationToken(sql, { workspaceId: ws, kind: "runner", createdBy: "admin-a", tokenHash: token.tokenHash });
  return (await repos.runners.registerRunner(sql, { tokenHash: token.tokenHash, name, publicKey: "A".repeat(43), capabilities })).id;
}

beforeAll(async () => {
  sql = await openPlatformDb({ kind: "pglite" });
  signer = LocalJwkSigner.fromJwk("lifecycle-test", (await generateSigningJwk("RS256")).privateJwk, { alg: "RS256" });
}, 60_000);
afterAll(async () => { await sql?.close(); });
beforeEach(() => {
  seed(); ensureEngine(); denied.clear(); impersonated.length = 0; awsSeen.length = 0;
  fetchImpl = syntheticCloud();
  vi.stubEnv("ZENITH_OIDC_ISSUER", "https://zenith.test/api/oidc");
  setBridgeDepsForTests({
    connectionSql: async () => sql,
    providerBroker: async (handle, candidate) => platformCredentialBroker(handle, { oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl, ...(candidate ? { verifyCandidate: candidate } : {}) }),
    credentialBroker: async (resolve) => ({ verifyConnection: async (id) => { awsSeen.push((await resolve(id))?.config); return { ok: true, detail: "Assumed the observe role in account 123456789012." }; } }),
    readiness: async (provider) => ({ provider: provider as "gcp", ready: true, checks: [], checkedAt: new Date().toISOString() }),
    platformConnection: async (workspaceId, id) => repos.connections.get(sql, workspaceId, id),
  });
});
afterEach(() => { setBridgeDepsForTests(null); vi.unstubAllEnvs(); });

describe("create", () => {
  it("saves GCP, Azure and OCI as pending, with the exact workload subject and a creation event", async () => {
    const runnerId = await registerRunner();
    const gcp = await exec("connection.createGcp", GCP);
    const azure = await exec("connection.createAzure", AZURE);
    const oci = await exec("connection.createOci", { ...OCI, runnerId });
    for (const r of [gcp, azure, oci]) expect(r.ok, r.error).toBe(true);
    const g = data<{ connectionId: string; trust: { subject: string; steps: string[] } }>(gcp);
    expect(g.trust.subject).toBe(`zenith:ws:${ws}:conn:${g.connectionId}`);
    expect(g.trust.steps.join(" ")).toContain("workloadIdentityUser");
    expect(await repos.connections.get(sql, ws, g.connectionId)).toMatchObject({ status: "pending_verification", legacyConnectionId: g.connectionId, config: { provider: "gcp", mode: "oidc_web_identity", projectId: GCP.projectId } });
    expect(q.connection(g.connectionId)).toMatchObject({ provider: "gcp", status: "connecting", platformConnectionId: g.connectionId });
    const o = data<{ connectionId: string }>(oci).connectionId;
    expect(await repos.connections.get(sql, ws, o)).toMatchObject({ status: "pending_verification", config: { provider: "oci", mode: "runner", runnerId } });
    expect(q.connection(o)).toBeUndefined();
    const created = (await repos.events.list(sql, ws, { type: "connection.created" })).map((e) => e.data.connectionId);
    expect(created).toEqual(expect.arrayContaining([g.connectionId, o]));
  });

  it.each([
    ["foreign service account", "connection.createGcp", { ...GCP, observeServiceAccount: "not-an-email" }],
    ["secret field", "connection.createGcp", { ...GCP, privateKey: "CANARY" }],
    ["bad tenant guid", "connection.createAzure", { ...AZURE, tenantId: "tenant" }],
    ["client secret field", "connection.createAzure", { ...AZURE, clientSecret: "CANARY" }],
    ["bad tenancy ocid", "connection.createOci", { ...OCI, tenancyOcid: "tenancy", runnerId: "run_x" }],
  ])("rejects %s before any write", async (_name, action, input) => {
    const before = (await repos.connections.list(sql, ws)).length;
    const r = await exec(action, input);
    expect(r.ok).toBe(false); expect(r.summary).toBe("Invalid input."); expect(JSON.stringify(r)).not.toContain("CANARY");
    expect((await repos.connections.list(sql, ws)).length).toBe(before);
  });

  it("refuses an OCI connection whose runner is unknown or revoked", async () => {
    expect((await exec("connection.createOci", { ...OCI, runnerId: "run_missing" })).error).toContain("not registered");
    const runnerId = await registerRunner();
    await repos.runners.revokeRunner(sql, ws, runnerId);
    expect((await exec("connection.createOci", { ...OCI, runnerId })).error).toContain("revoked");
  });

  it("is admin and human only", async () => {
    expect((await exec("connection.createGcp", GCP, "editor")).error).toContain("role_denied");
    const integration = await runAction("connection.createGcp", { ...ctx, integration: { operationId: "op", clientId: "agent", proposalDigest: "d" } }, GCP, { mode: "execute" });
    expect(integration.result!.ok).toBe(false);
    expect((await planOf("connection.createGcp", GCP)).blocked).toBeUndefined();
  });

  it("is blocked, not half saved, when the OIDC issuer is unset", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", "");
    const before = (await repos.connections.list(sql, ws)).length;
    expect((await exec("connection.createGcp", GCP)).error).toContain("ZENITH_OIDC_ISSUER");
    expect((await repos.connections.list(sql, ws)).length).toBe(before);
  });
});

describe("verify", () => {
  it("records a GCP pass through the real federation path and says what it did not prove", async () => {
    const id = await createGcp();
    const r = await exec("connection.verify", { connectionId: id }, "editor");
    expect(r.ok, r.error).toBe(true);
    expect(r.summary).toContain("deploy permissions remain unverified");
    expect(await repos.connections.get(sql, ws, id)).toMatchObject({ status: "verified", verificationDetail: expect.stringContaining("configured project") });
    expect(q.connection(id)).toMatchObject({ status: "healthy", lastCheckedAt: expect.any(String) });
    expect(impersonated).toEqual([GCP.observeServiceAccount]);
  });

  it("records a GCP failure and keeps the connection unusable", async () => {
    const id = await createGcp();
    denied.add(GCP.observeServiceAccount);
    const r = await exec("connection.verify", { connectionId: id });
    expect(r.ok).toBe(false);
    expect(await repos.connections.get(sql, ws, id)).toMatchObject({ status: "failed" });
    expect(q.connection(id)).toMatchObject({ status: "disconnected" });
  });

  it("verifies Azure through the broker", async () => {
    const r0 = await exec("connection.createAzure", AZURE);
    const id = data<{ connectionId: string }>(r0).connectionId;
    const r = await exec("connection.verify", { connectionId: id });
    expect(r.ok, r.error).toBe(true);
    expect(await repos.connections.get(sql, ws, id)).toMatchObject({ status: "verified" });
  });

  it("verifies OCI by runner readiness only, and fails without oci.http", async () => {
    const good = data<{ connectionId: string }>(await exec("connection.createOci", { ...OCI, runnerId: await registerRunner(["oci.http"]) })).connectionId;
    const ok = await exec("connection.verify", { connectionId: good });
    expect(ok.ok, ok.error).toBe(true);
    expect(ok.summary).toContain("remain unverified");
    const bad = data<{ connectionId: string }>(await exec("connection.createOci", { ...OCI, runnerId: await registerRunner(["tofu.run"], "no-oci") })).connectionId;
    expect((await exec("connection.verify", { connectionId: bad })).ok).toBe(false);
    expect(await repos.connections.get(sql, ws, bad)).toMatchObject({ status: "failed" });
  });

  it("delegates AWS to the existing observe-role verification", async () => {
    const aws = data<{ connectionId: string }>(await exec("connection.createAws", AWS)).connectionId;
    const r = await exec("connection.verify", { connectionId: aws });
    expect(r.ok, r.error).toBe(true);
    expect(await repos.connections.get(sql, ws, aws)).toMatchObject({ status: "verified" });
  });

  it("answers a foreign id exactly like a missing one", async () => {
    const id = await createGcp();
    const foreign = await runAction("connection.verify", { ...ctx, workspaceId: "someone-else" }, { connectionId: id }, { mode: "execute" });
    const missing = await exec("connection.verify", { connectionId: "missing" });
    expect(foreign.result!.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(missing.ok).toBe(false);
  });

  it("viewers cannot verify", async () => {
    const id = await createGcp();
    expect((await exec("connection.verify", { connectionId: id }, "viewer")).error).toContain("role_denied");
  });
});

describe("revoke", () => {
  async function verifiedGcp() {
    const id = await createGcp();
    expect((await exec("connection.verify", { connectionId: id })).ok).toBe(true);
    return id;
  }
  const withSession = (id: string) => realBroker().withSession(
    { connectionId: id, purpose: "deploy", grant: grant({ ws, cap: "infrastructure.apply" }) }, async (session) => session.provider);

  it("blocks the very next dispatch with no fallback to the engine or another connection", async () => {
    const id = await verifiedGcp();
    db().environments[0].connectionId = id;
    expect(await withSession(id)).toBe("gcp");
    expect((await executionRoute(db().environments[0])).kind).toBe("workflow");

    const r = await exec("connection.revoke", { connectionId: id, reason: "key leaked" });
    expect(r.ok, r.error).toBe(true);

    const calls = fetchImpl.mock.calls.length;
    await expect(withSession(id)).rejects.toMatchObject({ reason: "connection_revoked" });
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect((await executionRoute(db().environments[0])).kind).toBe("unverified");
    expect(q.connection(id)).toMatchObject({ status: "disconnected", revokedAt: expect.any(String) });
    expect(await repos.connections.get(sql, ws, id)).toMatchObject({ status: "revoked", revokedAt: expect.any(String) });
    expect((await exec("connection.verify", { connectionId: id })).error).toContain("revoked");
    expect((await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } })).ok).toBe(false);
  });

  it("is idempotent, audited, and leaves one event", async () => {
    const id = await verifiedGcp();
    const first = await exec("connection.revoke", { connectionId: id });
    const second = await exec("connection.revoke", { connectionId: id });
    expect(first.ok && second.ok).toBe(true);
    expect(data<{ alreadyRevoked: boolean }>(second).alreadyRevoked).toBe(true);
    const events = (await repos.events.list(sql, ws, { type: "connection.revoked" })).filter((e) => e.data.connectionId === id);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toMatchObject({ kind: "user", id: "admin-a" });
    expect(readAudit().filter((a) => a.actionId === "connection.revoke" && a.result === "ok").length).toBeGreaterThanOrEqual(1);
  });

  it("discards an open rotation candidate", async () => {
    const id = await verifiedGcp();
    const rotated = await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } });
    const rotationId = data<{ rotationId: string }>(rotated).rotationId;
    await exec("connection.revoke", { connectionId: id });
    expect((await repos.connectionRotations.get(sql, ws, rotationId))!.status).toBe("aborted");
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId })).ok).toBe(false);
  });

  it("plan lists the environments that will stop deploying and the terminal nature", async () => {
    const id = await verifiedGcp();
    db().environments[0].connectionId = id;
    const plan = await planOf("connection.revoke", { connectionId: id });
    const text = plan.details.join(" ");
    expect(text).toContain("immediately"); expect(text).toContain("no fallback"); expect(text).toContain("terminal"); expect(text).toContain("Bridge/staging");
    expect(plan.risk).toBe("high");
  });

  it("is admin only and tenant scoped", async () => {
    const id = await verifiedGcp();
    expect((await exec("connection.revoke", { connectionId: id }, "editor")).error).toContain("role_denied");
    const foreign = await runAction("connection.revoke", { ...ctx, workspaceId: "someone-else" }, { connectionId: id }, { mode: "execute" });
    expect(foreign.result!.ok).toBe(false);
    expect((await repos.connections.get(sql, ws, id))!.status).toBe("verified");
  });

  it("disconnect of a platform-linked connection revokes its platform record", async () => {
    const id = await createGcp();
    const r = await exec("connection.disconnect", { connectionId: id });
    expect(r.ok, r.error).toBe(true);
    expect(q.connection(id)).toBeUndefined();
    expect((await repos.connections.get(sql, ws, id))!.status).toBe("revoked");
  });
});

describe("rotate without downtime", () => {
  async function verifiedGcp() {
    const id = await createGcp();
    expect((await exec("connection.verify", { connectionId: id })).ok).toBe(true);
    return id;
  }
  const deploy = (id: string) => realBroker().withSession(
    { connectionId: id, purpose: "deploy", grant: grant({ ws, cap: "infrastructure.apply" }) }, async (session) => session.provider);

  it("stages and verifies the candidate while the current access keeps serving, then promotes atomically", async () => {
    const id = await verifiedGcp();
    impersonated.length = 0;
    const staged = await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } });
    expect(staged.ok, staged.error).toBe(true);
    const out = data<{ rotationId: string; promoted: boolean; verified: boolean }>(staged);
    expect(out).toMatchObject({ promoted: false, verified: true });
    // the candidate was exercised under the same connection id, not the live row
    expect(impersonated).toEqual([NEW_OBSERVE]);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ observeServiceAccount: GCP.observeServiceAccount });
    // downtime check: live access still serves a deploy session mid-rotation
    expect(await deploy(id)).toBe("gcp");
    expect((await repos.connections.get(sql, ws, id))!.status).toBe("verified");

    const promoted = await exec("connection.promoteRotation", { connectionId: id, rotationId: out.rotationId });
    expect(promoted.ok, promoted.error).toBe(true);
    expect((await repos.connections.get(sql, ws, id))).toMatchObject({ status: "verified", config: { observeServiceAccount: NEW_OBSERVE, projectId: GCP.projectId } });
    expect(await deploy(id)).toBe("gcp");
    expect((await repos.connectionRotations.get(sql, ws, out.rotationId))!.status).toBe("promoted");
    const kinds = (await repos.events.list(sql, ws, {})).map((e) => e.type);
    expect(kinds).toEqual(expect.arrayContaining(["connection.rotation_staged", "connection.rotated"]));
  });

  it("never promotes a candidate that failed verification, and the live access is untouched", async () => {
    const id = await verifiedGcp();
    denied.add(NEW_OBSERVE);
    const staged = await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE }, promote: true });
    expect(staged.ok).toBe(false);
    const rotationId = data<{ rotationId: string }>(staged).rotationId;
    expect((await repos.connectionRotations.get(sql, ws, rotationId))!.status).toBe("failed");
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId })).error).toContain("not passed verification");
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ observeServiceAccount: GCP.observeServiceAccount });
    expect(await deploy(id)).toBe("gcp");
  });

  it("promote: true switches in one call only when the candidate verifies", async () => {
    const id = await verifiedGcp();
    const r = await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE }, promote: true });
    expect(r.ok, r.error).toBe(true);
    expect(data<{ promoted: boolean }>(r).promoted).toBe(true);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ observeServiceAccount: NEW_OBSERVE });
  });

  it("cannot change the pinned identity, mode or add secrets", async () => {
    const id = await verifiedGcp();
    for (const patch of [{ projectId: "another-project-1" }, { mode: "runner" }, { privateKey: "CANARY" }, {}]) {
      const r = await exec("connection.rotate", { connectionId: id, patch });
      expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toContain("CANARY");
    }
    expect((await repos.connectionRotations.getOpen(sql, ws, id))).toBeNull();
  });

  it("refuses a stale verification and a connection that changed after staging", async () => {
    const id = await verifiedGcp();
    const first = data<{ rotationId: string }>(await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } }));
    await sql.query("update platform.connection_rotations set verified_at = clock_timestamp() - interval '2 hours' where id = $1", [first.rotationId]);
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId: first.rotationId })).error).toContain("verified too long ago");

    const second = data<{ rotationId: string }>(await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } }));
    expect((await repos.connectionRotations.get(sql, ws, first.rotationId))!.status).toBe("superseded");
    await sql.query("update platform.provider_connections set config = jsonb_set(config, '{deployServiceAccount}', to_jsonb($2::text)) where id = $1", [id, "zenith-deploy-v3@acme-prod-123456.iam.gserviceaccount.com"]);
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId: second.rotationId })).error).toContain("changed after");
  });

  it("abort discards the candidate and keeps serving", async () => {
    const id = await verifiedGcp();
    const { rotationId } = data<{ rotationId: string }>(await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } }));
    expect((await exec("connection.abortRotation", { connectionId: id, rotationId })).ok).toBe(true);
    expect((await repos.connectionRotations.get(sql, ws, rotationId))!.status).toBe("aborted");
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ observeServiceAccount: GCP.observeServiceAccount });
    expect(await deploy(id)).toBe("gcp");
  });

  it("only an admin can rotate, promote or abort", async () => {
    const id = await verifiedGcp();
    expect((await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } }, "editor")).error).toContain("role_denied");
    const { rotationId } = data<{ rotationId: string }>(await exec("connection.rotate", { connectionId: id, patch: { observeServiceAccount: NEW_OBSERVE } }));
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId }, "editor")).error).toContain("role_denied");
    expect((await exec("connection.abortRotation", { connectionId: id, rotationId }, "viewer")).error).toContain("role_denied");
  });

  it("rotates an OCI runner binding: the new runner must be active, the old one serves until promotion", async () => {
    const oldRunner = await registerRunner(["oci.http"], "old");
    const id = data<{ connectionId: string }>(await exec("connection.createOci", { ...OCI, runnerId: oldRunner })).connectionId;
    expect((await exec("connection.verify", { connectionId: id })).ok).toBe(true);
    expect((await exec("connection.rotate", { connectionId: id, patch: { runnerId: "run_missing" } })).error).toContain("not registered");
    const newRunner = await registerRunner(["oci.http"], "new");
    const r = await exec("connection.rotate", { connectionId: id, patch: { runnerId: newRunner } });
    expect(r.ok, r.error).toBe(true);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ runnerId: oldRunner });
    const { rotationId } = data<{ rotationId: string }>(r);
    expect((await exec("connection.promoteRotation", { connectionId: id, rotationId })).ok).toBe(true);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ runnerId: newRunner });
    expect((await repos.runners.getRunner(sql, ws, oldRunner))!.status).toBe("active");
  });

  it("AWS: presents the candidate under the live connection id, constrained to the same account", async () => {
    const id = data<{ connectionId: string }>(await exec("connection.createAws", AWS)).connectionId;
    expect((await exec("connection.verify", { connectionId: id })).ok).toBe(true);
    awsSeen.length = 0;
    const foreign = await exec("connection.rotate", { connectionId: id, patch: { deployRoleArn: "arn:aws:iam::210987654321:role/Other" } });
    expect(foreign.ok).toBe(false); expect(foreign.error).toContain("account 123456789012");
    const r = await exec("connection.rotate", { connectionId: id, patch: { deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployV2" } });
    expect(r.ok, r.error).toBe(true);
    expect(awsSeen).toEqual([expect.objectContaining({ deployRoleArn: "arn:aws:iam::123456789012:role/ZenithDeployV2", accountId: AWS.accountId })]);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ deployRoleArn: AWS.deployRoleArn });
  });

  it("AWS assume-role: a new ExternalId is generated and returned once, applied only on promotion", async () => {
    const created = await exec("connection.createAws", { ...AWS, mode: "aws_assume_role" });
    const { connectionId: id, externalId: before } = data<{ connectionId: string; externalId: string }>(created);
    expect((await exec("connection.verify", { connectionId: id })).ok).toBe(true);
    const r = await exec("connection.rotate", { connectionId: id, patch: { rotateExternalId: true } });
    expect(r.ok, r.error).toBe(true);
    const { externalId: next, rotationId } = data<{ externalId: string; rotationId: string }>(r);
    expect(next).toMatch(/^zenith-[a-f0-9]{32}$/); expect(next).not.toBe(before);
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ externalId: before });
    await exec("connection.promoteRotation", { connectionId: id, rotationId });
    expect((await repos.connections.get(sql, ws, id))!.config).toMatchObject({ externalId: next });
    expect(JSON.stringify(await repos.events.list(sql, ws, {}))).not.toContain(next);
    // OIDC connections have no ExternalId to rotate
    const oidc = data<{ connectionId: string }>(await exec("connection.createAws", AWS)).connectionId;
    expect((await exec("connection.rotate", { connectionId: oidc, patch: { rotateExternalId: true } })).ok).toBe(false);
  });
});
