/** RFC 8414 discovery order and the checks Zenith needs the configured issuer to pass. */
import { describe, expect, it, vi } from "vitest";
import { checkAuthorizationServerMetadata, fetchAuthorizationServerMetadata, metadataCandidates } from "@/lib/agent-access/oauth/as-metadata";

const ISSUER = "https://issuer.example.test/tenant";
const good = {
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: "https://issuer.example.test/keys",
  revocation_endpoint: `${ISSUER}/revoke`, registration_endpoint: `${ISSUER}/register`, code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"], authorization_response_iss_parameter_supported: true,
};

describe("metadataCandidates", () => {
  it("tries RFC 8414 path insertion, then OpenID forms, for an issuer with a path", () => {
    expect(metadataCandidates(ISSUER)).toEqual([
      "https://issuer.example.test/.well-known/oauth-authorization-server/tenant",
      "https://issuer.example.test/.well-known/openid-configuration/tenant",
      "https://issuer.example.test/tenant/.well-known/openid-configuration",
    ]);
  });
  it("uses the two root forms for an issuer without a path", () => {
    expect(metadataCandidates("https://issuer.example.test")).toEqual(["https://issuer.example.test/.well-known/oauth-authorization-server", "https://issuer.example.test/.well-known/openid-configuration"]);
    expect(metadataCandidates("https://issuer.example.test/")).toHaveLength(2);
  });
});

describe("fetchAuthorizationServerMetadata", () => {
  it("returns the first candidate that answers, refusing redirects", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      expect(init?.redirect).toBe("error");
      return String(url).includes("openid-configuration/tenant") ? Response.json(good) : new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const found = await fetchAuthorizationServerMetadata(ISSUER, fetcher);
    expect(found?.url).toBe("https://issuer.example.test/.well-known/openid-configuration/tenant");
    expect(seen).toHaveLength(2);
  });
  it("is undefined when nothing answers", async () => {
    expect(await fetchAuthorizationServerMetadata(ISSUER, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeUndefined();
  });
});

describe("checkAuthorizationServerMetadata", () => {
  it("accepts a complete document", () => {
    expect(checkAuthorizationServerMetadata(ISSUER, good, { jwksUrl: "https://issuer.example.test/keys" })).toEqual([]);
  });
  it("fails on an issuer that is not identical, including a trailing slash", () => {
    expect(checkAuthorizationServerMetadata(ISSUER, { ...good, issuer: `${ISSUER}/` }).map((f) => f.level)).toContain("fail");
    expect(checkAuthorizationServerMetadata(ISSUER, { ...good, issuer: undefined }).some((f) => f.message.includes("identical"))).toBe(true);
  });
  it("fails without S256 PKCE, without https endpoints, and on a JWKS that differs from configuration", () => {
    const messages = (m: object, expected = {}) => checkAuthorizationServerMetadata(ISSUER, { ...good, ...m }, expected).filter((f) => f.level === "fail").map((f) => f.message).join(" | ");
    expect(messages({ code_challenge_methods_supported: ["plain"] })).toContain("S256");
    expect(messages({ code_challenge_methods_supported: undefined })).toContain("S256");
    expect(messages({ authorization_endpoint: "http://issuer.example.test/authorize" })).toContain("authorization_endpoint");
    expect(messages({ token_endpoint: undefined })).toContain("token_endpoint");
    expect(messages({ grant_types_supported: ["client_credentials"] })).toContain("authorization_code");
    expect(messages({}, { jwksUrl: "https://other.example.test/keys" })).toContain("jwks_uri");
  });
  it("only warns about a missing revocation or registration endpoint and RFC 9207", () => {
    const findings = checkAuthorizationServerMetadata(ISSUER, { ...good, revocation_endpoint: undefined, registration_endpoint: undefined, authorization_response_iss_parameter_supported: undefined });
    expect(findings.map((f) => f.level)).toEqual(["warn", "warn", "warn"]);
  });
  it("allows loopback http only when the caller says it is a local fixture", () => {
    const local = { ...good, issuer: "http://127.0.0.1:9", authorization_endpoint: "http://127.0.0.1:9/a", token_endpoint: "http://127.0.0.1:9/t", revocation_endpoint: "http://127.0.0.1:9/r" };
    expect(checkAuthorizationServerMetadata("http://127.0.0.1:9", local).some((f) => f.level === "fail")).toBe(true);
    expect(checkAuthorizationServerMetadata("http://127.0.0.1:9", local, { allowLoopbackHttp: true }).some((f) => f.level === "fail")).toBe(false);
  });
});
