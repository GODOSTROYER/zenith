import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { GrantVerificationError, type GrantErrorCode } from "@/lib/credentials/errors";
import { signCapabilityGrant, verifyCapabilityGrant, GRANT_TYP } from "@/lib/credentials/grants";
import { LocalJwkSigner, generateSigningJwk, serializePrivateJwk } from "@/lib/credentials/signing";
import type { PublicJwk } from "@/lib/credentials/signing";
import { grant, makeKeys, nowSec, type Keys } from "./helpers";

let keys: Keys;
let signer: LocalJwkSigner;
let pinned: PublicJwk[];

beforeAll(async () => {
  keys = await makeKeys();
  signer = LocalJwkSigner.fromJwk("T", keys.ed.privateJwk, { alg: "EdDSA" });
  pinned = [keys.ed.publicJwk];
});

const opts = (over: Record<string, unknown> = {}) => ({ audience: "worker", keys: pinned, ...over });

async function expectCode(p: Promise<unknown>, code: GrantErrorCode) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(GrantVerificationError);
  expect((err as GrantVerificationError).code).toBe(code);
  return err as GrantVerificationError;
}

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const forge = (header: Record<string, unknown>, payload: object, sig = "AAAA") => `${b64u(header)}.${b64u(payload)}.${sig}`;

describe("signCapabilityGrant / verifyCapabilityGrant", () => {
  it("round-trips claims and signs with typ zenith-grant+jwt", async () => {
    const claims = grant({ proj: "p1", res: "r1", fence: 7, constraints: { maxLines: 500 } });
    const jws = await signCapabilityGrant(claims, { signer });
    const header = JSON.parse(Buffer.from(jws.split(".")[0], "base64url").toString());
    expect(header).toEqual({ alg: "EdDSA", typ: GRANT_TYP, kid: keys.ed.kid });
    expect(await verifyCapabilityGrant(jws, opts())).toEqual(claims);
  });

  it("loads the control key and pinned keys from the environment", async () => {
    const env = { ZENITH_CONTROL_SIGNING_JWK: serializePrivateJwk(keys.ed) };
    const jws = await signCapabilityGrant(grant(), { env });
    expect((await verifyCapabilityGrant(jws, { audience: "worker", env })).ws).toBe("ws_1");
    await expectCode(verifyCapabilityGrant(jws, { audience: "worker", env: {} }), "grant_no_keys");
  });

  it("refuses to sign malformed claims or over-long lifetimes", async () => {
    await expectCode(signCapabilityGrant({ ...grant(), ws: "" }, { signer }), "grant_bad_claims");
    const iat = nowSec();
    await expectCode(signCapabilityGrant(grant({ iat, exp: iat + 3601 }), { signer }), "grant_lifetime_invalid");
    await expectCode(signCapabilityGrant(grant({ iat, exp: iat }), { signer }), "grant_lifetime_invalid");
  });

  it("refuses to sign with a non-EdDSA signer", async () => {
    const rs = LocalJwkSigner.fromJwk("T", keys.rsa.privateJwk, { alg: "RS256" });
    await expectCode(signCapabilityGrant(grant(), { signer: rs }), "grant_bad_header");
  });

  it("rejects an expired grant strictly (no tolerance on exp)", async () => {
    const iat = nowSec() - 120;
    const jws = await signCapabilityGrant(grant({ iat, exp: iat + 60 }), { signer });
    await expectCode(verifyCapabilityGrant(jws, opts()), "grant_expired");
    const exp = nowSec() + 10;
    const live = await signCapabilityGrant(grant({ iat: nowSec(), exp }), { signer });
    await expect(verifyCapabilityGrant(live, opts())).resolves.toBeTruthy();
    // exactly at exp is expired
    await expectCode(verifyCapabilityGrant(live, opts({ now: new Date(exp * 1000) })), "grant_expired");
    await expect(verifyCapabilityGrant(live, opts({ now: new Date((exp - 1) * 1000) }))).resolves.toBeTruthy();
  });

  it("allows 60 s of iat skew and no more", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const base = now.getTime() / 1000;
    const near = await signCapabilityGrant(grant({ iat: base + 60, exp: base + 600 }), { signer });
    await expect(verifyCapabilityGrant(near, opts({ now }))).resolves.toBeTruthy();
    const far = await signCapabilityGrant(grant({ iat: base + 61, exp: base + 600 }), { signer });
    await expectCode(verifyCapabilityGrant(far, opts({ now })), "grant_not_yet_valid");
  });

  it("enforces audience, capability and operation bindings", async () => {
    const jws = await signCapabilityGrant(grant({ aud: "runner:run_1", cap: "logs.read", op: "op_x" }), { signer });
    await expectCode(verifyCapabilityGrant(jws, opts()), "grant_wrong_audience");
    const o = { audience: "runner:run_1", keys: pinned };
    await expectCode(verifyCapabilityGrant(jws, { ...o, expectedCapability: "infrastructure.apply" }), "grant_wrong_capability");
    await expectCode(verifyCapabilityGrant(jws, { ...o, expectedOperationId: "op_y" }), "grant_wrong_operation");
    await expect(verifyCapabilityGrant(jws, { ...o, expectedCapability: "logs.read", expectedOperationId: "op_x" })).resolves.toBeTruthy();
  });

  it("consults the revocation / single-use hook", async () => {
    const jws = await signCapabilityGrant(grant({ jti: "used_once" }), { signer });
    const seen: string[] = [];
    await expectCode(
      verifyCapabilityGrant(jws, opts({ isRevoked: async (jti: string) => (seen.push(jti), true) })),
      "grant_revoked"
    );
    expect(seen).toEqual(["used_once"]);
    await expect(verifyCapabilityGrant(jws, opts({ isRevoked: () => false }))).resolves.toBeTruthy();
  });

  it("rejects a tampered payload, a foreign key and an unpinned kid", async () => {
    const jws = await signCapabilityGrant(grant(), { signer });
    const [h, , s] = jws.split(".");
    const tampered = `${h}.${b64u({ ...grant(), ws: "ws_other" })}.${s}`;
    await expectCode(verifyCapabilityGrant(tampered, opts()), "grant_bad_signature");

    const other = LocalJwkSigner.fromJwk("T", (await generateSigningJwk("EdDSA", { kid: keys.ed.kid })).privateJwk, { alg: "EdDSA" });
    const foreign = await signCapabilityGrant(grant(), { signer: other });
    await expectCode(verifyCapabilityGrant(foreign, opts()), "grant_bad_signature");

    const rotated = LocalJwkSigner.fromJwk("T", (await generateSigningJwk("EdDSA", { kid: "not-pinned" })).privateJwk, { alg: "EdDSA" });
    await expectCode(verifyCapabilityGrant(await signCapabilityGrant(grant(), { signer: rotated }), opts()), "grant_unknown_key");
  });

  it("accepts a rotated key once it is pinned", async () => {
    const next = await generateSigningJwk("EdDSA");
    const s = LocalJwkSigner.fromJwk("T", next.privateJwk, { alg: "EdDSA" });
    const jws = await signCapabilityGrant(grant(), { signer: s });
    await expect(verifyCapabilityGrant(jws, opts({ keys: [keys.ed.publicJwk, next.publicJwk] }))).resolves.toBeTruthy();
  });

  it("rejects alg confusion: none, HS256 keyed with the public key, and RS256 headers", async () => {
    const claims = grant();
    await expectCode(verifyCapabilityGrant(forge({ alg: "none", typ: GRANT_TYP, kid: keys.ed.kid }, claims, "AAAA"), opts()), "grant_bad_header");
    const hs = `${b64u({ alg: "HS256", typ: GRANT_TYP, kid: keys.ed.kid })}.${b64u(claims)}`;
    const mac = createHmac("sha256", keys.ed.publicJwk.x!).update(hs).digest("base64url");
    await expectCode(verifyCapabilityGrant(`${hs}.${mac}`, opts()), "grant_bad_header");
    await expectCode(verifyCapabilityGrant(forge({ alg: "RS256", typ: GRANT_TYP, kid: keys.ed.kid }, claims), opts()), "grant_bad_header");
  });

  it("rejects wrong typ, missing kid, and embedded-key headers", async () => {
    const claims = grant();
    await expectCode(verifyCapabilityGrant(forge({ alg: "EdDSA", typ: "JWT", kid: keys.ed.kid }, claims), opts()), "grant_bad_header");
    await expectCode(verifyCapabilityGrant(forge({ alg: "EdDSA", typ: GRANT_TYP }, claims), opts()), "grant_bad_header");
    await expectCode(
      verifyCapabilityGrant(forge({ alg: "EdDSA", typ: GRANT_TYP, kid: keys.ed.kid, jwk: keys.ed.publicJwk }, claims), opts()),
      "grant_bad_header"
    );
    await expectCode(
      verifyCapabilityGrant(forge({ alg: "EdDSA", typ: GRANT_TYP, kid: keys.ed.kid, jku: "https://evil.example/jwks" }, claims), opts()),
      "grant_bad_header"
    );
  });

  it("rejects malformed tokens without echoing them", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "not a jwt", "....", "a.b.c!", "x".repeat(20000)]) {
      const err = await expectCode(verifyCapabilityGrant(bad, opts()), "grant_malformed");
      if (bad.length > 0 && bad.length < 100) expect(err.message).not.toContain(bad);
    }
    await expectCode(verifyCapabilityGrant(undefined as never, opts()), "grant_malformed");
  });

  it("rejects a validly signed but structurally wrong payload", async () => {
    const jws = await signer.sign({ typ: GRANT_TYP }, { jti: "x", aud: "worker" });
    await expectCode(verifyCapabilityGrant(jws, opts()), "grant_bad_claims");
    const long = await signer.sign({ typ: GRANT_TYP }, { ...grant(), iat: nowSec(), exp: nowSec() + 7200 });
    await expectCode(verifyCapabilityGrant(long, opts()), "grant_lifetime_invalid");
    const issuer = await signCapabilityGrant(grant({ iss: "someone-else" }), { signer });
    await expectCode(verifyCapabilityGrant(issuer, opts({ issuer: "zenith-control" })), "grant_bad_claims");
  });
});
