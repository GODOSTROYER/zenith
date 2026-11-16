/**
 * PROD-OPS-05: the key registry, purpose refusal, decrypt-only histories and the consumers wired through it.
 * Pure crypto and configuration, no database. Every key is generated at runtime; nothing here is a real secret,
 * and no assertion prints one.
 */
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { generateSigningJwk } from "@/lib/credentials/signing";
import { KeyCustodyError } from "@/lib/keycustody/purposes";
import { KeyRing } from "@/lib/keycustody/registry";
import { assertCustodyAtStartup, custodySeparationErrors } from "@/lib/keycustody/startup";
import { machineResultSealer } from "@/lib/machines/persistence";
import { RunnerConfigError } from "@/lib/runners/types";
import { createAesResultSealer, createResultSealerFromEnv } from "@/lib/runners/seal";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { TemporalPayloadCodec, temporalDataConverterFromEnv } from "@/lib/workflows/codec";

const hex = (): string => randomBytes(32).toString("hex");
const b64url = (): string => randomBytes(32).toString("base64url");
const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (error) { return error instanceof KeyCustodyError ? error.code : `other:${(error as Error).message}`; }
  return undefined;
};

describe("key ids and purpose binding", () => {
  it("one key under two purposes gets two ids and is reported as reuse, without printing the key", () => {
    const shared = hex();
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: shared, ZENITH_PLAN_ARTIFACT_KEY: shared, ZENITH_BACKUP_KEY: shared });
    const vault = ring.descriptors("enc:vault")[0], plan = ring.descriptors("enc:plan-artifacts")[0];
    expect(vault.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(vault.keyId).not.toBe(plan.keyId);
    const reuse = ring.violations().filter((v) => v.code === "key_reused_across_purposes");
    expect(reuse.map((v) => v.purposes.join("+")).sort()).toEqual(["enc:backup+enc:plan-artifacts", "enc:backup+enc:vault", "enc:plan-artifacts+enc:vault"]);
    expect(JSON.stringify(ring.violations())).not.toContain(shared);
    expect(() => ring.assertSeparated()).toThrow(KeyCustodyError);
  });

  it("distinct keys per purpose are clean", () => {
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: hex(), ZENITH_PLAN_ARTIFACT_KEY: hex(), ZENITH_BACKUP_KEY: hex(), ZENITH_RUNNER_RESULT_KEY: b64url() });
    expect(ring.violations().filter((v) => v.severity === "error")).toEqual([]);
    expect(() => ring.assertSeparated()).not.toThrow();
  });

  it("descriptors, errors and inspection never carry key material", () => {
    const vault = hex(), previous = randomBytes(32).toString("base64"), result = b64url();
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: vault, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([previous]), ZENITH_RUNNER_RESULT_KEY: result });
    const shown = [JSON.stringify(ring.descriptors()), inspect(ring, { depth: 6, showHidden: true }), JSON.stringify(ring), JSON.stringify(ring.violations())].join("\n");
    for (const secret of [vault, previous, result, Buffer.from(vault, "hex").toString("base64"), Buffer.from(result, "base64url").toString("hex")]) expect(shown).not.toContain(secret);
    const refused = (() => { try { ring.materialFor("enc:vault", "sign"); } catch (error) { return (error as Error).message; } return ""; })();
    expect(refused).not.toContain(vault);
  });
});

describe("purpose and role refusal", () => {
  it("refuses an operation the purpose never allows", () => {
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: hex() });
    expect(code(() => ring.materialFor("enc:vault", "sign"))).toBe("key_purpose_operation");
    expect(code(() => ring.materialFor("signing:release", "encrypt"))).toBe("key_purpose_operation");
    expect(code(() => ring.materialFor("signing:plugin-publisher", "sign"))).toBe("key_purpose_operation");
    expect(code(() => ring.materialFor("enc:backup", "verify"))).toBe("key_purpose_operation");
    expect(code(() => ring.materialFor("enc:nonsense" as never, "encrypt"))).toBe("key_purpose_unknown");
  });

  it("a ring answers only for the purposes it was built for", () => {
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: hex(), ZENITH_BACKUP_KEY: hex() }, { purposes: ["enc:vault"] });
    expect(code(() => ring.materialFor("enc:backup", "encrypt"))).toBe("key_unavailable");
    expect(ring.descriptors().every((d) => d.purpose === "enc:vault")).toBe(true);
  });

  it("decrypt-only history: only the current key encrypts, old keys decrypt, and a role refusal names no key", () => {
    const current = hex(), old1 = hex(), old2 = randomBytes(32).toString("base64");
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: current, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([old1, old2]) }, { purposes: ["enc:vault"] });
    expect(ring.descriptors().map((d) => d.role)).toEqual(["current", "decrypt_only", "decrypt_only"]);
    expect(ring.materialFor("enc:vault", "encrypt")).toHaveLength(1);
    expect(ring.materialFor("enc:vault", "decrypt")).toHaveLength(3);
    const oldId = ring.descriptors().find((d) => d.role === "decrypt_only")!.keyId;
    expect(code(() => ring.useKey("enc:vault", "encrypt", oldId))).toBe("key_role_operation");
    expect(ring.useKey("enc:vault", "decrypt", oldId).length).toBe(32);
    expect(code(() => ring.useKey("enc:vault", "decrypt", "0".repeat(16)))).toBe("key_unavailable");
  });

  it("a malformed key is held as a per-purpose error, not thrown from construction, and echoes nothing", () => {
    const bad = `not-a-key-${randomBytes(4).toString("hex")}`;
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: bad });
    expect(ring.configurationErrors().map((e) => e.purpose)).toContain("enc:vault");
    expect(code(() => ring.materialFor("enc:vault", "encrypt"))).toBe("key_config_invalid");
    expect(JSON.stringify(ring.configurationErrors())).not.toContain(bad);
  });
});

describe("consumers resolve their keys through the registry", () => {
  it("the vault cipher: round trip, previous keys decrypt (current=false), missing key keeps its message", () => {
    const current = hex(), old = hex();
    const sealedOld = vaultCipherFromEnv({ ZENITH_SECRET_KEY: old }).seal("ws", "vault:a", "value-1");
    const cipher = vaultCipherFromEnv({ ZENITH_SECRET_KEY: current, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([old]) });
    expect(cipher.open("ws", "vault:a", sealedOld)).toEqual({ value: "value-1", current: false });
    expect(cipher.open("ws", "vault:b", cipher.seal("ws", "vault:b", "value-2"))).toEqual({ value: "value-2", current: true });
    expect(() => cipher.open("ws", "vault:other", sealedOld)).toThrow(/cannot be opened with the configured keys/);
    expect(() => vaultCipherFromEnv({})).toThrow("ZENITH_SECRET_KEY must contain 32-byte hex or base64 keys.");
    expect(() => vaultCipherFromEnv({ ZENITH_SECRET_KEY: current, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: "{}" })).toThrow(/JSON array/);
  });

  it("the plan-artifact purpose reads its own variables", () => {
    const key = hex(), previous = hex();
    const old = vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: previous }, { purpose: "enc:plan-artifacts" }).seal("ws", "plan", "raw");
    const now = vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key, ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS: JSON.stringify([previous]) }, { purpose: "enc:plan-artifacts" });
    expect(now.open("ws", "plan", old)).toEqual({ value: "raw", current: false });
    expect(() => vaultCipherFromEnv({ ZENITH_SECRET_KEY: key }, { purpose: "enc:plan-artifacts" })).toThrow();
  });

  it("result sealing: boxes name their key, a previous key is decrypt-only, a dropped key fails closed", () => {
    const k1 = b64url(), k2 = b64url();
    const first = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: k1 });
    const box1 = first.seal("ws|job", { v: 1 });
    expect(typeof box1.kid).toBe("string");
    const rotated = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: k2, ZENITH_RUNNER_RESULT_PREVIOUS_KEYS: JSON.stringify([k1]) });
    expect(rotated.open("ws|job", box1)).toEqual({ v: 1 });
    const box2 = rotated.seal("ws|job", { v: 2 });
    expect(box2.kid).not.toBe(box1.kid);
    // the previous key never seals: a ring holding only k1 as a previous key cannot open box2
    expect(() => first.open("ws|job", box2)).toThrow();
    const dropped = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: k2 });
    expect(() => dropped.open("ws|job", box1)).toThrow();
    expect(dropped.open("ws|job", box2)).toEqual({ v: 2 });
  });

  it("an id-less legacy box still opens, and a box with a tampered key id does not", () => {
    const key = randomBytes(32), next = randomBytes(32);
    const legacy = createAesResultSealer(key).seal("a", "legacy");
    expect("kid" in legacy).toBe(false);
    const rotated = createAesResultSealer(next, { keyId: "new", previous: [{ keyId: "old", key }] });
    expect(rotated.open("a", legacy)).toBe("legacy");
    const sealed = createAesResultSealer(key, { keyId: "old" }).seal("a", "x");
    expect(() => rotated.open("a", { ...sealed, kid: "other" })).toThrow();
    expect(() => rotated.open("b", sealed)).toThrow();
  });

  it("result sealing keeps its refusals, as RunnerConfigError", () => {
    expect(() => createResultSealerFromEnv({})).toThrow(RunnerConfigError);
    expect(() => createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: "short" })).toThrow("ZENITH_RUNNER_RESULT_KEY must be 32 bytes, base64url.");
    expect(() => createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: b64url(), ZENITH_RUNNER_RESULT_PREVIOUS_KEYS: "[\"short\"]" })).toThrow(RunnerConfigError);
  });

  it("the legacy signing-key derivation stays decrypt-only after an explicit result key is set, and is reported", async () => {
    const jwk = JSON.stringify((await generateSigningJwk("EdDSA", { kid: "jobs-1" })).privateJwk);
    const derived = createResultSealerFromEnv({ ZENITH_CONTROL_SIGNING_JWK: jwk });
    const box = derived.seal("ws|job", { secret: "x" });
    const explicit = b64url();
    const migrated = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: explicit, ZENITH_CONTROL_SIGNING_JWK: jwk });
    expect(migrated.open("ws|job", box)).toEqual({ secret: "x" });
    const before = KeyRing.fromEnv({ ZENITH_CONTROL_SIGNING_JWK: jwk }).violations();
    expect(before.find((v) => v.code === "result_key_derived_from_signing_key")).toMatchObject({ severity: "warning", purposes: ["enc:results", "signing:jobs"] });
    const after = KeyRing.fromEnv({ ZENITH_RUNNER_RESULT_KEY: explicit, ZENITH_CONTROL_SIGNING_JWK: jwk });
    expect(after.violations().find((v) => v.code === "result_key_derived_from_signing_key")).toBeUndefined();
    expect(after.descriptors("enc:results").map((d) => d.role)).toEqual(["current", "decrypt_only"]);
  });

  it("machine results: a rotated secret key keeps cached artifacts readable only through the previous roots", () => {
    const old = hex(), next = hex();
    const box = machineResultSealer(old, []).seal("aad", { out: "x" });
    expect(machineResultSealer(next, [old]).open("aad", box)).toEqual({ out: "x" });
    expect(() => machineResultSealer(next, []).open("aad", box)).toThrow();
    expect(() => machineResultSealer("short", [])).toThrow();
  });
});

describe("Temporal payload key", () => {
  it("the registry reports the very id the codec writes into payloads, current and previous", () => {
    const cur = hex(), old = hex();
    const ring = KeyRing.fromEnv({ ZENITH_SECRET_KEY: cur, ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS: JSON.stringify([old]) }, { purposes: ["enc:temporal-payload"] });
    const codec = new TemporalPayloadCodec(cur, [old]);
    const [now, previous] = ring.descriptors();
    expect(now).toMatchObject({ keyId: codec.keyId, role: "current", source: "ZENITH_SECRET_KEY" });
    expect(previous).toMatchObject({ keyId: new TemporalPayloadCodec(old).keyId, role: "decrypt_only" });
  });

  it("a dedicated payload key rotates independently of the vault key", () => {
    const vault = hex(), dedicated = hex();
    const env = { ZENITH_SECRET_KEY: vault, ZENITH_TEMPORAL_PAYLOAD_KEY: dedicated };
    const codec = temporalDataConverterFromEnv(env).payloadCodecs[0];
    expect(codec.keyId).toBe(new TemporalPayloadCodec(dedicated).keyId);
    expect(codec.keyId).not.toBe(new TemporalPayloadCodec(vault).keyId);
    const ring = KeyRing.fromEnv(env, { purposes: ["enc:temporal-payload"] });
    expect(ring.descriptors()[0]).toMatchObject({ keyId: codec.keyId, source: "ZENITH_TEMPORAL_PAYLOAD_KEY", derivation: "direct" });
    expect(ring.violations().find((v) => v.code === "purpose_shares_root_with_vault")).toBeUndefined();
    expect(KeyRing.fromEnv({ ZENITH_SECRET_KEY: vault }).violations().find((v) => v.code === "purpose_shares_root_with_vault")).toMatchObject({ severity: "notice" });
  });
});

describe("signing, verification and offline keys", () => {
  it("control signing keys report the JWS kid; extra public keys are verify-only; a private member in the public list is refused", async () => {
    const active = await generateSigningJwk("EdDSA", { kid: "jobs-2026" });
    const next = await generateSigningJwk("EdDSA", { kid: "jobs-2027" });
    const ring = KeyRing.fromEnv({ ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(active.privateJwk), ZENITH_CONTROL_EXTRA_PUBLIC_JWKS: JSON.stringify([next.publicJwk]) });
    expect(ring.descriptors("signing:jobs").map((d) => [d.keyId, d.role])).toEqual([["jobs-2026", "current"], ["jobs-2027", "verify_only"]]);
    expect(JSON.stringify(ring.descriptors())).not.toContain(active.privateJwk.d);
    const leaky = KeyRing.fromEnv({ ZENITH_CONTROL_EXTRA_PUBLIC_JWKS: JSON.stringify([next.privateJwk]) });
    expect(leaky.configurationErrors().find((e) => e.purpose === "signing:jobs")?.message).toMatch(/private key members/);
  });

  it("plugin publisher and attestation keys are verify-only and never held as material", () => {
    const ring = KeyRing.fromEnv({
      ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify({ acme: [{ keyId: "acme-1", publicKey: randomBytes(32).toString("base64") }] }),
      ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nplaceholder\n-----END PUBLIC KEY-----",
      ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID: "attest-1",
    });
    expect(ring.descriptors("signing:plugin-publisher")).toMatchObject([{ keyId: "acme/acme-1", role: "verify_only" }]);
    expect(ring.descriptors("signing:template-attestation")).toMatchObject([{ keyId: "attest-1", role: "verify_only" }]);
    expect(code(() => ring.materialFor("signing:plugin-publisher", "sign"))).toBe("key_purpose_operation");
    expect(code(() => ring.materialFor("signing:plugin-publisher", "verify"))).toBe("key_unavailable");
  });

  it("a release private key on the control plane is an error; offline is clean", () => {
    expect(custodySeparationErrors({}).length).toBe(0);
    const online = { ZENITH_RELEASE_KEY_FILE: "release.key" };
    expect(custodySeparationErrors(online).map((v) => v.code)).toEqual(["release_private_key_online"]);
    expect(code(() => assertCustodyAtStartup(online))).toBe("key_purpose_violation");
    expect(() => assertCustodyAtStartup({ ZENITH_SECRET_KEY: hex() })).not.toThrow();
  });

  it("startup ignores per-purpose configuration errors (their consumers refuse them) but not key reuse", () => {
    expect(custodySeparationErrors({ ZENITH_SECRET_KEY: "short" })).toEqual([]);
    const shared = hex();
    expect(custodySeparationErrors({ ZENITH_SECRET_KEY: shared, ZENITH_PLAN_ARTIFACT_KEY: shared }).map((v) => v.code)).toEqual(["key_reused_across_purposes"]);
  });
});
