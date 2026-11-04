import { describe, expect, it } from "vitest";
import {
  CredentialLeakError,
  assertNoCredentialLeak,
  credentialPatternsIn,
  redactCredentials,
  redactDeep,
} from "@/lib/credentials/redact";
import { FAKE_CREDS } from "./helpers";

const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImsxIn0.eyJzdWIiOiJ6ZW5pdGg6d3M6MTpjb25uOjIiLCJhdWQiOiJzdHMuYW1hem9uYXdzLmNvbSJ9.c2lnbmF0dXJlX2J5dGVzX2hlcmVfMTIzNDU2";

describe("redactCredentials", () => {
  it("masks AWS access key ids but keeps the prefix for debugging", () => {
    const out = redactCredentials(`key=AKIAIOSFODNN7EXAMPLE and ${FAKE_CREDS.AccessKeyId}`);
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain(FAKE_CREDS.AccessKeyId);
    expect(out).toContain("AKIA****");
    expect(out).toContain("ASIA****");
  });

  it("masks secret access keys bare and in assignments/JSON, but not git SHAs or plain words", () => {
    expect(redactCredentials(FAKE_CREDS.SecretAccessKey)).not.toContain(FAKE_CREDS.SecretAccessKey);
    expect(redactCredentials(`aws_secret_access_key = ${FAKE_CREDS.SecretAccessKey}`)).toBe("aws_secret_access_key = [REDACTED]");
    expect(redactCredentials(`{"SecretAccessKey":"abc123-not-a-real-one"}`)).toBe(`{"SecretAccessKey":"[REDACTED]"}`);
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    expect(redactCredentials(`commit ${sha} on main`)).toBe(`commit ${sha} on main`);
    expect(redactCredentials("The quick brown fox jumps over the lazy dog")).toBe("The quick brown fox jumps over the lazy dog");
  });

  it("masks session tokens (prefix, assignment, header, and long blobs)", () => {
    expect(redactCredentials(FAKE_CREDS.SessionToken)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(redactCredentials(`AWS_SESSION_TOKEN=${FAKE_CREDS.SessionToken}`)).toBe("AWS_SESSION_TOKEN=[REDACTED]");
    expect(redactCredentials("X-Amz-Security-Token: abcdef123456789")).toBe("X-Amz-Security-Token: [REDACTED]");
    expect(redactCredentials(`blob ${"Q".repeat(200)}`)).toBe("blob [REDACTED BLOB]");
  });

  it("masks JWTs, bearer tokens and Authorization headers", () => {
    expect(redactCredentials(`token: ${JWT}`)).toBe("token: [REDACTED JWT]");
    expect(redactCredentials("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: [REDACTED]");
    expect(redactCredentials("curl -H 'Bearer s3cr3tvalue9999'")).toContain("Bearer [REDACTED]");
    expect(redactCredentials("authorization=Basic dXNlcjpwYXNzd29yZA==")).toBe("authorization=[REDACTED]");
  });

  it("removes PEM private keys whole, including a truncated one, and masks other PEM blocks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nabc\n-----END PRIVATE KEY-----";
    expect(redactCredentials(`before\n${pem}\nafter`)).toBe("before\n[REDACTED PEM PRIVATE KEY]\nafter");
    expect(redactCredentials("x -----BEGIN RSA PRIVATE KEY-----\nMIIabc")).toBe("x [REDACTED PEM PRIVATE KEY]");
    expect(redactCredentials("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----")).toBe("[REDACTED PEM BLOCK]");
  });

  it("masks Zenith registration and integration tokens", () => {
    expect(redactCredentials("zrt_Abcdefghijklmnopqrstuvwx")).toBe("[REDACTED ZENITH TOKEN]");
    expect(redactCredentials("use za_0123456789abcdef0123 now")).toBe("use [REDACTED ZENITH TOKEN] now");
  });

  it("leaves references alone: ARNs, vault refs, secret names, account ids", () => {
    const refs = [
      "arn:aws:iam::123456789012:role/ZenithObserveRole",
      "vault:ws_1/db-password",
      "arn:aws:secretsmanager:ap-south-1:123456789012:secret:zenith/prod/db-AbCdEf",
      "secret name zenith/prod/db",
    ];
    for (const r of refs) expect(redactCredentials(r)).toBe(r);
  });

  it("is idempotent and tolerates non-strings and empty input", () => {
    const once = redactCredentials(`a ${FAKE_CREDS.SecretAccessKey} b ${JWT}`);
    expect(redactCredentials(once)).toBe(once);
    expect(redactCredentials("")).toBe("");
    expect(redactCredentials(undefined as never)).toBeUndefined();
  });
});

describe("credentialPatternsIn", () => {
  it("names the matching rules without returning matched text", () => {
    expect(credentialPatternsIn(`x ${JWT}`)).toContain("jwt");
    expect(credentialPatternsIn(FAKE_CREDS.AccessKeyId)).toEqual(["aws-access-key-id"]);
    expect(credentialPatternsIn("hello")).toEqual([]);
  });
});

describe("redactDeep", () => {
  it("redacts strings at any depth, including keys and errors, and survives cycles", () => {
    const a: Record<string, unknown> = { note: `k ${FAKE_CREDS.AccessKeyId}`, list: [JWT], err: new Error(`bad ${FAKE_CREDS.AccessKeyId}`) };
    a.self = a;
    const out = redactDeep(a) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(FAKE_CREDS.AccessKeyId);
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(out.self).toBe("[Circular]");
  });
});

describe("assertNoCredentialLeak", () => {
  it("passes clean values", () => {
    expect(() => assertNoCredentialLeak({ a: 1, b: ["x", { c: "arn:aws:iam::123456789012:role/r" }], d: new Error("nope") })).not.toThrow();
  });

  it("finds a credential in a nested value, an error message, a stack, a cause, a map and a key", () => {
    const secret = FAKE_CREDS.SecretAccessKey;
    const cases: unknown[] = [
      { a: { b: [{ c: secret }] } },
      new Error(`boom ${secret}`),
      Object.assign(new Error("outer"), { cause: new Error(`inner ${secret}`) }),
      new Map([["k", secret]]),
      { [secret]: 1 },
      new Set([secret]),
      { blob: Buffer.from(secret) },
    ];
    for (const c of cases) expect(() => assertNoCredentialLeak(c)).toThrow(CredentialLeakError);
  });

  it("finds exact known secrets even when they match no pattern, and never prints the value", () => {
    let err: unknown;
    try {
      assertNoCredentialLeak({ nested: { v: "hunter2-hunter2" } }, { secrets: ["hunter2-hunter2"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialLeakError);
    expect((err as Error).message).toContain("$.nested.v");
    expect((err as Error).message).not.toContain("hunter2");
  });

  it("honours allow-listed patterns, handles cycles, and bounds depth", () => {
    expect(() => assertNoCredentialLeak({ jwt: JWT }, { allow: ["jwt"] })).not.toThrow();
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => assertNoCredentialLeak(a)).not.toThrow();
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 30; i++) deep = (deep.n = {}) as Record<string, unknown>;
    expect(() => assertNoCredentialLeak(root, { maxDepth: 5 })).toThrow(/max-depth/);
  });
});
