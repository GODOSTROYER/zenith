/**
 * Control-plane signing of jobs (docs/platform/RUNNER-PROTOCOL.md sections 1, 4).
 *
 * The key and signer are the credential module's (`LocalJwkSigner`, EdDSA); this file pins what the
 * RUNNER PLANE relies on, against the Go side as ground truth:
 *   - `fixtures/go-jws-vector.json` is a job JWS produced by the Go tests (copied from
 *     go/internal/protocol/testdata at ws-go d133a96). It verifies with the published key, and our
 *     signer, given the same key and payload, produces a token with the same payload bytes, a header
 *     made of exactly `alg`, `kid`, `typ` (the Go decoder refuses any other member), and a signature
 *     that verifies under the same key. (The header member ORDER differs from the Go test's
 *     (`alg,typ,kid` vs `alg,kid,typ`); JWS verification is over the exact bytes of each token, so
 *     order does not matter to either verifier.)
 *   - announced rotation keys, sealing-key derivation, and fail-closed configuration.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LocalJwkSigner } from "@/lib/credentials/signing";
import { announcedNextKeys, controlPlaneKeys } from "@/lib/runners/runtime";
import { createAesResultSealer, createResultSealerFromEnv } from "@/lib/runners/seal";
import { controlKeyOf, signEnvelope, unverifiedClaims, verifyEd25519 } from "@/lib/runners/signing";
import { RunnerConfigError, TYP_JOB, TYP_MACHINE } from "@/lib/runners/types";
import { newSigner } from "./_support";

const vector = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/go-jws-vector.json"), "utf8")) as {
  controlPlanePublicKey: string;
  controlPlaneSeedHex: string;
  kid: string;
  jobToken: string;
};

const segment = (token: string, i: number): string => Buffer.from(token.split(".")[i], "base64url").toString("utf8");
const verifyCompact = (token: string, x: string): boolean => {
  const [h, p, s] = token.split(".");
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
};

function goSigner(): LocalJwkSigner {
  const d = Buffer.from(vector.controlPlaneSeedHex, "hex").toString("base64url");
  return LocalJwkSigner.fromJwk("vector", { kty: "OKP", crv: "Ed25519", d, x: vector.controlPlanePublicKey, kid: vector.kid }, { alg: "EdDSA", kid: vector.kid });
}

describe("Go golden vector", () => {
  it("the Go-produced job token verifies with the published public key", () => {
    expect(verifyCompact(vector.jobToken, vector.controlPlanePublicKey)).toBe(true);
    expect(JSON.parse(segment(vector.jobToken, 0))).toEqual({ alg: "EdDSA", kid: "cp-golden", typ: "zenith-job+jwt" });
  });

  it("our signer reproduces the Go token's payload and signs it verifiably under the same key", async () => {
    const payload = JSON.parse(segment(vector.jobToken, 1)) as object;
    expect(JSON.stringify(payload)).toBe(segment(vector.jobToken, 1)); // key order and escaping survive the round trip
    const token = await signEnvelope(goSigner(), TYP_JOB, payload);
    expect(segment(token, 1)).toBe(segment(vector.jobToken, 1));
    expect(verifyCompact(token, vector.controlPlanePublicKey)).toBe(true);
  });

  it("our header has exactly alg, kid and typ — the only members the Go decoder accepts", async () => {
    const header = JSON.parse(segment(await signEnvelope(goSigner(), TYP_JOB, { a: 1 }), 0)) as Record<string, unknown>;
    expect(Object.keys(header).sort()).toEqual(["alg", "kid", "typ"]);
    expect(header).toEqual({ alg: "EdDSA", kid: "cp-golden", typ: "zenith-job+jwt" });
  });
});

describe("signing envelopes", () => {
  it("signs jobs and machine requests with their own typ, verifiable with the published key", async () => {
    const signer = await newSigner("cp-a");
    const key = controlKeyOf(signer.publicJwk());
    for (const typ of [TYP_JOB, TYP_MACHINE] as const) {
      const token = await signEnvelope(signer, typ, { hello: "world" });
      expect(JSON.parse(segment(token, 0))).toMatchObject({ alg: "EdDSA", kid: "cp-a", typ });
      expect(verifyCompact(token, key.publicKey)).toBe(true);
      expect(unverifiedClaims(token)).toEqual({ hello: "world" });
    }
  });

  it("a token signed by another key does not verify under the published one", async () => {
    const a = await newSigner("cp-a");
    const impostor = await newSigner("cp-a");
    expect(verifyCompact(await signEnvelope(impostor, TYP_JOB, { a: 1 }), controlKeyOf(a.publicJwk()).publicKey)).toBe(false);
  });

  it("refuses a non-EdDSA signer", async () => {
    const rsa = { kid: "k", alg: "RS256", publicJwk: () => ({}), sign: async () => "" } as unknown as Parameters<typeof signEnvelope>[0];
    expect(() => signEnvelope(rsa, TYP_JOB, {})).toThrow(/EdDSA/);
  });

  it("unverifiedClaims reads claims without trusting them", async () => {
    const token = await signEnvelope(await newSigner(), TYP_JOB, { jti: "job_1" });
    expect(unverifiedClaims(token)).toEqual({ jti: "job_1" });
    expect(unverifiedClaims("x.y")).toBeUndefined();
    expect(unverifiedClaims("a.!!!.c")).toBeUndefined();
  });

  it("verifyEd25519 is false for malformed keys and signatures instead of throwing", () => {
    expect(verifyEd25519("short", new Uint8Array(3), new Uint8Array(64))).toBe(false);
    expect(verifyEd25519(vector.controlPlanePublicKey, new Uint8Array(3), new Uint8Array(10))).toBe(false);
    expect(verifyEd25519(vector.controlPlanePublicKey, new Uint8Array(3), new Uint8Array(64))).toBe(false);
  });
});

describe("pinned and announced keys", () => {
  it("registration pins the active key only; every other verification key is announced as next", async () => {
    const active = await newSigner("cp-now");
    const next = await newSigner("cp-next");
    const rt = { signer: active, verificationKeys: async () => [active.publicJwk(), next.publicJwk()] };
    expect(controlPlaneKeys(rt).map((k) => k.kid)).toEqual(["cp-now"]);
    expect((await announcedNextKeys(rt)).map((k) => k.kid)).toEqual(["cp-next"]);
    expect(await announcedNextKeys({ signer: active, verificationKeys: async () => [active.publicJwk()] })).toEqual([]);
  });

  it("the published key material never contains the private scalar", async () => {
    const key = await (await import("@/lib/credentials/signing")).generateSigningJwk("EdDSA", { kid: "cp-x" });
    const signer = LocalJwkSigner.fromJwk("t", key.privateJwk, { alg: "EdDSA", kid: "cp-x" });
    expect(JSON.stringify(controlPlaneKeys({ signer }))).not.toContain(key.privateJwk.d);
  });
});

describe("result sealing key", () => {
  it("derives a stable key from the local signing JWK and seals/opens under it", async () => {
    const key = await (await import("@/lib/credentials/signing")).generateSigningJwk("EdDSA", { kid: "cp-x" });
    const env = { ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(key.privateJwk) };
    const a = createResultSealerFromEnv(env);
    const b = createResultSealerFromEnv(env);
    expect(b.open("ws|job", a.seal("ws|job", { secret: "x" }))).toEqual({ secret: "x" });
  });

  it("prefers an explicit ZENITH_RUNNER_RESULT_KEY, which a different JWK cannot open", async () => {
    const gen = (await import("@/lib/credentials/signing")).generateSigningJwk;
    const k1 = (await gen("EdDSA", { kid: "a" })).privateJwk;
    const k2 = (await gen("EdDSA", { kid: "b" })).privateJwk;
    const explicit = Buffer.alloc(32, 7).toString("base64url");
    const s1 = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: explicit, ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(k1) });
    const s2 = createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: explicit, ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(k2) });
    expect(s2.open("x", s1.seal("x", 1))).toBe(1);
  });

  it("fails closed with neither a result key nor a local signing key, and on a malformed key", () => {
    expect(() => createResultSealerFromEnv({})).toThrow(RunnerConfigError);
    expect(() => createResultSealerFromEnv({ ZENITH_RUNNER_RESULT_KEY: "short" })).toThrow(RunnerConfigError);
    expect(() => createResultSealerFromEnv({ ZENITH_CONTROL_SIGNING_JWK: "{not json" })).toThrow(RunnerConfigError);
    expect(() => createResultSealerFromEnv({ ZENITH_CONTROL_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/x" })).toThrow(RunnerConfigError);
  });

  it("a sealed box is bound to its context and tamper-evident", () => {
    const sealer = createAesResultSealer(Buffer.alloc(32, 1));
    const box = sealer.seal("w-a|job_1", { planJson: { secret: "hunter2-secret-value" } });
    expect(JSON.stringify(box)).not.toContain("hunter2");
    expect(sealer.open("w-a|job_1", box)).toEqual({ planJson: { secret: "hunter2-secret-value" } });
    expect(() => sealer.open("w-b|job_1", box)).toThrow(); // moved to another tenant's job
    expect(() => sealer.open("w-a|job_2", box)).toThrow(); // moved to another job
    expect(() => sealer.open("w-a|job_1", { ...box, ct: Buffer.from("tampered").toString("base64url") })).toThrow();
    expect(() => createAesResultSealer(Buffer.alloc(32, 2)).open("w-a|job_1", box)).toThrow(); // another key
    expect(() => sealer.open("x", { not: "a box" })).toThrow();
  });
});
