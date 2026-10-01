/** Transport scope, credential purpose, namespace guards and callback lifetime. */
import { describe, expect, it } from "vitest";
import type { CredentialBroker, CredentialRequest, ProviderConnection } from "@/lib/credentials/types";
import { createMachineSessionProvider, redactText, type KubernetesMachineSession, type MachineSessionRequest } from "@/lib/machines";
import { awsSession, grantFor, requestFor, T0 } from "./_helpers";

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
  it("uses shared credential patterns and preserves the tofu redactor's assignment coverage", () => {
    for (const text of ["zrt_abcdefghijklmnopqrstuvwxyz", "za_abcdefghijklmnopqrstuvwxyz", "password=fixture-secret", "Bearer abcdefghijklmnop"]) {
      const r = redactText(text);
      expect(r.redacted).toBe(true);
      expect(r.text).not.toEqual(text);
    }
    expect(redactText("vault:cluster-credential").text).toBe("vault:cluster-credential");
  });
});
