import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getAuditExportSigner } from "@/lib/audit-export/signer";
import { KeyRing } from "@/lib/keycustody/registry";

const key = () => JSON.stringify(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }));
describe("audit export signing purpose", () => {
  it("does not fall back to capability or release keys", () => {
    expect(getAuditExportSigner({ ZENITH_CONTROL_SIGNING_JWK: key() })).toBeUndefined();
  });
  it("loads only an independent audit key and registers its purpose", () => {
    const env = { ZENITH_CONTROL_SIGNING_JWK: key(), ZENITH_AUDIT_EXPORT_SIGNING_JWK: key() };
    expect(getAuditExportSigner(env)?.alg).toBe("EdDSA");
    expect(KeyRing.fromEnv(env).configuredPurposes()).toContain("signing:audit-export");
  });
  it("refuses reused private material even under a different key id", () => {
    const jobs = JSON.parse(key()) as Record<string, unknown>;
    expect(() => getAuditExportSigner({ ZENITH_CONTROL_SIGNING_JWK: JSON.stringify({ ...jobs, kid: "jobs" }), ZENITH_AUDIT_EXPORT_SIGNING_JWK: JSON.stringify({ ...jobs, kid: "audit" }) })).toThrow("independent");
  });
  it("fails closed with fixed guidance for malformed audit material", () => {
    expect(() => getAuditExportSigner({ ZENITH_AUDIT_EXPORT_SIGNING_JWK: "invalid" })).toThrow("audit export signing key is invalid");
  });
});
