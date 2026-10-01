import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { audienceForHost, AzureRequestRefusedError, AzureTokenError, checkAuthorizedUrl, createAzureSession, FEDERATION_AUDIENCE, TOKEN_SCOPES } from "@/lib/providers/azure/credentials";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { validateExtraEnv } from "@/lib/tofu/env";
import { secretValuesOf } from "@/lib/tofu/redact";
import { CLIENT, connection, fakeArm, fakeAssertion, fakeEntra, SUB, TENANT, type FakeArm } from "./_helpers";

const servers: FakeArm[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function arm(routes: Parameters<typeof fakeArm>[0] = [], entra = fakeEntra()) {
  const a = await fakeArm(routes, entra);
  servers.push(a);
  return { arm: a, entra };
}

const nowSec = () => Math.floor(Date.now() / 1000);
let counter = 0;
const minter = (ttlSec = 300) => async () => fakeAssertion(nowSec() + ttlSec, "zenith:ws:ws_1:conn:conn_1", String(++counter));

describe("client credentials with a federated client assertion", () => {
  it("exchanges a Zenith-minted assertion at the tenant's v2 token endpoint, per resource audience", async () => {
    const { arm: a, entra } = await arm([{ match: "/subscriptions", body: { value: [] } }]);
    const seenAudiences: string[] = [];
    const session = await createAzureSession({
      connection,
      purpose: "observe",
      fetchImpl: a.fetchImpl,
      mintClientAssertion: async (audience) => {
        seenAudiences.push(audience);
        return fakeAssertion(nowSec() + 300, "zenith:ws:ws_1:conn:conn_1", String(++counter));
      },
    });
    const res = await session.authorizedFetch("https://management.azure.com/subscriptions?api-version=2022-12-01");
    expect(res.status).toBe(200);

    // one eager assertion for tofu, one for the ARM exchange; both for the federation audience
    expect(seenAudiences).toEqual([FEDERATION_AUDIENCE, FEDERATION_AUDIENCE]);
    expect(FEDERATION_AUDIENCE).toBe("api://AzureADTokenExchange");
    expect(entra.requests).toHaveLength(1);
    const req = entra.requests[0];
    expect(req.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(req.body.get("grant_type")).toBe("client_credentials");
    expect(req.body.get("client_id")).toBe(CLIENT);
    expect(req.body.get("scope")).toBe("https://management.azure.com/.default");
    expect(req.body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(req.body.get("client_assertion")).toMatch(/^eyJ/);
    // never a client secret
    expect(req.body.has("client_secret")).toBe(false);
    // the ARM call carries the exchanged bearer
    expect(a.requests[0].authorization).toBe(`Bearer ${entra.tokens[0]}`);
  });

  it("uses a separate token (and scope) for the Key Vault data plane, and mints a fresh assertion for each exchange", async () => {
    const { arm: a, entra } = await arm([
      { match: "/subscriptions", body: {} },
      { match: "/secrets/x/versions", body: { value: [] } },
    ]);
    const assertions: string[] = [];
    const session = await createAzureSession({
      connection,
      purpose: "deploy",
      fetchImpl: a.fetchImpl,
      mintClientAssertion: async () => {
        const v = fakeAssertion(nowSec() + 300, "zenith:ws:ws_1:conn:conn_1", String(++counter));
        assertions.push(v);
        return v;
      },
    });
    await session.authorizedFetch("https://management.azure.com/subscriptions");
    await session.authorizedFetch("https://myvault.vault.azure.net/secrets/x/versions");
    expect(entra.requests.map((r) => r.body.get("scope"))).toEqual([TOKEN_SCOPES.arm, TOKEN_SCOPES.keyvault]);
    expect(TOKEN_SCOPES.keyvault).toBe("https://vault.azure.net/.default");
    const used = entra.requests.map((r) => r.body.get("client_assertion"));
    expect(new Set(used).size).toBe(2); // Entra does not accept an assertion twice
    expect(used.every((u) => assertions.includes(u!))).toBe(true);
    expect(a.requests[1].authorization).toBe(`Bearer ${entra.tokens[1]}`);
    expect(entra.tokens[0]).not.toBe(entra.tokens[1]);
  });

  it("caches a token per audience and refreshes it before it expires", async () => {
    const { arm: a, entra } = await arm([{ match: (p) => p.startsWith("/subscriptions"), body: {} }], fakeEntra({ expiresIn: 600 }));
    let t = Date.parse("2026-09-30T12:00:00Z");
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, now: () => new Date(t), mintClientAssertion: minter() });
    await session.authorizedFetch("https://management.azure.com/subscriptions/a");
    await session.authorizedFetch("https://management.azure.com/subscriptions/b");
    expect(entra.requests).toHaveLength(1);
    t += 9 * 60_000; // 60 s of the 600 s lifetime left: inside the refresh skew
    await session.authorizedFetch("https://management.azure.com/subscriptions/c");
    expect(entra.requests).toHaveLength(2);
  });

  it("shares one in-flight exchange between concurrent calls", async () => {
    const { arm: a, entra } = await arm([{ match: (p) => p.startsWith("/subscriptions"), body: {} }]);
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    await Promise.all([1, 2, 3, 4].map((i) => session.authorizedFetch(`https://management.azure.com/subscriptions/${i}`)));
    expect(entra.requests).toHaveLength(1);
  });

  it("reports an Entra failure without the assertion, a token or a stack of secrets", async () => {
    const assertion = fakeAssertion(nowSec() + 300, "zenith:ws:ws_1:conn:conn_1", "failing");
    const entra = fakeEntra({
      failWith: {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: `AADSTS70021: No matching federated identity record found for presented assertion ${assertion}. Trace ID: x\r\nsecond line with Bearer abcdefghijklmnop`,
          error_codes: [70021],
          correlation_id: "12345678-1234-1234-1234-123456789abc",
        },
      },
    });
    const { arm: a } = await arm([], entra);
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: async () => assertion });
    const err = await session.authorizedFetch("https://management.azure.com/subscriptions").catch((e) => e);
    expect(err).toBeInstanceOf(AzureTokenError);
    expect(err.status).toBe(401);
    expect(err.entraError).toBe("invalid_client");
    expect(err.message).toContain("AADSTS70021");
    expect(err.message).toContain("12345678-1234-1234-1234-123456789abc");
    expect(err.message).not.toContain(assertion);
    expect(err.message).not.toMatch(/eyJ/);
    expect(err.message).not.toContain("second line");
    expect(err.message).not.toContain("abcdefghijklmnop");
  });

  it("rejects responses that are not a usable bearer token", async () => {
    for (const body of [{ access_token: "short", token_type: "Bearer", expires_in: 3600 }, { access_token: "x".repeat(40), token_type: "mac", expires_in: 3600 }, { access_token: "x".repeat(40), token_type: "Bearer", expires_in: -5 }, {}]) {
      const entra = fakeEntra();
      const base = entra.fetchImpl;
      entra.fetchImpl = (async (u: RequestInfo | URL, i?: RequestInit) => (String(u).includes("/token") ? new Response(JSON.stringify(body), { status: 200 }) : base(u, i))) as typeof fetch;
      const { arm: a } = await arm([], entra);
      const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
      await expect(session.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toBeInstanceOf(AzureTokenError);
    }
  });

  it("times out a hung token endpoint instead of waiting forever", async () => {
    const hung = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: hung, exchangeTimeoutMs: 40, mintClientAssertion: minter() });
    const started = Date.now();
    await expect(session.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toMatchObject({ code: "azure_token_exchange_failed" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("host allowlist", () => {
  const allowed = [
    ["https://management.azure.com/subscriptions", "arm"],
    ["https://myvault.vault.azure.net/secrets/x", "keyvault"],
    ["https://api.loganalytics.io/v1/workspaces/x/query", "loganalytics"],
    ["https://api.loganalytics.azure.com/v1/workspaces/x/query", "loganalytics"],
    ["https://westeurope.monitor.azure.com/x", "monitor"],
    ["https://dce.westeurope.ingest.monitor.azure.com/x", "monitor"],
  ] as const;
  it.each(allowed)("allows %s with the %s token", (url, audience) => {
    expect(checkAuthorizedUrl(url).audience).toBe(audience);
  });

  const refused = [
    "https://evil.example/subscriptions",
    "http://management.azure.com/subscriptions",
    "https://management.azure.com.evil.example/",
    "https://evilmanagement.azure.com/",
    "https://management.azure.com:8443/subscriptions",
    "https://user:pass@management.azure.com/subscriptions",
    "https://vault.azure.net/",
    "https://a.b.vault.azure.net/",
    "https://evil.vault.azure.net.evil.example/",
    "https://-x.vault.azure.net/",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://myaccount.blob.core.windows.net/c/b",
    "https://169.254.169.254/metadata/identity/oauth2/token",
    "file:///etc/passwd",
    "not a url",
  ];
  it.each(refused)("refuses %s", async (url) => {
    const { arm: a } = await arm([{ match: () => true, body: {} }]);
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    await expect(session.authorizedFetch(url)).rejects.toBeInstanceOf(AzureRequestRefusedError);
    // no request reached any server, so no token was attached anywhere
    expect(a.requests).toHaveLength(0);
  });

  it("audienceForHost is exact, case-insensitive and rejects lookalikes", () => {
    expect(audienceForHost("MANAGEMENT.AZURE.COM")).toBe("arm");
    expect(audienceForHost("management.azure.com.")).toBeUndefined();
    expect(audienceForHost("xmanagement.azure.com")).toBeUndefined();
  });

  it("never lets a caller choose the credential: a caller Authorization header is replaced", async () => {
    const { arm: a, entra } = await arm([{ match: () => true, body: {} }]);
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    await session.authorizedFetch("https://management.azure.com/subscriptions", { headers: { Authorization: "Bearer attacker-token-attacker-token", "Proxy-Authorization": "x" } });
    expect(a.requests[0].authorization).toBe(`Bearer ${entra.tokens[0]}`);
  });

  it("does not follow a redirect to a host outside the list, and never sends it the token", async () => {
    const leaked: string[] = [];
    const { arm: a, entra } = await arm([{ match: "/subscriptions", status: 302, headers: { location: "https://evil.example/steal" } }]);
    const base = a.fetchImpl;
    a.fetchImpl = (async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u).startsWith("https://evil.example")) leaked.push(new Headers(i?.headers).get("authorization") ?? "");
      return base(u, i);
    }) as typeof fetch;
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    await expect(session.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toMatchObject({ reason: "redirect_refused" });
    expect(leaked).toEqual([]);
    expect(entra.requests).toHaveLength(1);
  });

  it("follows a redirect to another allowed host with THAT host's token", async () => {
    const { arm: a, entra } = await arm([
      { match: "/subscriptions", status: 307, headers: { location: "https://myvault.vault.azure.net/secrets/x" } },
      { match: "/secrets/x", body: { ok: true } },
    ]);
    const session = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    const res = await session.authorizedFetch("https://management.azure.com/subscriptions");
    expect(res.status).toBe(200);
    expect(entra.requests.map((r) => r.body.get("scope"))).toEqual([TOKEN_SCOPES.arm, TOKEN_SCOPES.keyvault]);
    expect(a.requests[1].authorization).toBe(`Bearer ${entra.tokens[1]}`);
  });
});

describe("tofu environment (azurerm OIDC)", () => {
  async function session(ttl = 300) {
    const { arm: a } = await arm();
    const assertion = fakeAssertion(nowSec() + ttl, "zenith:ws:ws_1:conn:conn_1", "env");
    const s = await createAzureSession({ connection, purpose: "deploy", fetchImpl: a.fetchImpl, mintClientAssertion: async () => assertion });
    return { s, assertion };
  }

  it("carries the OIDC assertion and identifiers, and no client secret", async () => {
    const { s, assertion } = await session();
    const env = s.childProcessEnv();
    expect(env).toMatchObject({ ARM_USE_OIDC: "true", ARM_OIDC_TOKEN: assertion, ARM_CLIENT_ID: CLIENT, ARM_TENANT_ID: TENANT, ARM_SUBSCRIPTION_ID: SUB });
    expect(Object.keys(env).sort()).toEqual(["ARM_CLIENT_ID", "ARM_OIDC_TOKEN", "ARM_RESOURCE_PROVIDER_REGISTRATIONS", "ARM_STORAGE_USE_AZUREAD", "ARM_SUBSCRIPTION_ID", "ARM_TENANT_ID", "ARM_USE_OIDC"]);
    for (const name of Object.keys(env)) expect(name).not.toMatch(/SECRET|PASSWORD|CLIENT_CERTIFICATE|ACCESS_KEY|SAS|CONNECTION_STRING/i);
  });

  it("the ONLY secret-shaped value is the short-lived OIDC assertion (a JWT that expires within minutes)", async () => {
    const { s, assertion } = await session(240);
    const env = s.childProcessEnv();
    const secretish = Object.entries(env).filter(([k, v]) => /token|secret|key|password/i.test(k) || /^eyJ/.test(v));
    expect(secretish).toEqual([["ARM_OIDC_TOKEN", assertion]]);
    const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
    expect(payload.exp * 1000 - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // the tofu runner's output redaction recognizes it as a secret by name
    expect(secretValuesOf(env)).toEqual([assertion]);
  });

  it("is accepted by the tofu environment allowlist (no reserved names)", async () => {
    const { s } = await session();
    expect(() => validateExtraEnv(s.childProcessEnv(), "Session")).not.toThrow();
  });

  it("refuses once the assertion has expired or the session ended", async () => {
    const { arm: a } = await arm();
    let t = Date.now();
    const s = await createAzureSession({ connection, purpose: "deploy", fetchImpl: a.fetchImpl, now: () => new Date(t), mintClientAssertion: async () => fakeAssertion(Math.floor(t / 1000) + 120, "zenith:ws:ws_1:conn:conn_1") });
    expect(() => s.childProcessEnv()).not.toThrow();
    t += 121_000;
    expect(() => s.childProcessEnv()).toThrow(AzureRequestRefusedError);

    const s2 = await createAzureSession({ connection, purpose: "deploy", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    s2.revoke();
    expect(() => s2.childProcessEnv()).toThrow(/ended/);
  });
});

describe("session lifetime and canaries", () => {
  it("refuses calls after revoke() and after expiry", async () => {
    const { arm: a } = await arm([{ match: () => true, body: {} }]);
    let t = Date.parse("2026-09-30T12:00:00Z");
    const s = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, now: () => new Date(t), durationSec: 120, mintClientAssertion: minter(3600) });
    await s.authorizedFetch("https://management.azure.com/subscriptions");
    t += 121_000;
    await expect(s.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toMatchObject({ reason: "session_expired" });

    const s2 = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, mintClientAssertion: minter() });
    s2.revoke();
    await expect(s2.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toBeInstanceOf(CredentialDeniedError);
  });

  it("clamps the lifetime to 60 s … 1 h", async () => {
    const { arm: a } = await arm();
    const now = () => new Date("2026-09-30T12:00:00Z");
    const long = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, now, durationSec: 99999, mintClientAssertion: minter() });
    const short = await createAzureSession({ connection, purpose: "observe", fetchImpl: a.fetchImpl, now, durationSec: 1, mintClientAssertion: minter() });
    expect(long.expiresAt).toBe("2026-09-30T13:00:00.000Z");
    expect(short.expiresAt).toBe("2026-09-30T12:01:00.000Z");
  });

  it("never exposes a token or the assertion through serialization, inspection or string conversion", async () => {
    const { arm: a, entra } = await arm([{ match: () => true, body: {} }]);
    const assertion = fakeAssertion(nowSec() + 300, "zenith:ws:ws_1:conn:conn_1", "canary");
    const s = await createAzureSession({ connection, purpose: "deploy", fetchImpl: a.fetchImpl, mintClientAssertion: async () => assertion });
    await s.authorizedFetch("https://management.azure.com/subscriptions");
    const token = entra.tokens[0];
    const dumps = [JSON.stringify(s), inspect(s, { depth: 6, showHidden: true }), String(s), JSON.stringify(Object.getOwnPropertyNames(s)), inspect(s.authorizedFetch), inspect(s.childProcessEnv)];
    for (const d of dumps) {
      expect(d).not.toContain(token);
      expect(d).not.toContain(assertion);
    }
    expect(JSON.parse(JSON.stringify(s))).toMatchObject({ provider: "azure", subscriptionId: SUB, purpose: "deploy" });
  });

  it("validates the connection before doing anything", async () => {
    const base = { purpose: "observe" as const, mintClientAssertion: minter(), fetchImpl: fakeEntra().fetchImpl };
    await expect(createAzureSession({ ...base, connection: { ...connection, tenantId: "contoso.onmicrosoft.com" } })).rejects.toBeInstanceOf(CredentialDeniedError);
    await expect(createAzureSession({ ...base, connection: { ...connection, clientId: "../x" } })).rejects.toBeInstanceOf(CredentialDeniedError);
    await expect(createAzureSession({ ...base, connection: { ...connection, subscriptionId: "nope" } })).rejects.toBeInstanceOf(CredentialDeniedError);
    await expect(createAzureSession({ ...base, connection: { ...connection, region: "West Europe" } })).rejects.toBeInstanceOf(CredentialDeniedError);
    await expect(createAzureSession({ ...base, connection: { ...connection, mode: "runner", runnerId: "r1" } })).rejects.toBeInstanceOf(CredentialDeniedError);
    await expect(createAzureSession({ ...base, connection: { ...connection, provider: "aws" } as never })).rejects.toBeInstanceOf(CredentialDeniedError);
  });

  it("fails session creation when the minter returns nothing usable", async () => {
    await expect(createAzureSession({ connection, purpose: "observe", fetchImpl: fakeEntra().fetchImpl, mintClientAssertion: async () => "" })).rejects.toBeInstanceOf(CredentialDeniedError);
  });
});
