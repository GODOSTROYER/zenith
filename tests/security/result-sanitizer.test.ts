/**
 * PROD-MACH-05: the model-visible result sanitizer. Credential-shaped fixtures
 * are assembled at run time so no source line looks like a real key.
 */
import { describe, expect, it } from "vitest";
import { buildEnvelope, buildErrorEnvelope } from "@/lib/agent-access/v3/envelope";
import { detectCredentialShapes, isSecretMemberName, redactionNote, sanitizeForModel, sanitizeText, SANITIZER_NOTE } from "@/lib/security/result-sanitizer";

const keyId = (): string => "AK" + "IA" + "Q".repeat(16);
const jwt = (): string => ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(12), "c".repeat(16)].join(".");
const pem = (): string => ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\nMIIB" + "x".repeat(60) + "\n" + ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const ghToken = (): string => "gh" + "p_" + "z".repeat(36);
const tool = { name: "zenith_get_operation", schemaVersion: 1 };

describe("value rules", () => {
  it("replaces credential shapes with explicit kind markers and reports them", () => {
    const input = { log: `deploy used ${keyId()} then ${jwt()} then ${ghToken()}\n${pem()}`, url: "postgres://admin:hunter22pw@db.internal/app" };
    const { value, report } = sanitizeForModel(input);
    const text = JSON.stringify(value);
    for (const leaked of [keyId(), jwt(), ghToken(), "MIIB", "hunter22pw"]) expect(text).not.toContain(leaked);
    for (const kind of ["aws-access-key-id", "jwt", "github-token", "private-key", "url-password"]) {
      expect(text).toContain(`[REDACTED:${kind}]`);
      expect(report.kinds).toContain(kind);
    }
    expect(report.redactions).toBeGreaterThanOrEqual(5);
    expect(report.applied).toBe(true);
  });

  it("never claims completeness, even when it changed nothing", () => {
    const { value, report } = sanitizeForModel({ name: "web", replicas: 2 });
    expect(value).toEqual({ name: "web", replicas: 2 });
    expect(report.redactions).toBe(0);
    expect(report.completeness).toBe("best_effort");
    expect(redactionNote(report)).toBeUndefined();
    expect(SANITIZER_NOTE).toMatch(/best-effort/);
    expect(SANITIZER_NOTE).toMatch(/can remain/);
  });

  it("an unrecognised secret shape is NOT claimed to be caught", () => {
    const opaque = "plainwordsecretthatnopatternmatches";
    const { value } = sanitizeForModel({ note: `the value is ${opaque}` });
    expect(JSON.stringify(value)).toContain(opaque);
  });

  it("removes name = value assignments but leaves references and benign values", () => {
    const { text: value } = sanitizeText("db_password = s3cr3tvalue99 and secretRef: vault:API_KEY and token_count = 12 and api_key = (sensitive value)");
    expect(value).toContain("db_password = [REDACTED:secret-assignment]");
    expect(value).not.toContain("s3cr3tvalue99");
    expect(value).toContain("vault:API_KEY");
    expect(value).toContain("token_count = 12");
    expect(value).toContain("(sensitive value)");
  });
});

describe("member rules", () => {
  it("replaces every string under a secret-named member, keeps references and non-secret names", () => {
    const { value, report } = sanitizeForModel({
      password: "pw-123456",
      credentials: { accessKeyId: "id-ish-value", nested: ["a-b-c-d-e-f"] },
      clientSecret: "vault:CLIENT_SECRET",
      tokenCount: 5,
      maxTokens: 1000,
      nextToken: "page-2",
      hasPassword: true,
      secretName: "db-pass",
      accessToken: "tok-abcdefgh",
    });
    expect(value).toEqual({
      password: "[REDACTED:secret-member]",
      credentials: { accessKeyId: "[REDACTED:secret-member]", nested: ["[REDACTED:secret-member]"] },
      clientSecret: "vault:CLIENT_SECRET",
      tokenCount: 5,
      maxTokens: 1000,
      nextToken: "page-2",
      hasPassword: true,
      secretName: "db-pass",
      accessToken: "[REDACTED:secret-member]",
    });
    expect(report.kinds).toContain("secret-member");
    expect(report.paths).toContain("credentials.nested[0]");
  });

  it("decides secret-ness by suffix, not substring", () => {
    for (const k of ["password", "dbPassword", "x-api-key", "client_secret", "authorization", "Set-Cookie", "sessionToken"]) expect(isSecretMemberName(k)).toBe(true);
    for (const k of ["tokenCount", "maxTokens", "secretName", "secretRef", "passwordPolicy", "isSecret", "hasToken", "nextToken"]) expect(isSecretMemberName(k)).toBe(false);
  });

  it("scrubs a secret used as a member NAME and keeps members distinct", () => {
    const { value } = sanitizeForModel({ [keyId()]: "a", [`${keyId()} `]: "b" });
    const keys = Object.keys(value as Record<string, unknown>);
    expect(keys.join()).not.toContain(keyId());
    expect(new Set(keys).size).toBe(2);
  });
});

describe("exact values and limits", () => {
  it("removes known secrets wherever they appear, including keys", () => {
    const secret = "known-" + "s".repeat(20);
    const { value, report } = sanitizeForModel({ [`k-${secret}`]: `prefix ${secret} suffix`, list: [secret] }, { knownSecrets: [secret, "short"] });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(report.kinds).toContain("known-secret");
  });

  it("fails closed beyond depth, node and string limits, and says so", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const d = sanitizeForModel(deep);
    expect(JSON.stringify(d.value)).toContain("[REDACTED:unscanned]");
    expect(d.report.scanLimited).toBe(true);

    const big = "a".repeat(2_000_100) + keyId();
    const s = sanitizeForModel(big);
    expect(s.value).not.toContain(keyId());
    expect(s.value as string).toMatch(/\[REDACTED:unscanned-tail\]$/);
    expect(s.report.scanLimited).toBe(true);
  });

  it("handles cycles, errors and binary without throwing or leaking", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(JSON.stringify(sanitizeForModel(cyc).value)).toContain("[Circular]");
    const err = sanitizeForModel(new Error(`failed with ${keyId()}`)).value as { message: string };
    expect(err.message).not.toContain(keyId());
    expect(sanitizeForModel({ blob: new Uint8Array([1, 2, 3]) }).value).toEqual({ blob: "[REDACTED:binary]" });
  });

  it("detectCredentialShapes names high-confidence kinds only and never returns text", () => {
    expect(detectCredentialShapes({ a: `x ${keyId()}` })).toEqual(["aws-access-key-id"]);
    expect(detectCredentialShapes({ password: "something-long-enough", note: "hello" })).toEqual([]);
    expect(JSON.stringify(detectCredentialShapes({ a: pem() }))).not.toContain("MIIB");
  });
});

describe("MCP v3 envelope integration", () => {
  it("scrubs data, untrusted data, notes and errors, and says so without claiming completeness", () => {
    const envelope = buildEnvelope(tool, {
      data: { id: "op_1", token: "literal-token-value" },
      untrusted: { log: `saw ${keyId()}` },
      notes: [`note ${ghToken()}`],
    });
    const text = JSON.stringify(envelope);
    for (const leaked of ["literal-token-value", keyId(), ghToken()]) expect(text).not.toContain(leaked);
    expect(text).toContain("[REDACTED:");
    const note = envelope.notes.find((n) => n.includes("replaced by [REDACTED"));
    expect(note).toBeTruthy();
    expect(note).toContain("best-effort");

    const err = buildErrorEnvelope(tool, { code: "failed", message: `bad ${jwt()}`, details: { password: "hunter22pw" }, retryable: false });
    expect(JSON.stringify(err)).not.toMatch(/hunter22pw|eyJa{12}/);
    expect(err.notes.some((n) => n.includes("best-effort"))).toBe(true);
  });

  it("adds no redaction note when nothing was replaced", () => {
    const envelope = buildEnvelope(tool, { data: { id: "op_1", status: "succeeded" } });
    expect(envelope.notes).toEqual([]);
  });
});
