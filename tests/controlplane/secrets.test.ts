/**
 * The secret-material guards: key-name rules for structured configuration,
 * value-shape rules for free-form data, and the property that an error names the
 * PATH of the offender and never its value.
 */
import { describe, expect, it } from "vitest";
import { ControlStoreError, assertNoSecretKeys, assertNoSecretValues, isSecretKey } from "@/lib/controlplane/db";

const SECRET_VALUES: [string, string][] = [
  ["a PEM private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----"],
  ["an RSA PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nabc"],
  ["an OpenSSH private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
  ["a JWT", "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ6ZW5pdGgifQ.c2lnbmF0dXJlLWJ5dGVzLWhlcmU"],
  ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ["an AWS session key id", "context ASIAIOSFODNN7EXAMPLE trailing"],
  ["a bearer credential", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
  ["a URL with an embedded password", "postgres://admin:hunter2@db.internal:5432/app"],
  ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["a Slack token", "xoxb-1234567890-abcdefghij"],
  ["a payment provider secret key", "sk_live_abcdefghijklmnop1234"],
  ["a model provider API key", "sk-ant-api03-abcdefghijklmnop"],
];

const BENIGN_VALUES = [
  "vault:db-password",
  "arn:aws:secretsmanager:ap-south-1:123456789012:secret:prod/db-AbCdEf",
  "arn:aws:iam::123456789012:role/zenith-deploy",
  "https://example.com:8080/path?x=1",
  "postgres://db.internal:5432/app",
  "user@example.com",
  "550e8400-e29b-41d4-a716-446655440000",
  "a".repeat(64),
  "Akiara Restaurant, Akia, AKIA", // shapes that merely resemble a prefix
  "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ6ZW5pdGgifQ", // two segments: not a JWT
  "Bearer",
  "the token count is 1200",
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", // public certificates are not secrets
];

describe("isSecretKey", () => {
  it("flags names that hold secret material, in any casing or separator", () => {
    for (const k of ["secret", "secretAccessKey", "SecretAccessKey", "secret_access_key", "SECRET-ACCESS-KEY", "password", "passwd", "Passphrase", "token", "sessionToken", "accessToken", "refresh_token", "privateKey", "private_key", "apiKey", "api-key", "API_KEY", "clientSecret", "accessKey", "access_key_id", "bearerToken", "sessionKey"])
      expect(isSecretKey(k), k).toBe(true);
  });

  it("allows reference-typed names and ordinary names", () => {
    for (const k of ["credentialRef", "secretRef", "secretArn", "secretName", "tokenPath", "passwordRef", "kmsKeyArn", "stateKmsKeyArn", "externalId", "roleArn", "accountId", "region", "caData", "workloadIdentityProvider"])
      expect(isSecretKey(k), k).toBe(false);
  });

  it("is deliberately conservative for structured configuration: a name merely containing 'token' is flagged", () => {
    expect(isSecretKey("tokenCount")).toBe(true); // fine in config we own; free-form data uses assertNoSecretValues, which ignores names
  });
});

describe("assertNoSecretKeys (structured configuration)", () => {
  it("refuses secret-named members at any depth, inside arrays too, naming the path and never the value", () => {
    const value = "hunter2-very-secret";
    const bad = { a: { b: [{ ok: 1 }, { password: value }] } };
    const err = (() => {
      try {
        assertNoSecretKeys(bad, "config");
      } catch (e) {
        return e as ControlStoreError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ControlStoreError);
    expect(err?.code).toBe("secret_material");
    expect(err?.message).toContain("config.a.b[1].password");
    expect(JSON.stringify(err)).not.toContain(value);
    expect(err?.message).not.toContain(value);
  });

  it("also refuses secret-shaped values under innocent names", () => {
    for (const [what, value] of SECRET_VALUES) expect(() => assertNoSecretKeys({ note: value }), what).toThrowError(ControlStoreError);
  });

  it("accepts references and plain identifiers", () => {
    expect(() =>
      assertNoSecretKeys({ provider: "kubernetes", credentialRef: "vault:k8s-token", secretArn: "arn:aws:secretsmanager:x", namespaces: ["a"], eks: { clusterName: "c" }, caData: "-----BEGIN CERTIFICATE-----\nMIIB" })
    ).not.toThrow();
    expect(() => assertNoSecretKeys(undefined)).not.toThrow();
    expect(() => assertNoSecretKeys(null)).not.toThrow();
    expect(() => assertNoSecretKeys(42)).not.toThrow();
  });

  it("bounds depth and size instead of recursing without limit", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => assertNoSecretKeys(deep)).toThrowError(/nested too deeply/);
    const wide = Object.fromEntries(Array.from({ length: 25_000 }, (_, i) => [`k${i}`, i]));
    expect(() => assertNoSecretKeys(wide)).toThrowError(/too large/);
  });
});

describe("assertNoSecretValues (free-form data)", () => {
  it.each(SECRET_VALUES)("refuses %s wherever it appears", (_what, value) => {
    expect(() => assertNoSecretValues({ nested: { list: [value] } }, "data")).toThrowError(/data\.nested\.list\[0\]/);
    expect(() => assertNoSecretValues(value)).toThrowError(ControlStoreError);
  });

  it("does not look at key names: a usage counter called tokenCount is not a secret", () => {
    expect(() => assertNoSecretValues({ tokenCount: 12, password: "not-a-shape", secret: "x" })).not.toThrow();
  });

  it.each(BENIGN_VALUES)("accepts %s", (value) => {
    expect(() => assertNoSecretValues({ v: value })).not.toThrow();
  });

  it("scans only a bounded prefix of a huge string and never throws on non-JSON values", () => {
    expect(() => assertNoSecretValues("x".repeat(1_000_000))).not.toThrow();
    expect(() => assertNoSecretValues({ n: 1, b: true, nul: null, u: undefined })).not.toThrow();
  });
});
