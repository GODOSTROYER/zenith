/** Synthetic federation/API contracts with real PGlite repositories; no live cloud evidence. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { ApiException } from "@kubernetes/client-node";
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import type { ConnectionConfig, ProviderSession, KubernetesConnectionConfig, CredentialPurpose } from "@/lib/credentials/types";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { tempDataDir } from "../_support/data-dir";
import { CONNECTION as gcp } from "../providers/gcp/_fake-google";
import { connection as azure } from "../providers/azure/_helpers";

tempDataDir("zenith-verification-contract-", { fast: true });
const kube = vi.hoisted(() => ({ sessions: [] as ProviderSession[], read: vi.fn() }));
vi.mock("@/lib/providers/kubernetes/client", () => ({ createK8sClient: (session: ProviderSession) => { kube.sessions.push(session); return { core: { readNamespacedServiceAccount: kube.read } }; } }));
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { putSecretAsync } = await import("@/lib/secrets");
const { awsConfig, grant: credentialGrant, FAKE_CREDS, FAKE_SECRETS } = await import("../credentials/helpers");
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
const ws = "ws-verification";
const secret = "verification-secret-canary";
const vault = "vault:project/service/KUBE_TOKEN";
const kubernetes: KubernetesConnectionConfig = { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example.test", credentialRef: vault, namespaces: ["payments", "orders", "orders"] };
const oci: ConnectionConfig = { provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..fixture", compartmentOcid: "ocid1.compartment.oc1..fixture", runnerId: "run-verification", region: "us-ashburn-1" };
beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  signer = LocalJwkSigner.fromJwk("verify-test", (await generateSigningJwk("RS256")).privateJwk, { alg: "RS256" });
});
beforeEach(() => {
  vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64));
  kube.sessions.length = 0;
  kube.read.mockReset().mockImplementation(async ({ namespace, name }) => ({ metadata: { namespace, name } }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.close(); });

async function connection(config: ConnectionConfig, workspaceId = ws) {
  return repos.connections.create(db, { workspaceId, config, createdBy: "operator" });
}
function broker(fetchImpl?: typeof fetch) { return platformCredentialBroker(db, { oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl }); }
function cloudFetch(provider: "gcp" | "azure", read: (input: string, init?: RequestInit) => Promise<Response> = async () => Response.json(provider === "gcp" ? { projectId: gcp.projectId } : { subscriptionId: azure.subscriptionId })) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "https://sts.googleapis.com/v1/token") return Response.json({ access_token: "synthetic-federated-token" });
    if (url.startsWith("https://iamcredentials.googleapis.com/")) return Response.json({ accessToken: secret, expireTime: new Date(Date.now() + 900_000).toISOString() });
    if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: secret, token_type: "Bearer", expires_in: 900 });
    return read(url, init);
  });
}
async function assertNoSecret(result: unknown) {
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(await repos.events.list(db, ws, { limit: 100 }))).not.toContain(secret);
  expect(JSON.stringify(await repos.connections.list(db, ws))).not.toContain(secret);
}

describe("credential purpose routing", () => {
  const nonAws = [gcp, azure, { ...kubernetes, mode: "oidc_web_identity" as const }, oci];
  const oidcToken = vi.fn(async () => ({ token: secret, expiresAt: new Date(Date.now() + 900_000).toISOString() }));
  const options = (fetchImpl: typeof fetch) => ({ oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl, kubernetes: { oidcToken } });
  async function verified(config: ConnectionConfig) {
    const c = await connection(config);
    await repos.connections.recordVerification(db, { workspaceId: ws, id: c.id, ok: true, detail: "Synthetic fixture, not live verification." });
    return c;
  }
  async function expectRefusal(config: ConnectionConfig, purpose: CredentialPurpose, cap: string, reason: string, message: string) {
    const c = await verified(config);
    const fetchImpl = cloudFetch(config.provider === "azure" ? "azure" : "gcp");
    const callback = vi.fn(async () => undefined);
    oidcToken.mockClear();
    await expect(platformCredentialBroker(db, options(fetchImpl)).withSession({ connectionId: c.id, purpose, grant: credentialGrant({ ws, cap }) }, callback)).rejects.toMatchObject({ reason, message });
    expect(callback).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(oidcToken).not.toHaveBeenCalled();
    const events = (await repos.events.list(db, ws, { limit: 100 })).filter((event) => event.data.connectionId === c.id);
    expect(events).toEqual([expect.objectContaining({ workspaceId: ws, type: "credential.denied", data: { connectionId: c.id, reason } })]);
    await assertNoSecret(events);
  }

  it.each(nonAws.flatMap((config) => ["secret.write", "infrastructure.observe", "infrastructure.apply"].map((cap) => ({ config, provider: config.provider, cap }))))("refuses $provider secret.write purpose with $cap before credentials", async ({ config, cap }) => {
    await expectRefusal(config, "secret.write", cap, "provider_unsupported", "Secret-write sessions are currently supported only for AWS connections.");
  });
  it.each(nonAws.flatMap((config) => (["observe", "deploy"] as const).map((purpose) => ({ config, provider: config.provider, purpose }))))("refuses a secret.write grant through $provider $purpose credentials", async ({ config, purpose }) => {
    await expectRefusal(config, purpose, "secret.write", "purpose_capability_mismatch", "secret.write requires its separate writer purpose and role.");
  });
  it.each([gcp, azure, kubernetes])("refuses $provider runner secret.write without falling back to direct sessions", async (config) => {
    await expectRefusal({ ...config, mode: "runner", runnerId: "run-purpose" }, "secret.write", "secret.write", "provider_unsupported", "Secret-write sessions are currently supported only for AWS connections.");
  });
  it.each(nonAws.filter((config) => config.provider !== "oci").flatMap((config) => (["observe", "deploy"] as const).map((purpose) => ({ config, provider: config.provider, purpose }))))("preserves normal $provider $purpose callbacks", async ({ config, purpose }) => {
    const c = await verified(config);
    const fetchImpl = cloudFetch(config.provider === "azure" ? "azure" : "gcp");
    const callback = vi.fn(async (session: ProviderSession) => session.provider);
    expect(await platformCredentialBroker(db, options(fetchImpl)).withSession({ connectionId: c.id, purpose, grant: credentialGrant({ ws, cap: purpose === "deploy" ? "infrastructure.apply" : "infrastructure.observe" }) }, callback)).toBe(config.provider);
    expect(callback).toHaveBeenCalledOnce();
    if (config.provider === "gcp") expect(String(fetchImpl.mock.calls[1][0])).toContain(encodeURIComponent(purpose === "deploy" ? gcp.deployServiceAccount : gcp.observeServiceAccount));
    await assertNoSecret(config.provider);
  });
  it.each(["observe", "secret.write"] as const)("keeps foreign-workspace connections hidden for %s purposes", async (purpose) => {
    const c = await verified(gcp);
    const fetchImpl = cloudFetch("gcp");
    const callback = vi.fn(async () => undefined);
    await expect(platformCredentialBroker(db, options(fetchImpl)).withSession({ connectionId: c.id, purpose, grant: credentialGrant({ ws: "foreign", cap: "secret.write" }) }, callback)).rejects.toMatchObject({ reason: "connection_not_found", message: "Connection not found in this workspace." });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["oidc_web_identity", "aws_assume_role"] as const)("delegates AWS secret.write to its distinct scoped writer role in %s mode", async (mode) => {
    const config = awsConfig({ mode, externalId: "zenith-purpose-external-id", secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriter" });
    const c = await verified(config);
    const target = `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:zenith/env1/DB_PASSWORD-AbCdEf`;
    const other = `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:zenith/env1/API_KEY-AbCdEf`;
    const sts = new STSClient({ region: config.region, credentials: { accessKeyId: "synthetic-worker-key", secretAccessKey: secret } });
    const stsMock = mockClient(sts);
    const response = { Credentials: { ...FAKE_CREDS, Expiration: new Date(Date.now() + 900_000) } };
    stsMock.on(AssumeRoleCommand).resolves(response);
    stsMock.on(AssumeRoleWithWebIdentityCommand).resolves(response);
    try {
      const fetchImpl = vi.fn<typeof fetch>();
      const callback = vi.fn(async (session: ProviderSession) => session.provider);
      const oidc = { signer, issuer: "https://zenith.test/api/oidc" };
      const result = await platformCredentialBroker(db, { ...options(fetchImpl), aws: { oidc, stsClient: () => sts } }).withSession({ connectionId: c.id, purpose: "secret.write", grant: credentialGrant({ ws, cap: "secret.write", fence: 1, constraints: { secretResources: [target, other] } }), secretResources: [target] }, callback);
      expect(result).toBe("aws");
      expect(callback).toHaveBeenCalledOnce();
      expect(stsMock.calls()).toHaveLength(1);
      const input = mode === "oidc_web_identity" ? stsMock.commandCalls(AssumeRoleWithWebIdentityCommand)[0].args[0].input : stsMock.commandCalls(AssumeRoleCommand)[0].args[0].input;
      expect(input.RoleArn).toBe(config.secretWriterRoleArn);
      expect(JSON.parse(input.Policy!)).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], Resource: [target], Condition: { StringEquals: { "aws:ResourceTag/zenith:managed": "true", "aws:ResourceTag/zenith:workspace": ws, "aws:ResourceTag/zenith:environment": "env1" } } }] });
      expect(fetchImpl).not.toHaveBeenCalled();
      const events = (await repos.events.list(db, ws, { limit: 100 })).filter((event) => event.data.connectionId === c.id);
      expect(events).toEqual([expect.objectContaining({ type: "credential.assumed", data: expect.objectContaining({ purpose: "secret.write", capability: "secret.write", roleArn: config.secretWriterRoleArn }) })]);
      const persisted = JSON.stringify({ result, events, connections: await repos.connections.list(db, ws) });
      for (const value of [secret, ...FAKE_SECRETS]) expect(persisted).not.toContain(value);
    } finally { stsMock.restore(); sts.destroy(); }
  });
  it.each([
    { label: "missing writer", secretWriterRoleArn: undefined },
    { label: "deploy role alias", secretWriterRoleArn: awsConfig().deployRoleArn },
    { label: "observe role alias", secretWriterRoleArn: awsConfig().observeRoleArn },
    { label: "runner transport", mode: "runner" as const, runnerId: "run-purpose", secretWriterRoleArn: "arn:aws:iam::123456789012:role/ZenithSecretWriter" },
  ])("preserves AWS secret.write refusal for $label", async ({ label: _label, ...overrides }) => {
    const c = await verified(awsConfig(overrides));
    const stsClient = vi.fn();
    const callback = vi.fn(async () => undefined);
    await expect(platformCredentialBroker(db, { aws: { stsClient } }).withSession({ connectionId: c.id, purpose: "secret.write", grant: credentialGrant({ ws, cap: "secret.write" }) }, callback)).rejects.toMatchObject({ reason: "not_supported" });
    expect(stsClient).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("non-AWS onboarding verification", () => {
  it("exchanges the exact scoped GCP subject, impersonates observe only and reads projects.get", async () => {
    const c = await connection(gcp); const fetchImpl = cloudFetch("gcp");
    const result = await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws });
    expect(result).toMatchObject({ ok: true, accountId: gcp.projectId });
    const calls = fetchImpl.mock.calls;
    expect(calls).toHaveLength(3);
    const sts = JSON.parse(String(calls[0][1]?.body));
    expect(decodeJwt(sts.subjectToken)).toMatchObject({ sub: `zenith:ws:${ws}:conn:${c.id}`, aud: `https://iam.googleapis.com/${gcp.workloadIdentityProvider}`, zenith_cap: "connection.verify" });
    expect(sts.audience).toBe(`//iam.googleapis.com/${gcp.workloadIdentityProvider}`);
    expect(String(calls[1][0])).toContain(encodeURIComponent(gcp.observeServiceAccount));
    expect(String(calls[2][0])).toBe(`https://cloudresourcemanager.googleapis.com/v3/projects/${gcp.projectId}`);
    expect(new Headers(calls[2][1]?.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect((await repos.connections.get(db, ws, c.id))!.status).toBe("pending_verification");
    await assertNoSecret(result);
  });
  it("exchanges Azure assertion for ARM and checks the configured subscription", async () => {
    const c = await connection(azure); const fetchImpl = cloudFetch("azure");
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: true, accountId: azure.subscriptionId });
    const form = new URLSearchParams(String(fetchImpl.mock.calls[0][1]?.body));
    expect(form.get("scope")).toBe("https://management.azure.com/.default");
    expect(decodeJwt(form.get("client_assertion")!)).toMatchObject({ sub: `zenith:ws:${ws}:conn:${c.id}`, aud: "api://AzureADTokenExchange" });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(`https://management.azure.com/subscriptions/${azure.subscriptionId}?api-version=2022-12-01`);
    await assertNoSecret(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws }));
  });
  it.each(["gcp", "azure"] as const)("refuses foreign tenants and revoked %s before mint/exchange", async (provider) => {
    const c = await connection(provider === "gcp" ? gcp : azure); const fetchImpl = cloudFetch(provider);
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: "foreign" })).toEqual({ ok: false, detail: "Connection not found." });
    await repos.connections.revoke(db, ws, c.id);
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toEqual({ ok: false, detail: "Connection revoked." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 429, 503])("returns non-secret read failures for HTTP %i", async (status) => {
    for (const provider of ["gcp", "azure"] as const) {
      const c = await connection(provider === "gcp" ? gcp : azure);
      const result = await broker(cloudFetch(provider, async () => Response.json({ error: secret }, { status }))).verifyConnection(c.id, { workspaceId: ws });
      expect(result.ok).toBe(false); expect(result.detail).toContain(`HTTP ${status}`);
      await assertNoSecret(result);
    }
  });
  it.each([{}, { projectId: "foreign", subscriptionId: "foreign" }, [], null])("rejects incomplete or mismatched identity response %j", async (body) => {
    for (const provider of ["gcp", "azure"] as const) {
      const c = await connection(provider === "gcp" ? gcp : azure);
      expect(await broker(cloudFetch(provider, async () => Response.json(body))).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("identifier") });
    }
  });
  it("reports STS, impersonation and Entra failures without echoing remote text", async () => {
    for (const stage of ["sts", "impersonation", "entra"] as const) {
      const c = await connection(stage === "entra" ? azure : gcp); const normal = cloudFetch(stage === "entra" ? "azure" : "gcp");
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if ((stage === "sts" && url.includes("sts.googleapis.com")) || (stage === "impersonation" && url.includes("iamcredentials")) || (stage === "entra" && url.includes("login.microsoftonline"))) return Response.json({ error: secret, error_description: secret }, { status: 403 });
        return normal(input, init);
      };
      const result = await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws });
      expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/STS|impersonation|Entra/) });
      await assertNoSecret(result);
    }
  });
  it("rejects malformed tokens, configuration and missing issuer without an identity read", async () => {
    const c = await connection(gcp); const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ access_token: "x" }));
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("unusable") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const invalid = await connection({ ...gcp, projectId: "BAD" }); fetchImpl.mockClear();
    expect(await broker(fetchImpl).verifyConnection(invalid.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("configuration") });
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubEnv("ZENITH_OIDC_SIGNING_JWK", ""); vi.stubEnv("ZENITH_OIDC_KMS_KEY_ID", "");
    expect(await platformCredentialBroker(db, { oidc: { issuer: "https://zenith.test/api/oidc", env: {} }, fetchImpl }).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("could not be minted") });
  });
  it("refuses audit failure before the provider read", async () => {
    const c = await connection(gcp); const fetchImpl = cloudFetch("gcp");
    vi.spyOn(repos.events, "append").mockRejectedValueOnce(new Error(secret));
    const result = await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("audit") });
    expect(fetchImpl).toHaveBeenCalledTimes(2); await assertNoSecret(result);
  });
  it("rejects revocation or configuration changes that race the provider read", async () => {
    for (const change of ["revoke", "config"] as const) {
      const c = await connection(gcp);
      const fetchImpl = cloudFetch("gcp", async () => {
        if (change === "revoke") await repos.connections.revoke(db, ws, c.id);
        else await db.query("update platform.provider_connections set config = $3::text::jsonb where workspace_id = $1 and id = $2", [ws, c.id, JSON.stringify({ ...gcp, region: "us-east1" })]);
        return Response.json({ projectId: gcp.projectId });
      });
      expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("during verification") });
    }
  });
  it("keeps concurrent verification calls independently scoped", async () => {
    const a = await connection(gcp); const b = await connection(gcp); const fetchImpl = cloudFetch("gcp");
    const results = await Promise.all([a, b].map((c) => broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })));
    expect(results.every((r) => r.ok)).toBe(true);
    const subjects = fetchImpl.mock.calls.filter(([url]) => String(url).includes("sts.googleapis.com")).map(([, init]) => decodeJwt(JSON.parse(String(init?.body)).subjectToken).sub);
    expect(new Set(subjects)).toEqual(new Set([a, b].map((c) => `zenith:ws:${ws}:conn:${c.id}`)));
  });
  it("continues to refuse pending connections for general credential callbacks", async () => {
    const c = await connection(gcp); const fetchImpl = cloudFetch("gcp");
    const grant = { ws, op: "op-verify", exp: Math.floor(Date.now() / 1000) + 900, cap: "infrastructure.observe" } as CapabilityGrantClaims;
    await expect(broker(fetchImpl).withSession({ connectionId: c.id, purpose: "observe", grant }, async () => undefined)).rejects.toThrow("not been verified");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps provider creation and audit failures secret-free for normal callbacks", async () => {
    const c = await connection(gcp);
    await repos.connections.recordVerification(db, { workspaceId: ws, id: c.id, ok: true, detail: "Synthetic fixture, not live verification." });
    const grant = { ws, op: "op-verified", exp: Math.floor(Date.now() / 1000) + 900, cap: "infrastructure.observe" } as CapabilityGrantClaims;
    const callback = vi.fn(async () => undefined);
    const unavailable = vi.fn<typeof fetch>(async () => { throw new Error(secret); });
    await expect(broker(unavailable).withSession({ connectionId: c.id, purpose: "observe", grant }, callback)).rejects.toMatchObject({ reason: "not_supported", message: expect.not.stringContaining(secret) });
    vi.spyOn(repos.events, "append").mockRejectedValueOnce(new Error(secret));
    await expect(broker(cloudFetch("gcp")).withSession({ connectionId: c.id, purpose: "observe", grant }, callback)).rejects.toMatchObject({ reason: "audit_failed", message: expect.not.stringContaining(secret) });
    expect(callback).not.toHaveBeenCalled();
  });
  it("never accepts an expired impersonated observe token", async () => {
    const c = await connection(gcp); const normal = cloudFetch("gcp");
    const fetchImpl: typeof fetch = (input, init) => String(input).includes("iamcredentials") ? Promise.resolve(Response.json({ accessToken: secret, expireTime: "2000-01-01T00:00:00Z" })) : normal(input, init);
    const result = await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("expired") });
    expect(normal.mock.calls.some(([url]) => String(url).includes("cloudresourcemanager"))).toBe(false);
    await assertNoSecret(result);
  });
  it.each(["gcp", "azure", "kubernetes"] as const)("reports unavailable %s runner transport without using direct credentials", async (provider) => {
    const config = provider === "gcp" ? gcp : provider === "azure" ? azure : kubernetes;
    const c = await connection({ ...config, mode: "runner", runnerId: "run-missing" }); const fetchImpl = vi.fn<typeof fetch>();
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("runner verification transport") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds identity reads with an abort signal and withholds network exceptions", async () => {
    const c = await connection(azure);
    const fetchImpl = cloudFetch("azure", async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException(secret, "TimeoutError");
    });
    const result = await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("timed out") }); await assertNoSecret(result);
  });
});

describe("Kubernetes namespace verification", () => {
  it("resolves only the workspace vault reference, reads each allowed namespace, and closes the session", async () => {
    await putSecretAsync(ws, vault, secret, "operator"); const c = await connection(kubernetes);
    const result = await broker().verifyConnection(c.id, { workspaceId: ws });
    expect(result.ok).toBe(true);
    expect(kube.read.mock.calls.map(([args]) => args)).toEqual([{ name: "default", namespace: "orders" }, { name: "default", namespace: "payments" }]);
    const session = kube.sessions[0];
    expect(session.provider).toBe("kubernetes");
    if (session.provider === "kubernetes") expect(() => session.kubeConfig()).toThrow("ended");
    await assertNoSecret(result);
  });
  it.each([401, 403, 404, 500])("reports Kubernetes HTTP %i without server body secrets", async (status) => {
    await putSecretAsync(ws, vault, secret, "operator"); const c = await connection(kubernetes);
    kube.read.mockRejectedValueOnce(new ApiException(status, secret, { message: secret }, {}));
    const result = await broker().verifyConnection(c.id, { workspaceId: ws });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining(`HTTP ${status}`) });
    await assertNoSecret(result);
  });
  it.each([{ namespaces: [] }, { namespaces: ["*"] }, { namespaces: ["../other"] }])("refuses invalid namespace scope $namespaces", async ({ namespaces }) => {
    const c = await connection({ ...kubernetes, namespaces });
    expect(await broker().verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("allowlisted") });
    expect(kube.read).not.toHaveBeenCalled();
  });
  it("refuses an absent vault credential or mismatched ServiceAccount", async () => {
    const c = await connection({ ...kubernetes, credentialRef: "vault:project/service/ABSENT" });
    expect(await broker().verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("credential") });
    await putSecretAsync(ws, vault, secret, "operator"); const valid = await connection(kubernetes);
    kube.read.mockResolvedValueOnce({ metadata: { name: "default", namespace: "foreign" } });
    expect(await broker().verifyConnection(valid.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("mismatched") });
  });
});

describe("OCI registration-only verification", () => {
  it("accepts only an active, current workspace runner advertising oci.http, without cloud calls", async () => {
    const generated = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", createdBy: "operator", tokenHash: generated.tokenHash });
    const runner = await repos.runners.registerRunner(db, { id: oci.runnerId, tokenHash: generated.tokenHash, name: "contract-runner", publicKey: "a".repeat(43), capabilities: ["oci.http"] });
    const c = await connection(oci); const fetchImpl = vi.fn<typeof fetch>();
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toEqual({ ok: true, detail: expect.stringContaining("permissions are unverified") });
    const foreign = await connection(oci, "foreign");
    expect(await broker(fetchImpl).verifyConnection(foreign.id, { workspaceId: "foreign" })).toMatchObject({ ok: false, detail: expect.stringContaining("not registered") });
    await repos.runners.heartbeat(db, { workspaceId: ws, id: runner.id, capabilities: ["tofu.run"] });
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("oci.http") });
    await repos.runners.heartbeat(db, { workspaceId: ws, id: runner.id, capabilities: ["oci.http"] });
    await db.query("update platform.runners set last_heartbeat_at = clock_timestamp() - interval '120 seconds' where workspace_id = $1 and id = $2", [ws, runner.id]);
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("stale") });
    await repos.runners.revokeRunner(db, ws, runner.id);
    expect(await broker(fetchImpl).verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("revoked") });
    expect(fetchImpl).not.toHaveBeenCalled();
    await assertNoSecret(c);
  });
  it("does not confuse an unregistered runner with verified cloud access", async () => {
    const c = await connection({ ...oci, runnerId: "run-absent" });
    expect(await broker().verifyConnection(c.id, { workspaceId: ws })).toMatchObject({ ok: false, detail: expect.stringContaining("not registered") });
  });
});
