/** Connection lifecycle CLI verbs against a loopback fixture: wire contracts, confirmation and browser handoff. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOKEN, fixture, invoke, reply, scope } from "./support";
import { parseConnectionHandoff } from "@/lib/connections/handoff";
import { CreateRunnerInput } from "@/lib/connections/schemas";
import { runnerInput } from "../connections/runner-inputs";

const canary = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
const view = { id: "conn_1", provider: "gcp", mode: "oidc_web_identity", label: "GCP acme", status: "verified", createdAt: "2026-10-01T00:00:00Z", productLinked: true, identity: { projectId: "acme-prod-123456" } };
let server: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  server = await fixture((request, response) => {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path.endsWith("/verify")) return reply(response, { ok: true, summary: "Verified. Observe only.", data: { connectionId: "conn_1" } });
    if (path.endsWith("/revoke")) return reply(response, { ok: true, summary: "Revoked.", data: { connectionId: "conn_1" } });
    if (path.endsWith("/connections")) return reply(response, { connections: [view] });
    return reply(response, { connection: view });
  });
});
afterEach(async () => { await server.close(); });

describe("connection verbs", () => {
  it("lists without revoked connections by default and with them on request", async () => {
    const plain = await invoke(server.url, ["connections", "list", "--json"]);
    expect(plain.code).toBe(0);
    expect(server.requests[0]).toMatchObject({ method: "GET", url: "/api/platform/v1/connections?includeRevoked=false" });
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    await invoke(server.url, ["connections", "list", "--include-revoked", "--json"]);
    expect(server.requests[1].url).toBe("/api/platform/v1/connections?includeRevoked=true");
  });

  it("shows and verifies by id", async () => {
    expect((await invoke(server.url, ["connections", "show", "conn_1", "--json"])).code).toBe(0);
    expect(server.requests[0]).toMatchObject({ method: "GET", url: "/api/platform/v1/connections/conn_1" });
    const verified = await invoke(server.url, ["connections", "verify", "conn_1", "--json"]);
    expect(verified.code).toBe(0);
    expect(server.requests[1]).toMatchObject({ method: "POST", url: "/api/platform/v1/connections/conn_1/verify", body: {} });
  });

  it("exits nonzero when a verification completes but fails", async () => {
    await server.close();
    server = await fixture((_request, response) => reply(response, { ok: false, summary: "Verification failed.", error: "Trust denied.", data: null }));
    expect((await invoke(server.url, ["connections", "verify", "conn_1", "--json"])).code).toBe(6);
  });

  it("revoke is terminal: it needs --confirm with the exact id and sends nothing otherwise", async () => {
    const refused = await invoke(server.url, ["connections", "revoke", "conn_1", "--json"]);
    expect(refused.code).toBe(2); expect(server.requests).toHaveLength(0);
    expect((await invoke(server.url, ["connections", "revoke", "conn_1", "--confirm", "conn_2", "--json"])).code).toBe(2);
    expect(server.requests).toHaveLength(0);
    const done = await invoke(server.url, ["connections", "revoke", "conn_1", "--confirm", "conn_1", "--reason", "rotated away", "--revoke-runner", "--json"]);
    expect(done.code).toBe(0);
    expect(server.requests[0]).toMatchObject({ method: "POST", url: "/api/platform/v1/connections/conn_1/revoke", body: { confirm: "conn_1", reason: "rotated away", revokeRunner: true } });
  });
});

describe("browser handoff for verbs that change what Zenith can reach", () => {
  const gcp = JSON.stringify({ region: "asia-south1", projectId: "acme-prod-123456",
    workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc",
    observeServiceAccount: "zenith-observe@acme-prod-123456.iam.gserviceaccount.com", deployServiceAccount: "zenith-deploy@acme-prod-123456.iam.gserviceaccount.com" });

  it("create validates locally, sends nothing and returns the browser URL", async () => {
    const result = await invoke(server.url, ["connections", "create", "gcp", "--input", "-", "--json"], gcp);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ approved: false, code: "browser_session_required", provider: "gcp", inputValid: true, browserUrl: `${server.url}/platform/connections` });
    expect(server.requests).toHaveLength(0);
    expect(result.stdout).not.toContain("acme-prod-123456.iam");
  });

  it.each(["aws", "gcp", "azure", "oci", "kubernetes"] as const)("%s runner creation validates identifiers and hands off without sending", async provider => {
    const input = provider === "gcp" ? { ...JSON.parse(gcp) as object, mode: "runner", runnerId: "run_registered" }
      : provider === "aws" ? { mode: "runner", runnerId: "run_registered", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" }
      : provider === "azure" || provider === "oci" ? runnerInput(provider)
      : { mode: "runner", runnerId: "run_registered", server: "https://kubernetes.zenith.test", namespaces: ["customer"] };
    const result = await invoke(server.url, ["connections", "create", provider, "--input", "-", "--json"], JSON.stringify(input));
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ provider, mode: "runner", inputValid: true, note: expect.stringContaining("signed-in browser") });
    const url = new URL(JSON.parse(result.stdout).browserUrl);
    expect(url.origin).toBe(server.url); expect(url.pathname).toBe("/platform/connections/confirm"); expect(url.search).toBe("");
    expect(parseConnectionHandoff(url.hash)).toEqual({ version: 1, workspaceId: scope.workspaceId, request: { action: "connection.createRunner", input: CreateRunnerInput.parse({ provider, ...input }) } });
    expect(server.requests).toHaveLength(0);
  });

  it("explains the separate Kubernetes deployer in its browser handoff", async () => {
    const result = await invoke(server.url, ["connections", "create", "kubernetes", "--input", "-", "--json"], "{}");
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout).note).toContain("deployerCredentialRef");
    expect(server.requests).toHaveLength(0);
  });

  it("create rejects an invalid or secret-bearing input with exit 2", async () => {
    const invalid = await invoke(server.url, ["connections", "create", "gcp", "--input", "-", "--json"], JSON.stringify({ projectId: "x" }));
    expect(invalid.code).toBe(2);
    const secret = await invoke(server.url, ["connections", "create", "azure", "--input", "-", "--json"], JSON.stringify({ clientSecret: canary }));
    expect(secret.code).toBe(2);
    expect(secret.stdout + secret.stderr).not.toContain(canary);
    expect(server.requests).toHaveLength(0);
    expect((await invoke(server.url, ["connections", "create", "ibm", "--input", "-"], "{}")).code).toBe(2);
  });

  it.each([
    [["connections", "rotate", "conn_1", "--input", "-", "--promote", "--json"], JSON.stringify({ observeServiceAccount: "zenith-observe-v2@acme-prod-123456.iam.gserviceaccount.com" })],
    [["connections", "promote", "conn_1", "--rotation", "rot_1", "--json"], ""],
    [["connections", "abort", "conn_1", "--rotation", "rot_1", "--json"], ""],
  ])("%j hands off to the browser without calling the server", async (args, input) => {
    const result = await invoke(server.url, args, input);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ approved: false, code: "browser_session_required" });
    const url = new URL(JSON.parse(result.stdout).browserUrl);
    expect(url.origin).toBe(server.url); expect(url.pathname).toBe("/platform/connections/confirm"); expect(url.search).toBe("");
    const request = parseConnectionHandoff(url.hash).request;
    expect(parseConnectionHandoff(url.hash).workspaceId).toBe(scope.workspaceId);
    expect(request).toEqual(args[1] === "rotate"
      ? { action: "connection.rotate", input: { connectionId: "conn_1", patch: JSON.parse(input), promote: true } }
      : { action: args[1] === "promote" ? "connection.promoteRotation" : "connection.abortRotation", input: { connectionId: "conn_1", rotationId: "rot_1" } });
    expect(server.requests).toHaveLength(0);
  });

  it("refuses unknown options and wrong arity", async () => {
    expect((await invoke(server.url, ["connections", "list", "--status", "x"])).code).toBe(2);
    expect((await invoke(server.url, ["connections", "show"])).code).toBe(2);
    expect((await invoke(server.url, ["connections", "promote", "conn_1"])).code).toBe(2);
    expect(scope.workspaceId).toBe("ws-cli");
  });
});
