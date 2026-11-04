import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as discoveryGET } from "@/app/api/oidc/.well-known/openid-configuration/route";
import { GET as jwksGET } from "@/app/api/oidc/jwks/route";
import { OidcError } from "@/lib/credentials/errors";
import { AWS_STS_AUDIENCE, mintWorkloadToken, workloadSubject } from "@/lib/credentials/oidc/issuer";
import { LocalJwkSigner, generateSigningJwk, resetSignerCache, serializePrivateJwk } from "@/lib/credentials/signing";
import { ISSUER, makeKeys, type Keys } from "./helpers";

let keys: Keys;
beforeAll(async () => {
  keys = await makeKeys();
});

beforeEach(() => {
  resetSignerCache();
  vi.stubEnv("ZENITH_OIDC_SIGNING_JWK", serializePrivateJwk(keys.rsa));
  vi.stubEnv("ZENITH_OIDC_ISSUER", "");
  vi.stubEnv("ZENITH_OIDC_KMS_KEY_ID", "");
  vi.stubEnv("ZENITH_OIDC_EXTRA_PUBLIC_JWKS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSignerCache();
});

const req = (path: string, origin = "https://zenith.test") => new Request(`${origin}${path}`);

describe("GET /api/oidc/.well-known/openid-configuration", () => {
  it("serves the discovery document with the issuer derived from the request origin", async () => {
    const res = await discoveryGET(req("/api/oidc/.well-known/openid-configuration"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toMatch(/public/);
    const doc = await res.json();
    expect(doc).toMatchObject({
      issuer: "https://zenith.test/api/oidc",
      jwks_uri: "https://zenith.test/api/oidc/jwks",
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(doc.claims_supported).toEqual(expect.arrayContaining(["iss", "sub", "aud", "exp", "iat", "jti", "zenith_op", "zenith_cap"]));
  });

  it("prefers ZENITH_OIDC_ISSUER over the request origin", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", "https://idp.tryzenith.cloud/api/oidc/");
    const doc = await (await discoveryGET(req("/x", "https://internal.vercel.app"))).json();
    expect(doc.issuer).toBe("https://idp.tryzenith.cloud/api/oidc");
    expect(doc.jwks_uri).toBe("https://idp.tryzenith.cloud/api/oidc/jwks");
  });

  it("is 503 and uncacheable when no signer is configured", async () => {
    vi.stubEnv("ZENITH_OIDC_SIGNING_JWK", "");
    const res = await discoveryGET(req("/x"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).error).toBe("oidc_not_configured");
  });

  it("is 503 (not a stack trace) on a malformed issuer override", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", "not a url");
    const res = await discoveryGET(req("/x"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/oidc/jwks", () => {
  it("publishes only public keys, current first then the next key, with cache headers", async () => {
    const next = await generateSigningJwk("RS256");
    vi.stubEnv("ZENITH_OIDC_EXTRA_PUBLIC_JWKS", JSON.stringify({ keys: [next.publicJwk] }));
    const res = await jwksGET(req("/api/oidc/jwks"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
    const body = await res.json();
    expect(body.keys.map((k: { kid: string }) => k.kid)).toEqual([keys.rsa.kid, next.kid]);
    const text = JSON.stringify(body);
    for (const secret of [keys.rsa.privateJwk.d, keys.rsa.privateJwk.p, keys.rsa.privateJwk.q]) expect(text).not.toContain(secret);
    for (const k of body.keys) {
      expect(k).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
      for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(k).not.toHaveProperty(m);
    }
  });

  it("is 503 with a fixed body when the key material is unusable", async () => {
    vi.stubEnv("ZENITH_OIDC_SIGNING_JWK", "{\"kty\":\"RSA\",\"d\":\"SENTINEL-PRIVATE-VALUE\"}");
    const res = await jwksGET(req("/api/oidc/jwks"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("SENTINEL-PRIVATE-VALUE");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses to publish a private key placed in the extras", async () => {
    vi.stubEnv("ZENITH_OIDC_EXTRA_PUBLIC_JWKS", JSON.stringify({ keys: [keys.rsa.privateJwk] }));
    const res = await jwksGET(req("/api/oidc/jwks"));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(keys.rsa.privateJwk.d);
  });
});

describe("mintWorkloadToken", () => {
  const input = {
    workspaceId: "ws_1",
    connectionId: "conn_1",
    audience: AWS_STS_AUDIENCE,
    operationId: "op_1",
    capability: "infrastructure.observe",
  };

  it("mints an RS256 JWT that verifies against the published JWKS with exact iss/sub/aud and exp ≤ 300 s", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", ISSUER);
    const token = await mintWorkloadToken({ ...input, ttlSec: 300 });
    const jwks = await (await jwksGET(req("/api/oidc/jwks"))).json();
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: ISSUER,
      audience: "sts.amazonaws.com",
      subject: "zenith:ws:ws_1:conn:conn_1",
      algorithms: ["RS256"],
      requiredClaims: ["iat", "nbf", "exp", "jti"],
    });
    expect(protectedHeader).toMatchObject({ alg: "RS256", typ: "JWT", kid: keys.rsa.kid });
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
    expect(payload.nbf).toBe(payload.iat);
    expect(payload.zenith_op).toBe("op_1");
    expect(payload.zenith_cap).toBe("infrastructure.observe");
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    // never carries secrets: the payload is exactly the documented claims
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "nbf", "sub", "zenith_cap", "zenith_op"]);
  });

  it("defaults to a short ttl and gives every token a fresh jti", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", ISSUER);
    const a = decodeJwt(await mintWorkloadToken(input));
    const b = decodeJwt(await mintWorkloadToken(input));
    expect(a.exp! - a.iat!).toBeLessThanOrEqual(300);
    expect(a.jti).not.toBe(b.jti);
  });

  it("rejects ttl above 300 or non-integer, and never clamps silently", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", ISSUER);
    await expect(mintWorkloadToken({ ...input, ttlSec: 301 })).rejects.toMatchObject({ code: "oidc_ttl_invalid" });
    await expect(mintWorkloadToken({ ...input, ttlSec: 0 })).rejects.toMatchObject({ code: "oidc_ttl_invalid" });
    await expect(mintWorkloadToken({ ...input, ttlSec: 1.5 })).rejects.toMatchObject({ code: "oidc_ttl_invalid" });
  });

  it("refuses ids that could forge the subject structure", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", ISSUER);
    await expect(mintWorkloadToken({ ...input, workspaceId: "ws_1:conn:evil" })).rejects.toBeInstanceOf(OidcError);
    await expect(mintWorkloadToken({ ...input, connectionId: "conn 1" })).rejects.toBeInstanceOf(OidcError);
    await expect(mintWorkloadToken({ ...input, connectionId: "" })).rejects.toBeInstanceOf(OidcError);
    await expect(mintWorkloadToken({ ...input, operationId: "op\n1" })).rejects.toBeInstanceOf(OidcError);
    await expect(mintWorkloadToken({ ...input, audience: "has space" })).rejects.toBeInstanceOf(OidcError);
    expect(() => workloadSubject("a:b", "c")).toThrow(OidcError);
    expect(workloadSubject("ws_1", "conn_1")).toBe("zenith:ws:ws_1:conn:conn_1");
  });

  it("names the missing variable when the issuer or signer is not configured", async () => {
    await expect(mintWorkloadToken(input, { env: { ZENITH_OIDC_SIGNING_JWK: serializePrivateJwk(keys.rsa) } })).rejects.toThrow(
      /ZENITH_OIDC_ISSUER/
    );
    await expect(mintWorkloadToken(input, { env: { ZENITH_OIDC_ISSUER: ISSUER } })).rejects.toThrow(/ZENITH_OIDC_SIGNING_JWK/);
  });

  it("refuses a non-RS256 signer for the OIDC issuer", async () => {
    const ed = LocalJwkSigner.fromJwk("T", keys.ed.privateJwk, { alg: "EdDSA" });
    await expect(mintWorkloadToken(input, { signer: ed, issuer: ISSUER })).rejects.toMatchObject({ code: "oidc_signer_algorithm" });
  });

  it("embeds AWS session tags in the nested claim format only when asked", async () => {
    vi.stubEnv("ZENITH_OIDC_ISSUER", ISSUER);
    const withTags = decodeJwt(
      await mintWorkloadToken({ ...input, sessionTags: { "zenith:workspace": "ws_1", "zenith:operation": "op_1" } })
    );
    expect(withTags["https://aws.amazon.com/tags"]).toEqual({
      principal_tags: { "zenith:workspace": ["ws_1"], "zenith:operation": ["op_1"] },
    });
    const without = decodeJwt(await mintWorkloadToken(input));
    expect(without).not.toHaveProperty(["https://aws.amazon.com/tags"]);
    await expect(mintWorkloadToken({ ...input, sessionTags: { "aws:reserved": "x" } })).rejects.toBeInstanceOf(OidcError);
  });

  it("uses the injected clock", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const claims = decodeJwt(await mintWorkloadToken(input, { issuer: ISSUER, now, jti: "fixed" }));
    expect(claims.iat).toBe(now.getTime() / 1000);
    expect(claims.jti).toBe("fixed");
    expect(decodeProtectedHeader(await mintWorkloadToken(input, { issuer: ISSUER }))).toMatchObject({ alg: "RS256" });
  });
});
