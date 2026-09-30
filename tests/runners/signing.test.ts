/**
 * Control-plane JWS signing (docs/platform/RUNNER-PROTOCOL.md sections 1, 4).
 *
 * Ground truth is the Go side: `fixtures/go-jws-vector.json` is a job JWS produced by the Go
 * tests (copied from go/internal/protocol/testdata at ws-go d133a96). Ed25519 is deterministic,
 * so this signer, given the same key, header order and payload bytes, must reproduce the Go
 * token BYTE FOR BYTE — that pins the header serialization, the payload encoding and the
 * signature encoding against the verifier the agents actually run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createControlSignerFromEnv,
  createControlSignerFromJwk,
  generateControlSigningJwk,
  jwsFinish,
  jwsSigningInput,
  JwsError,
  unverifiedClaims,
  verifyControlJws,
} from "@/lib/runners/signing";
import { RunnerConfigError, TYP_GRANT, TYP_JOB, TYP_MACHINE } from "@/lib/runners/types";

const vector = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/go-jws-vector.json"), "utf8")) as {
  controlPlanePublicKey: string;
  controlPlaneSeedHex: string;
  kid: string;
  jobToken: string;
  jobPayload: { grant: string };
};

const b64uSeed = Buffer.from(vector.controlPlaneSeedHex, "hex").toString("base64url");
const goSigner = () => createControlSignerFromJwk({ kty: "OKP", crv: "Ed25519", d: b64uSeed, x: vector.controlPlanePublicKey, kid: vector.kid });
const segment = (token: string, i: number): string => Buffer.from(token.split(".")[i], "base64url").toString("utf8");

describe("Go golden vector", () => {
  it("verifies the Go-produced job token with the published public key", () => {
    const v = verifyControlJws(vector.jobToken, TYP_JOB, [{ kid: vector.kid, publicKey: vector.controlPlanePublicKey }]);
    expect(v.header).toEqual({ alg: "EdDSA", kid: "cp-golden", typ: "zenith-job+jwt" });
    expect(v.payload.jti).toBe("job_golden");
    expect(v.payload.runnerId).toBe("run_golden");
  });

  it("reproduces the Go job token byte for byte from the same seed, header and payload", async () => {
    const payload = JSON.parse(segment(vector.jobToken, 1)) as object;
    expect(JSON.stringify(payload)).toBe(segment(vector.jobToken, 1)); // key order and escaping survive the round trip
    expect(await goSigner().sign(TYP_JOB, payload)).toBe(vector.jobToken);
  });

  it("reproduces the embedded Go grant byte for byte too (typ zenith-grant+jwt)", async () => {
    const grant = vector.jobPayload.grant;
    expect(await goSigner().sign(TYP_GRANT, JSON.parse(segment(grant, 1)) as object)).toBe(grant);
    expect(verifyControlJws(grant, TYP_GRANT, [{ kid: vector.kid, publicKey: vector.controlPlanePublicKey }]).payload.cap).toBe("infrastructure.plan");
  });

  it("the KMS helpers (signing input + finish) produce the same token as the JWK signer", () => {
    const payload = JSON.parse(segment(vector.jobToken, 1)) as object;
    const input = jwsSigningInput(TYP_JOB, vector.kid, payload);
    // a stand-in for a KMS Sign call: the signature is the last segment of the known-good token
    const sig = Buffer.from(vector.jobToken.split(".")[2], "base64url");
    expect(jwsFinish(input, sig)).toBe(vector.jobToken);
    expect(() => jwsFinish(input, new Uint8Array(10))).toThrow(/64 bytes/);
  });
});

describe("signing", () => {
  const signer = createControlSignerFromJwk(generateControlSigningJwk("cp-a"));
  const keys = signer.publicKeys();

  it("emits exactly {alg, kid, typ} in that order, for each typ", async () => {
    for (const typ of [TYP_JOB, TYP_MACHINE, TYP_GRANT] as const) {
      const token = await signer.sign(typ, { hello: "world" });
      expect(segment(token, 0)).toBe(JSON.stringify({ alg: "EdDSA", kid: "cp-a", typ }));
      expect(verifyControlJws(token, typ, keys).payload).toEqual({ hello: "world" });
    }
  });

  it("refuses a wrong typ, an unknown kid, a tampered payload and a tampered signature", async () => {
    const token = await signer.sign(TYP_JOB, { a: 1 });
    expect(() => verifyControlJws(token, TYP_MACHINE, keys)).toThrowError(expect.objectContaining({ code: "bad_typ" }));
    expect(() => verifyControlJws(token, TYP_JOB, [{ kid: "cp-other", publicKey: keys[0].publicKey }])).toThrowError(expect.objectContaining({ code: "unknown_key" }));
    const [h, p, s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${s}`;
    expect(() => verifyControlJws(forged, TYP_JOB, keys)).toThrowError(expect.objectContaining({ code: "bad_signature" }));
    const badSig = `${h}.${p}.${Buffer.alloc(64).toString("base64url")}`;
    expect(() => verifyControlJws(badSig, TYP_JOB, keys)).toThrow(JwsError);
  });

  it("refuses a token signed by another key even when the kid matches", async () => {
    const impostor = createControlSignerFromJwk(generateControlSigningJwk("cp-a"));
    const token = await impostor.sign(TYP_JOB, { a: 1 });
    expect(() => verifyControlJws(token, TYP_JOB, keys)).toThrowError(expect.objectContaining({ code: "bad_signature" }));
  });

  it("refuses alg none / extra header members / non-object payloads / malformed input", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const sig = Buffer.alloc(64).toString("base64url");
    expect(() => verifyControlJws(`${enc({ alg: "none", kid: "cp-a", typ: TYP_JOB })}.${enc({})}.${sig}`, TYP_JOB, keys)).toThrowError(expect.objectContaining({ code: "bad_header" }));
    expect(() => verifyControlJws(`${enc({ alg: "EdDSA", kid: "cp-a", typ: TYP_JOB, crit: ["b64"] })}.${enc({})}.${sig}`, TYP_JOB, keys)).toThrowError(expect.objectContaining({ code: "bad_header" }));
    expect(() => verifyControlJws("a.b", TYP_JOB, keys)).toThrowError(expect.objectContaining({ code: "malformed" }));
    expect(() => verifyControlJws("a.b.c.d", TYP_JOB, keys)).toThrow(JwsError);
  });

  it("derives a stable kid from the key when none is given", () => {
    const { kid: _kid, ...bare } = generateControlSigningJwk("ignored");
    const a = createControlSignerFromJwk(bare);
    expect(a.kid).toMatch(/^cp-[A-Za-z0-9_-]{12}$/);
    expect(createControlSignerFromJwk(bare).kid).toBe(a.kid);
  });

  it("rejects a JWK whose public half does not match its private half, and non-Ed25519 keys", () => {
    const a = generateControlSigningJwk("cp-a");
    const b = generateControlSigningJwk("cp-b");
    expect(() => createControlSignerFromJwk({ ...a, x: b.x })).toThrow(RunnerConfigError);
    expect(() => createControlSignerFromJwk({ kty: "RSA" })).toThrow(RunnerConfigError);
    expect(() => createControlSignerFromJwk({ ...a, d: undefined })).toThrow(RunnerConfigError);
  });

  it("announces rotation keys separately from the active key", () => {
    const next = generateControlSigningJwk("cp-next");
    const s = createControlSignerFromJwk(generateControlSigningJwk("cp-now"), { nextKeys: [{ kid: "cp-next", publicKey: next.x }] });
    expect(s.publicKeys().map((k) => k.kid)).toEqual(["cp-now"]);
    expect(s.nextKeys()).toEqual([{ kid: "cp-next", publicKey: next.x }]);
    expect(() => createControlSignerFromJwk(generateControlSigningJwk("cp-now"), { nextKeys: [{ kid: "cp-now", publicKey: next.x }] })).toThrow(RunnerConfigError);
  });

  it("reads ZENITH_CONTROL_SIGNING_JWK, _KID and _NEXT_KEYS from the environment and fails closed without a key", () => {
    const jwk = generateControlSigningJwk("cp-env");
    const next = generateControlSigningJwk("n");
    const s = createControlSignerFromEnv({ ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(jwk), ZENITH_CONTROL_SIGNING_KID: "cp-renamed", ZENITH_CONTROL_NEXT_KEYS: JSON.stringify([{ kid: "cp-2", publicKey: next.x }]) });
    expect(s.kid).toBe("cp-renamed");
    expect(s.nextKeys()).toHaveLength(1);
    expect(() => createControlSignerFromEnv({})).toThrow(RunnerConfigError);
    expect(() => createControlSignerFromEnv({ ZENITH_CONTROL_SIGNING_JWK: "{not json" })).toThrow(RunnerConfigError);
    expect(() => createControlSignerFromEnv({ ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(jwk), ZENITH_CONTROL_NEXT_KEYS: "nope" })).toThrow(RunnerConfigError);
  });

  it("never exposes private key material through the signer's surface", () => {
    const jwk = generateControlSigningJwk("cp-a");
    const s = createControlSignerFromJwk(jwk);
    expect(JSON.stringify({ kid: s.kid, pub: s.publicKeys(), next: s.nextKeys() })).not.toContain(jwk.d);
  });

  it("unverifiedClaims reads claims without trusting them", async () => {
    const token = await signer.sign(TYP_JOB, { jti: "job_1" });
    expect(unverifiedClaims(token)).toEqual({ jti: "job_1" });
    expect(unverifiedClaims("x.y")).toBeUndefined();
  });
});
