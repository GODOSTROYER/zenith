/** Transport scope, credential purpose, namespace guards and callback lifetime. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AzureSession, CredentialBroker, CredentialRequest, GcpSession, ProviderConnection } from "@/lib/credentials/types";
import { createMachineSessionProvider, redactText, type KubernetesMachineSession, type MachineSessionRequest } from "@/lib/machines";
import { awsSession, grantFor, requestFor, T0 } from "./_helpers";

afterEach(() => { vi.unstubAllEnvs(); });

function setup() {
  const requests: CredentialRequest[] = [];
  const aws = awsSession();
  const credentials: CredentialBroker = { withSession: async (req, fn) => { requests.push(req); return fn(aws); }, verifyConnection: async () => ({ ok: true, detail: "fake" }) };
  const connection: ProviderConnection = { id: "conn-1", workspaceId: "ws-1", status: "verified", createdBy: "user-1", createdAt: new Date(T0).toISOString(), config: { provider: "aws", mode: "runner", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/observe", deployRoleArn: "arn:aws:iam::123456789012:role/deploy", region: "us-east-1" } };
  const req = (operation: MachineSessionRequest["operation"], transport: MachineSessionRequest["target"]["transport"] = "aws_ssm"): MachineSessionRequest => ({ target: requestFor(operation, {}, { transport }).target, operation, operationId: "op-1", grant: grantFor(operation) });
  return { credentials, requests, aws, connection, req };
}

describe("machine sessions", () => {
  it.each([["machine.inspect", "observe"], ["machine.service.restart", "deploy"], ["container.exec", "deploy"]] as const)("%s uses the catalog's %s purpose with the original grant", async (op, purpose) => {
    const s = setup(); const req = s.req(op);
    const p = createMachineSessionProvider({ credentials: s.credentials, connection: s.connection, grantJws: "compact" });
    expect(await p.withSession(req, async (session) => session === s.aws)).toBe(true);
    expect(s.requests).toEqual([{ connectionId: s.connection.id, grant: req.grant, purpose }]);
  });
  it("zenithd forwards the compact grant; sandbox obtains no cloud session", async () => {
    const s = setup();
    const p = createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact" });
    expect(await p.withSession(s.req("machine.inspect", "zenithd"), async (x) => x)).toEqual({ grantJws: "compact" });
    const sandbox = createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact", sandbox: true });
    expect(await sandbox.withSession(s.req("machine.inspect"), async (x) => x)).toBeUndefined();
    expect(s.requests).toHaveLength(0);
  });
  it("builds Kubernetes credentials with the provider builder and revokes access after the callback", async () => {
    const s = setup(); const refs: string[] = [];
    const connection: ProviderConnection = { ...s.connection, config: { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: ["app"] } };
    const p = createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact", connection, now: () => new Date(T0), kubernetes: { resolveCredential: async (ref) => { refs.push(ref); return "fixture-token"; } } });
    let held: KubernetesMachineSession | undefined;
    expect(await p.withSession(s.req("container.list", "kubernetes"), async (x) => {
      held = x as KubernetesMachineSession;
      expect(held.namespaces).toEqual(["app"]);
      expect(held.kubeConfig()).toBeDefined();
      expect(JSON.stringify(held)).not.toContain("fixture-token");
      return 7;
    })).toBe(7);
    expect(refs).toEqual(["vault:cluster"]);
    expect(s.requests).toHaveLength(0);
    expect(() => held!.kubeConfig()).toThrow(/ended/);
  });
  it("fails closed for foreign, revoked, wrong-provider, absent or unconfigured connections", async () => {
    const s = setup();
    for (const connection of [undefined, { ...s.connection, workspaceId: "foreign" }, { ...s.connection, status: "revoked" as const }]) {
      await expect(createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact", connection }).withSession(s.req("machine.inspect"), async () => true)).rejects.toMatchObject({ code: "denied" });
    }
    await expect(createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact", connection: s.connection }).withSession(s.req("container.list", "kubernetes"), async () => true)).rejects.toMatchObject({ code: "denied" });
    expect(s.requests).toHaveLength(0);
  });
  it("Kubernetes keeps an empty allowlist and cannot outlive a short grant, even on callback failure", async () => {
    const s = setup(); let t = T0;
    const connection: ProviderConnection = { ...s.connection, config: { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: [] } };
    const p = createMachineSessionProvider({ credentials: s.credentials, grantJws: "compact", connection, now: () => new Date(t), kubernetes: { resolveCredential: async () => "fake-token" } });
    const req = s.req("container.list", "kubernetes"); req.grant.exp = Math.floor(T0 / 1000) + 5;
    let held: KubernetesMachineSession | undefined;
    await expect(p.withSession(req, async (x) => {
      held = x as KubernetesMachineSession;
      expect(held.namespaces).toEqual([]);
      expect(held.expiresAt).toBe(new Date(T0 + 5000).toISOString());
      t += 5000;
      expect(() => held!.kubeConfig()).toThrow(/ended/);
      throw new Error("callback failed");
    })).rejects.toThrow(/callback failed/);
    expect(() => held!.kubeConfig()).toThrow(/ended/);
  });
  it("test-only Kubernetes resolvers are captured once and refused in production at creation and invocation", async () => {
    const s = setup();
    const connection: ProviderConnection = { ...s.connection, config: { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: ["app"] } };
    const original = vi.fn(async () => "fixture-token"), replacement = vi.fn(async () => "replacement-token");
    const deps = { resolveCredential: original };
    const options = { credentials: s.credentials, grantJws: "compact", connection, now: () => new Date(T0), kubernetes: deps };
    const p = createMachineSessionProvider(options);
    deps.resolveCredential = replacement;
    await p.withSession(s.req("container.list", "kubernetes"), async () => undefined);
    expect(original).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createMachineSessionProvider(options)).toThrow(/only in tests/);
    const callback = vi.fn(async () => undefined);
    await expect(p.withSession(s.req("container.list", "kubernetes"), callback)).rejects.toMatchObject({ code: "denied" });
    expect(callback).not.toHaveBeenCalled(); expect(original).toHaveBeenCalledOnce();
    expect(s.requests).toHaveLength(0);
  });
  it("default Kubernetes guest sessions use the broker's live namespace scope and original grant", async () => {
    const s = setup();
    const connection: ProviderConnection = { ...s.connection, config: { provider: "kubernetes", mode: "scoped_guest", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: ["app", "removed"] } };
    const credentialObject = {};
    const credentials: CredentialBroker = { verifyConnection: s.credentials.verifyConnection, withSession: async (request, fn) => {
      s.requests.push(request);
      return fn({ provider: "kubernetes", server: "https://current.example", expiresAt: new Date(T0 + 900_000).toISOString(),
        namespaces: ["app"], kubeConfig: () => credentialObject } as KubernetesMachineSession);
    } };
    const req = s.req("container.list", "kubernetes");
    req.target = { ...req.target, targetId: "app/web" };
    let held!: KubernetesMachineSession;
    const provider = createMachineSessionProvider({ credentials, connection, grantJws: "compact", now: () => new Date(T0) });
    expect(await provider.withSession(req, async session => {
      held = session as KubernetesMachineSession;
      expect(held.namespaces).toEqual(["app"]); expect(Object.isFrozen(held.namespaces)).toBe(true);
      expect(held.server).toBe("https://current.example"); expect(held.kubeConfig()).toBe(credentialObject);
      expect(held.expiresAt).toBe(new Date(req.grant.exp * 1000).toISOString());
      return "safe metadata";
    })).toBe("safe metadata");
    expect(s.requests).toEqual([{ connectionId: connection.id, purpose: "observe", grant: req.grant, kubernetesGuest: { namespace: "app", profile: "read" } }]);
    expect(() => held.kubeConfig()).toThrow(/ended/);
  });

  it("refuses a legacy Kubernetes credential before broker or guest callback entry", async () => {
    const s = setup();
    const connection: ProviderConnection = { ...s.connection, config: { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example", credentialRef: "vault:cluster", namespaces: ["app"] } };
    const callback = vi.fn(async () => undefined);
    const provider = createMachineSessionProvider({ credentials: s.credentials, connection, grantJws: "compact", now: () => new Date(T0) });
    await expect(provider.withSession(s.req("container.list", "kubernetes"), callback)).rejects.toThrow("legacy kubeconfig");
    expect(callback).not.toHaveBeenCalled();
    expect(s.requests).toHaveLength(0);
  });

  it("uses shared credential patterns and preserves the tofu redactor's assignment coverage", () => {
    for (const text of ["zrt_abcdefghijklmnopqrstuvwxyz", "za_abcdefghijklmnopqrstuvwxyz", "password=fixture-secret", "Bearer abcdefghijklmnop"]) {
      const r = redactText(text);
      expect(r.redacted).toBe(true);
      expect(r.text).not.toEqual(text);
    }
    expect(redactText("vault:cluster-credential").text).toBe("vault:cluster-credential");
  });

  it.each(["azure", "gcp"] as const)("%s sessions stay inside the broker callback with catalog purpose and original grant", async (provider) => {
    const s = setup();
    const transport = provider === "azure" ? "azure_run_command" : "gcp_os_management";
    const connection: ProviderConnection = { ...s.connection, config: provider === "azure" ? { provider, mode: "oidc_web_identity", tenantId: "tenant", clientId: "client", subscriptionId: "subscription", region: "eastus" } : { provider, mode: "oidc_web_identity", projectId: "project", workloadIdentityProvider: "pool", observeServiceAccount: "observe", deployServiceAccount: "deploy", region: "us-central1" } };
    let active = false;
    const fetch = async () => { if (!active) throw new Error("session ended"); return new Response("{}"); };
    const session: AzureSession | GcpSession = provider === "azure" ? { provider, subscriptionId: "subscription", region: "eastus", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: fetch, childProcessEnv: () => ({}) } : { provider, projectId: "project", region: "us-central1", expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: fetch, childProcessEnv: () => ({}) };
    const credentials: CredentialBroker = { verifyConnection: s.credentials.verifyConnection, withSession: async (r, fn) => { s.requests.push(r); active = true; try { return await fn(session); } finally { active = false; } } };
    const p = createMachineSessionProvider({ credentials, connection, grantJws: "compact" });
    for (const op of ["machine.inspect", "machine.service.restart"] as const) {
      const req = s.req(op, transport);
      expect(await p.withSession(req, async (x) => { expect(x).toBe(session); await session.authorizedFetch("https://example.test"); return 7; })).toBe(7);
      expect(s.requests.at(-1)).toEqual({ connectionId: connection.id, grant: req.grant, purpose: op === "machine.inspect" ? "observe" : "deploy" });
      await expect(session.authorizedFetch("https://example.test")).rejects.toThrow(/ended/);
    }
  });

  it.each(["azure_run_command", "gcp_os_management"] as const)("%s rejects wrong-provider sessions, foreign/revoked connections and avoids broker calls for invalid connections", async (transport) => {
    const s = setup(); const req = s.req("machine.inspect", transport);
    const provider = transport === "azure_run_command" ? "azure" : "gcp";
    const config: ProviderConnection["config"] = provider === "azure" ? { provider, mode: "runner", tenantId: "tenant", clientId: "client", subscriptionId: "sub", region: "eastus" } : { provider, mode: "runner", projectId: "project", workloadIdentityProvider: "pool", observeServiceAccount: "observe", deployServiceAccount: "deploy", region: "us-central1" };
    const connection = { ...s.connection, config };
    for (const c of [undefined, s.connection, { ...connection, workspaceId: "foreign" }, { ...connection, status: "revoked" as const }]) {
      await expect(createMachineSessionProvider({ credentials: s.credentials, connection: c, grantJws: "compact" }).withSession(req, async () => true)).rejects.toMatchObject({ code: "denied" });
    }
    expect(s.requests).toHaveLength(0);
    await expect(createMachineSessionProvider({ credentials: s.credentials, connection, grantJws: "compact" }).withSession(req, async () => true)).rejects.toMatchObject({ code: "denied" });
    expect(s.requests).toHaveLength(1);
  });
});
