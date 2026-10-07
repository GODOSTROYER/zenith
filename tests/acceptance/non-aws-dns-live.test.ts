/**
 * Live non-AWS DNS teardown acceptance (PROD-LIFE-06). LIVE ACCEPTANCE IS DEFERRED:
 * the live suites below are skipped, with an explicit reason, unless
 * ZENITH_LIVE_<GCP|AZURE|OCI>=1 and credential FILE references are configured. A
 * skipped suite is never evidence. The harness logic itself is contract-tested
 * here against a fake HTTP control plane (route shapes only), never a real one.
 */
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpControlPlaneClient } from "../../scripts/acceptance/clients/control-plane";
import { LIVE_DNS_PROVIDERS, liveDnsGate, readApiToken, runApprovedDestroy, runForeignScenario, runOwnedScenario, type LiveDnsConfig, type LiveDnsProvider } from "../../scripts/acceptance/non-aws-dns-live";

const dir = mkdtempSync(path.join(tmpdir(), "zenith-live-dns-"));
const tokenFile = path.join(dir, "token");
const credFile = path.join(dir, "cred");
// Built at runtime: a placeholder, not a credential, and never printed.
writeFileSync(tokenFile, `${["placeholder", "token", "value"].join("-")}\n`);
writeFileSync(credFile, "{}");
const env = (p: LiveDnsProvider, extra: Record<string, string> = {}) => ({
  [`ZENITH_LIVE_${p.toUpperCase()}`]: "1", ZENITH_LIVE_API_URL: "http://localhost:3000", ZENITH_LIVE_API_TOKEN_FILE: tokenFile,
  [`ZENITH_LIVE_${p.toUpperCase()}_CREDENTIAL_FILE`]: credFile, [`ZENITH_LIVE_${p.toUpperCase()}_ENVIRONMENT_ID`]: "env_owned", ...extra,
});

describe("live DNS gate", () => {
  it.each(LIVE_DNS_PROVIDERS)("%s is disabled with an explicit reason unless explicitly enabled", (p) => {
    const gate = liveDnsGate(p, {});
    expect(gate.enabled).toBe(false);
    expect(!gate.enabled && gate.reason).toMatch(new RegExp(`ZENITH_LIVE_${p.toUpperCase()}=1`));
  });

  it.each(LIVE_DNS_PROVIDERS)("%s refuses a missing, non-file or remote-http configuration", (p) => {
    const P = p.toUpperCase();
    expect(liveDnsGate(p, { [`ZENITH_LIVE_${P}`]: "1" })).toMatchObject({ enabled: false, reason: expect.stringContaining("Missing") });
    expect(liveDnsGate(p, env(p, { [`ZENITH_LIVE_${P}_CREDENTIAL_FILE`]: path.join(dir, "absent") }))).toMatchObject({ enabled: false, reason: expect.stringContaining("CREDENTIAL_FILE") });
    expect(liveDnsGate(p, env(p, { ZENITH_LIVE_API_TOKEN_FILE: dir }))).toMatchObject({ enabled: false, reason: expect.stringContaining("TOKEN_FILE") });
    expect(liveDnsGate(p, env(p, { ZENITH_LIVE_API_URL: "http://example.com" })).enabled).toBe(false);
    expect(liveDnsGate(p, env(p, { [`ZENITH_LIVE_${P}_ENVIRONMENT_ID`]: "bad id!" })).enabled).toBe(false);
  });

  it("enables only with the gate flag plus credential FILE references, and never reads or exposes their content", () => {
    const gate = liveDnsGate("oci", env("oci", { ZENITH_LIVE_OCI_FOREIGN_ENVIRONMENT_ID: "env_foreign", ZENITH_LIVE_OCI_APPROVED_OPERATION_ID: "op_1" }));
    expect(gate.enabled).toBe(true);
    if (!gate.enabled) return;
    expect(gate.config).toMatchObject({ provider: "oci", ownedEnvironmentId: "env_owned", foreignEnvironmentId: "env_foreign", approvedOperationId: "op_1", credentialFile: credFile, apiTokenFile: tokenFile });
    expect(JSON.stringify(gate.config)).not.toContain("placeholder-token-value");
    expect(readApiToken(gate.config)).toBe("placeholder-token-value");
  });
});

async function plane(handler: (req: http.IncomingMessage, body: Record<string, unknown>) => { status?: number; body: unknown }, test: (client: HttpControlPlaneClient) => Promise<void>) {
  const s = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => { raw += d.toString(); });
    req.on("end", () => { const out = handler(req, raw ? JSON.parse(raw) : {}); res.writeHead(out.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(out.body)); });
  });
  s.listen(0, "127.0.0.1"); await once(s, "listening");
  try { await test(new HttpControlPlaneClient({ baseUrl: `http://127.0.0.1:${(s.address() as { port: number }).port}`, token: "t", workspaceId: "ws_1" })); }
  finally { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); }
}
const config = (extra: Partial<LiveDnsConfig> = {}): LiveDnsConfig => ({ provider: "gcp", apiUrl: "http://localhost:3000", apiTokenFile: tokenFile, credentialFile: credFile, ownedEnvironmentId: "env_owned", foreignEnvironmentId: "env_foreign", ...extra });
const opts = { idempotencyKey: "run-1", pollMs: 1, timeoutMs: 1000, sleep: async () => undefined };

describe("live DNS harness logic against a fake control plane (route shapes only)", () => {
  it("owned: stops at awaiting_approval and never calls an approve route", async () => {
    const paths: string[] = [];
    await plane((req) => {
      paths.push(`${req.method} ${req.url}`);
      if (req.method === "POST") return { status: 202, body: { reviewOperationId: "rev_1", status: "queued", replayed: false } };
      if (req.url!.includes("teardown-review")) return { body: { review: { reviewOperationId: "rev_1", status: "awaiting_approval", operationId: "op_destroy", planDigest: "a".repeat(64) } } };
      return { body: { operation: { id: "op_destroy", capability: "infrastructure.destroy", status: "awaiting_approval", approvalRequired: true } } };
    }, async (client) => {
      const result = await runOwnedScenario(client, config(), opts);
      expect(result).toMatchObject({ scenario: "owned", status: "awaiting_human_approval", destroyOperationId: "op_destroy" });
      expect(paths.some((p) => /approve/.test(p))).toBe(false);
    });
  });

  it("owned: a review refused for ownership is a failed acceptance, not a pass", async () => {
    await plane((req) => req.method === "POST" ? { status: 202, body: { reviewOperationId: "rev_1", status: "queued", replayed: false } } : { body: { review: { reviewOperationId: "rev_1", status: "failed" } } }, async (client) => {
      expect(await runOwnedScenario(client, config(), opts)).toMatchObject({ scenario: "owned", status: "failed" });
    });
  });

  it("foreign: passes only when the review ends without an approvable proposal", async () => {
    await plane((req) => req.method === "POST" ? { status: 202, body: { reviewOperationId: "rev_f", status: "queued", replayed: false } } : { body: { review: { reviewOperationId: "rev_f", status: "failed" } } }, async (client) => {
      expect(await runForeignScenario(client, config(), opts)).toMatchObject({ scenario: "foreign", status: "passed" });
    });
    await plane((req) => req.method === "POST" ? { status: 202, body: { reviewOperationId: "rev_f", status: "queued", replayed: false } } : { body: { review: { reviewOperationId: "rev_f", status: "awaiting_approval", operationId: "op_bad" } } }, async (client) => {
      expect(await runForeignScenario(client, config(), opts)).toMatchObject({ scenario: "foreign", status: "failed" });
    });
  });

  it("foreign and approved-destroy are skipped, never passed, when not configured", async () => {
    await plane(() => ({ body: {} }), async (client) => {
      expect(await runForeignScenario(client, config({ foreignEnvironmentId: undefined }), opts)).toMatchObject({ status: "skipped" });
      expect(await runApprovedDestroy(client, config(), opts)).toMatchObject({ status: "skipped" });
    });
  });

  it("approved-destroy requires the human-approved operation to actually succeed", async () => {
    for (const [status, expected] of [["succeeded", "passed"], ["failed", "failed"], ["uncertain", "failed"]] as const) {
      await plane(() => ({ body: { operation: { id: "op_ok", capability: "infrastructure.destroy", status, approvalRequired: true } } }), async (client) => {
        expect(await runApprovedDestroy(client, config({ approvedOperationId: "op_ok" }), opts)).toMatchObject({ status: expected });
      });
    }
  });
});

describe.each(LIVE_DNS_PROVIDERS)("LIVE %s DNS teardown acceptance", (provider) => {
  const gate = liveDnsGate(provider, process.env);
  const reason = gate.enabled ? "" : ` (skipped: ${gate.reason})`;

  it.skipIf(!gate.enabled)(`owned record set reaches human approval${reason}`, async () => {
    if (!gate.enabled) return;
    const client = new HttpControlPlaneClient({ baseUrl: gate.config.apiUrl, token: readApiToken(gate.config), workspaceId: gate.config.workspaceId });
    const result = await runOwnedScenario(client, gate.config, { idempotencyKey: `live-${Date.now()}` });
    expect(result.status).toBe("awaiting_human_approval");
  }, 20 * 60_000);

  it.skipIf(!gate.enabled || !gate.config.foreignEnvironmentId)(`re-pointed (foreign) record set is refused${reason}`, async () => {
    if (!gate.enabled) return;
    const client = new HttpControlPlaneClient({ baseUrl: gate.config.apiUrl, token: readApiToken(gate.config), workspaceId: gate.config.workspaceId });
    expect((await runForeignScenario(client, gate.config, { idempotencyKey: `live-${Date.now()}` })).status).toBe("passed");
  }, 20 * 60_000);

  it.skipIf(!gate.enabled || !gate.config.approvedOperationId)(`human-approved teardown succeeds and reads back absence${reason}`, async () => {
    if (!gate.enabled) return;
    const client = new HttpControlPlaneClient({ baseUrl: gate.config.apiUrl, token: readApiToken(gate.config), workspaceId: gate.config.workspaceId });
    expect((await runApprovedDestroy(client, gate.config, { idempotencyKey: `live-${Date.now()}` })).status).toBe("passed");
  }, 70 * 60_000);
});
