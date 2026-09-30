import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertGoogleApisUrl, createGcpSession, stsAudience, subjectAudience } from "@/lib/providers/gcp/credentials";
import { GcpAuthError, GcpSessionError, scrub } from "@/lib/providers/gcp/errors";
import { ACCESS_TOKEN, CONNECTION, FakeGoogle, STS_TOKEN, SUBJECT_TOKEN, fakeGoogle } from "./_fake-google";

const servers: FakeGoogle[] = [];
async function fake(): Promise<FakeGoogle> {
  const f = await fakeGoogle();
  servers.push(f);
  return f;
}
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
});

const SECRETS = [SUBJECT_TOKEN, STS_TOKEN, ACCESS_TOKEN];
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

describe("token exchange", () => {
  it("exchanges the Zenith JWT at STS and impersonates the observe service account", async () => {
    const f = (await fake()).auth();
    let audience = "";
    const session = await f.session({
      mintSubjectToken: async (a) => {
        audience = a;
        return SUBJECT_TOKEN;
      },
    });
    expect(audience).toBe(`https://iam.googleapis.com/${CONNECTION.workloadIdentityProvider}`);
    expect(audience).toBe(subjectAudience(CONNECTION.workloadIdentityProvider));

    const [sts] = f.requestsTo("POST", "sts.googleapis.com/v1/token");
    expect(sts.body).toEqual({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      audience: `//iam.googleapis.com/${CONNECTION.workloadIdentityProvider}`,
      subjectToken: SUBJECT_TOKEN,
    });
    expect(stsAudience(CONNECTION.workloadIdentityProvider)).toBe((sts.body as { audience: string }).audience);
    // the STS call carries no bearer token
    expect(sts.headers.authorization).toBeUndefined();

    const iam = f.requests.find((r) => r.host === "iamcredentials.googleapis.com")!;
    expect(decodeURIComponent(iam.path)).toBe("/v1/projects/-/serviceAccounts/zenith-observe@acme-prod-123456.iam.gserviceaccount.com:generateAccessToken");
    expect(iam.headers.authorization).toBe(`Bearer ${STS_TOKEN}`);
    expect(iam.body).toEqual({ scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "900s" });
    expect(session.projectId).toBe(CONNECTION.projectId);
    expect(session.region).toBe(CONNECTION.region);
    expect(session.provider).toBe("gcp");
  });

  it("impersonates the deploy service account for purpose=deploy", async () => {
    const f = (await fake()).auth();
    await f.session({ purpose: "deploy" });
    const iam = f.requests.find((r) => r.host === "iamcredentials.googleapis.com")!;
    expect(decodeURIComponent(iam.path)).toContain("zenith-deploy@acme-prod-123456");
  });

  it("caps the session at 900 seconds even if Google reports a longer expiry", async () => {
    const f = (await fake()).auth({ expireInSec: 3600 });
    const now = new Date("2026-09-30T12:00:00Z");
    const session = await f.session({ now: () => now });
    expect(Date.parse(session.expiresAt)).toBeLessThanOrEqual(now.getTime() + 900_000);
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(now.getTime());
  });

  it("refuses lifetimes above 900 s and below 60 s", async () => {
    const f = (await fake()).auth();
    await expect(f.session({ lifetimeSec: 901 })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(f.session({ lifetimeSec: 10 })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(f.session({ lifetimeSec: 300 })).resolves.toBeDefined();
    expect(f.requestsTo("POST", /iamcredentials/).at(-1)!.body).toEqual({ scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "300s" });
  });
});

describe("failures", () => {
  it("reports an STS rejection without echoing any token, even one the server echoes back", async () => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", { status: 400, json: { error: "invalid_target", error_description: `The audience in ID Token [${SUBJECT_TOKEN}] does not match the expected audience. access_token=${STS_TOKEN}` } });
    const err = await f.session().catch((e: unknown) => e as GcpAuthError);
    expect(err).toBeInstanceOf(GcpAuthError);
    expect((err as GcpAuthError).code).toBe("sts_exchange_failed");
    expect((err as GcpAuthError).status).toBe(400);
    expect((err as GcpAuthError).message).toContain("HTTP 400");
    const text = `${(err as Error).message}\n${(err as Error).stack}\n${JSON.stringify(err)}`;
    expect(leaks(text)).toEqual([]);
  });

  it.each([
    [429, "sts_unavailable"],
    [503, "sts_unavailable"],
    [401, "sts_exchange_failed"],
  ])("classifies STS HTTP %i as %s", async (status, code) => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", { status, json: { error: "x" } });
    await expect(f.session()).rejects.toMatchObject({ code });
  });

  it("reports impersonation denial (403) and outage (500) separately", async () => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", { json: { access_token: STS_TOKEN, token_type: "Bearer", expires_in: 3600 } });
    f.on("POST", /iamcredentials/, { status: 403, json: { error: { code: 403, status: "PERMISSION_DENIED", message: `Permission 'iam.serviceAccounts.getAccessToken' denied; token ${STS_TOKEN}` } } });
    const denied = await f.session().catch((e: unknown) => e as GcpAuthError);
    expect(denied).toMatchObject({ code: "impersonation_failed", status: 403 });
    expect(leaks((denied as Error).message)).toEqual([]);
    expect((denied as Error).message).toContain("PERMISSION_DENIED");

    const g = await fake();
    g.on("POST", "sts.googleapis.com/v1/token", { json: { access_token: STS_TOKEN } });
    g.on("POST", /iamcredentials/, { status: 500, json: {} });
    await expect(g.session()).rejects.toMatchObject({ code: "impersonation_unavailable" });
  });

  it("rejects malformed responses", async () => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", { json: { token_type: "Bearer" } });
    await expect(f.session()).rejects.toMatchObject({ code: "malformed_response" });
    const g = await fake();
    g.on("POST", "sts.googleapis.com/v1/token", { json: { access_token: STS_TOKEN } });
    g.on("POST", /iamcredentials/, { json: { expireTime: "soon" } });
    await expect(g.session()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("scrubs a network error that mentions a token", async () => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", { json: { access_token: STS_TOKEN } });
    const err = await f
      .session({
        fetchImpl: (async (url: string, init?: RequestInit) => {
          if (String(url).includes("sts.")) return f.fetchImpl(url, init);
          throw new Error(`connect ECONNRESET while sending Authorization: Bearer ${STS_TOKEN}`);
        }) as typeof fetch,
      })
      .catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: "impersonation_unavailable" });
    expect(leaks(err.message)).toEqual([]);
  });

  it("does not propagate token text from a failing mintSubjectToken", async () => {
    const f = await fake();
    const err = await f.session({ mintSubjectToken: async () => Promise.reject(new Error(`signer failed for ${SUBJECT_TOKEN}`)) }).catch((e: unknown) => e as GcpAuthError);
    expect(err).toMatchObject({ code: "subject_token_unavailable" });
    expect(leaks(err.message)).toEqual([]);
    expect(f.requests).toHaveLength(0); // nothing was sent
  });

  it("refuses an unusable subject token before any network call", async () => {
    const f = await fake();
    await expect(f.session({ mintSubjectToken: async () => "short" })).rejects.toMatchObject({ code: "subject_token_unavailable" });
    await expect(f.session({ mintSubjectToken: async () => "has whitespace inside the token value here" })).rejects.toMatchObject({ code: "subject_token_unavailable" });
    expect(f.requests).toHaveLength(0);
  });

  it("validates the connection before doing anything", async () => {
    const f = await fake();
    const bad = (over: Record<string, unknown>) => f.session({ connection: { ...CONNECTION, ...over } as typeof CONNECTION });
    await expect(bad({ projectId: "Bad Project" })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(bad({ region: "mars" })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(bad({ workloadIdentityProvider: "projects/x/locations/global/workloadIdentityPools/p/providers/q" })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(bad({ observeServiceAccount: "attacker@evil.example.com" })).rejects.toMatchObject({ code: "invalid_connection" });
    await expect(bad({ mode: "runner" })).rejects.toMatchObject({ code: "unsupported_mode" });
    expect(f.requests).toHaveLength(0);
  });

  it("stops when the abort signal fires", async () => {
    const f = await fake();
    f.on("POST", "sts.googleapis.com/v1/token", async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { json: { access_token: STS_TOKEN } };
    });
    const ac = new AbortController();
    const p = f.session({ signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(GcpAuthError);
  });
});

describe("authorizedFetch", () => {
  it("sends the impersonated token as the bearer and ignores a caller-supplied Authorization header", async () => {
    const f = await fake();
    f.get("run.googleapis.com/v2/projects/p/ping", { json: { ok: true } });
    const s = await f.session();
    const res = await s.authorizedFetch("https://run.googleapis.com/v2/projects/p/ping", { headers: { authorization: "Bearer attacker-supplied" } });
    expect(await res.json()).toEqual({ ok: true });
    expect(f.requests.at(-1)!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it.each([
    "https://evil.example.com/v1/x",
    "http://run.googleapis.com/v2/x",
    "https://run.googleapis.com.evil.com/v2/x",
    "https://googleapis.com/v1/x",
    "https://evilgoogleapis.com/v1/x",
    "https://user:pw@run.googleapis.com/v2/x",
    "https://run.googleapis.com:8443/v2/x",
    "https://169.254.169.254/computeMetadata/v1/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "file:///etc/passwd",
    "run.googleapis.com/v2/x",
    "https://run.googleapis.com@evil.com/v2/x",
    "https://run.googleapis.com%2eevil.com/v2/x",
    "https://storage.googleapis.com.attacker.net/",
    "https://www.googleapis.com.evil.co/",
  ])("refuses %s and sends nothing", async (url) => {
    const f = await fake();
    const s = await f.session();
    const before = f.requests.length;
    await expect(s.authorizedFetch(url)).rejects.toBeInstanceOf(GcpSessionError);
    expect(f.requests.length).toBe(before);
  });

  it("accepts regional and global googleapis.com hosts", () => {
    for (const u of ["https://run.googleapis.com/v2/a", "https://asia-south1-run.googleapis.com/v2/a", "https://www.googleapis.com/compute/v1/a", "https://storage.googleapis.com/storage/v1/b"]) {
      expect(() => assertGoogleApisUrl(u)).not.toThrow();
    }
  });

  it("refuses a redirect rather than following it with the bearer token", async () => {
    const f = await fake();
    f.get("run.googleapis.com/v2/redir", { status: 302, headers: { location: "https://evil.example.com/steal" } });
    const s = await f.session();
    await expect(s.authorizedFetch("https://run.googleapis.com/v2/redir")).rejects.toMatchObject({ code: "redirect_refused" });
    expect(f.requests.filter((r) => r.host === "evil.example.com")).toHaveLength(0);
  });

  it("is unusable once closed, and once expired", async () => {
    const f = await fake();
    let t = new Date("2026-09-30T12:00:00Z").getTime();
    const s = await f.session({ now: () => new Date(t) });
    f.get("run.googleapis.com/v2/ok", { json: {} });
    await expect(s.authorizedFetch("https://run.googleapis.com/v2/ok")).resolves.toBeDefined();
    expect(() => s.childProcessEnv()).not.toThrow();

    t += 901_000; // past the 900 s cap
    await expect(s.authorizedFetch("https://run.googleapis.com/v2/ok")).rejects.toMatchObject({ code: "session_expired" });
    expect(() => s.childProcessEnv()).toThrow(GcpSessionError);

    const c = await f.session();
    c.close();
    expect(c.closed).toBe(true);
    await expect(c.authorizedFetch("https://run.googleapis.com/v2/ok")).rejects.toMatchObject({ code: "session_closed" });
    expect(() => c.childProcessEnv()).toThrow(/closed/);
  });
});

describe("childProcessEnv", () => {
  it("contains exactly the token, project and region for tofu, as a fresh copy", async () => {
    const f = await fake();
    const s = await f.session({ purpose: "deploy" });
    const env = s.childProcessEnv();
    expect(Object.keys(env).sort()).toEqual(["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_PROJECT", "GOOGLE_REGION"]);
    expect(env).toEqual({ GOOGLE_OAUTH_ACCESS_TOKEN: ACCESS_TOKEN, GOOGLE_PROJECT: CONNECTION.projectId, GOOGLE_REGION: CONNECTION.region });
    env.GOOGLE_OAUTH_ACCESS_TOKEN = "mutated";
    expect(s.childProcessEnv().GOOGLE_OAUTH_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
  });
});

describe("canary: the access token never leaves through the session object", () => {
  it("is absent from JSON, inspect, String, own properties and prototypes", async () => {
    const f = await fake();
    const s = await f.session();
    const views = [
      JSON.stringify(s),
      inspect(s, { depth: 6, showHidden: true }),
      String(s),
      JSON.stringify(Object.getOwnPropertyNames(s)),
      JSON.stringify(Object.values(s).filter((v) => typeof v !== "function")),
      JSON.stringify(Object.getOwnPropertyDescriptors(s), (_k, v) => (typeof v === "function" ? "[fn]" : v)),
    ];
    for (const v of views) expect(leaks(v)).toEqual([]);
    expect(Object.keys(JSON.parse(JSON.stringify(s))).sort()).toEqual(["closed", "expiresAt", "projectId", "provider", "purpose", "region"]);
  });

  it("is absent from the error thrown for a forbidden host and for a failed API call", async () => {
    const f = await fake();
    f.get("run.googleapis.com/v2/boom", { status: 500, json: { error: { message: `internal; Authorization: Bearer ${ACCESS_TOKEN}` } } });
    const s = await f.session();
    const bad = await s.authorizedFetch("https://evil.example.com/").catch((e: Error) => e);
    expect(leaks(`${(bad as Error).message}${(bad as Error).stack}`)).toEqual([]);
    // a 500 is returned as a Response for the REST client to classify; the client scrubs its body
    const res = await s.authorizedFetch("https://run.googleapis.com/v2/boom");
    expect(res.status).toBe(500);
  });
});

describe("scrub", () => {
  it("removes exact values, google tokens, jwts, bearer headers and pem blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    const out = scrub(`x ${ACCESS_TOKEN} ${SUBJECT_TOKEN} Authorization: Bearer abcdef123456 ${pem} custom-secret-value`, ["custom-secret-value"]);
    for (const s of [ACCESS_TOKEN, SUBJECT_TOKEN, "abcdef123456", "AAAA", "custom-secret-value"]) expect(out).not.toContain(s);
  });

  it("bounds the length", () => {
    expect(scrub("a".repeat(2000), [], 50).length).toBeLessThanOrEqual(51);
  });
});
