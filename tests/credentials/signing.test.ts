import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { mockClient } from "aws-sdk-client-mock";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CredentialConfigError, SigningError } from "@/lib/credentials/errors";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import {
  KmsSigner,
  LocalJwkSigner,
  derEcdsaToJose,
  generateSigningJwk,
  getControlSigner,
  getOidcPublicJwks,
  getOidcSigner,
  jwkThumbprint,
  parseExtraPublicJwks,
  resetSignerCache,
  serializePrivateJwk,
} from "@/lib/credentials/signing";
import { SecretString } from "@/lib/credentials/secret";
import { assertNoCredentialLeak } from "@/lib/credentials/redact";
import { makeKeys, type Keys } from "./helpers";

let keys: Keys;
beforeAll(async () => {
  keys = await makeKeys();
});
afterEach(() => resetSignerCache());

async function verifyWith(jws: string, publicJwk: unknown) {
  const key = await importJWK(publicJwk as never);
  return compactVerify(jws, key);
}

describe("generateSigningJwk", () => {
  it("emits kid/alg/use on both halves, a thumbprint kid, and a public half without private members", async () => {
    for (const alg of ["RS256", "EdDSA", "ES256"] as const) {
      const k = await generateSigningJwk(alg);
      expect(k.privateJwk.d).toBeTruthy();
      expect(k.privateJwk.kid).toBe(k.kid);
      expect(k.publicJwk).toMatchObject({ kid: k.kid, alg, use: "sig" });
      for (const m of ["d", "p", "q", "dp", "dq", "qi"]) expect(k.publicJwk).not.toHaveProperty(m);
      expect(k.kid).toBe(jwkThumbprint(k.publicJwk));
    }
  });

  it("honours an explicit kid", async () => {
    const k = await generateSigningJwk("EdDSA", { kid: "cp-2026-09" });
    expect(k.kid).toBe("cp-2026-09");
    expect(k.publicJwk.kid).toBe("cp-2026-09");
  });
});

describe("LocalJwkSigner", () => {
  it("signs RS256 tokens that verify against the published JWK and carry alg/kid/typ", async () => {
    const signer = LocalJwkSigner.fromJwk("TEST", keys.rsa.privateJwk, { alg: "RS256" });
    const jws = await signer.sign({ typ: "JWT" }, { sub: "x", iat: 1 });
    expect(decodeProtectedHeader(jws)).toEqual({ alg: "RS256", typ: "JWT", kid: keys.rsa.kid });
    const { payload } = await verifyWith(jws, signer.publicJwk());
    expect(JSON.parse(Buffer.from(payload).toString())).toEqual({ sub: "x", iat: 1 });
  });

  it("signs EdDSA and ES256", async () => {
    const ed = LocalJwkSigner.fromJwk("TEST", keys.ed.privateJwk, { alg: "EdDSA" });
    await verifyWith(await ed.sign({ typ: "zenith-grant+jwt" }, { a: 1 }), ed.publicJwk());
    const es = await generateSigningJwk("ES256");
    const s = LocalJwkSigner.fromJwk("TEST", es.privateJwk, { alg: "ES256" });
    await verifyWith(await s.sign({}, { a: 1 }), s.publicJwk());
  });

  it("refuses a header that names a different alg or kid", async () => {
    const signer = LocalJwkSigner.fromJwk("TEST", keys.ed.privateJwk, { alg: "EdDSA" });
    await expect(signer.sign({ alg: "none" }, {})).rejects.toThrow(SigningError);
    await expect(signer.sign({ kid: "other" }, {})).rejects.toThrow(SigningError);
  });

  it("rejects a key of the wrong type, naming the variable but never the key", () => {
    let err: unknown;
    try {
      LocalJwkSigner.fromJwk("ZENITH_OIDC_SIGNING_JWK", keys.ed.privateJwk, { alg: "RS256" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialConfigError);
    expect((err as Error).message).toContain("ZENITH_OIDC_SIGNING_JWK");
    expect((err as Error).message).not.toContain(keys.ed.privateJwk.d);
    assertNoCredentialLeak(err, { secrets: [keys.ed.privateJwk.d, keys.ed.privateJwk.x] });
  });

  it("rejects a public-only JWK and garbage without echoing the input", () => {
    expect(() => LocalJwkSigner.fromJwk("V", { ...keys.rsa.publicJwk }, { alg: "RS256" })).toThrow(/private/);
    const secret = new SecretString("{not json but SUPERSECRETTEXT");
    try {
      LocalJwkSigner.fromSecret("ZENITH_CONTROL_SIGNING_JWK", secret, { alg: "EdDSA" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("ZENITH_CONTROL_SIGNING_JWK");
      expect((e as Error).message).not.toContain("SUPERSECRETTEXT");
    }
  });

  it("rejects an RSA key smaller than 2048 bits", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
    expect(() => LocalJwkSigner.fromJwk("V", jwk, { alg: "RS256" })).toThrow(/2048/);
  });

  it("accepts base64-encoded JSON, and never serialises private material", async () => {
    const b64 = Buffer.from(serializePrivateJwk(keys.rsa)).toString("base64");
    const signer = LocalJwkSigner.fromSecret("V", new SecretString(b64), { alg: "RS256" });
    expect(signer.kid).toBe(keys.rsa.kid);
    assertNoCredentialLeak(signer, { secrets: [keys.rsa.privateJwk.d, keys.rsa.privateJwk.p, keys.rsa.privateJwk.q] });
    expect(JSON.stringify(signer)).toBe(JSON.stringify({ kid: keys.rsa.kid, alg: "RS256" }));
  });
});

describe("configuration", () => {
  it("wraps secrets so accidental serialisation prints [redacted]", () => {
    const config = loadCredentialsConfig({ ZENITH_OIDC_SIGNING_JWK: serializePrivateJwk(keys.rsa) });
    expect(JSON.stringify(config)).not.toContain(keys.rsa.privateJwk.d);
    expect(`${config.oidcSigningJwk}`).toBe("[redacted]");
  });

  it("refuses two OIDC signers at once and bad issuers, naming the variable", () => {
    expect(() =>
      loadCredentialsConfig({ ZENITH_OIDC_SIGNING_JWK: "{}", ZENITH_OIDC_KMS_KEY_ID: "alias/x" })
    ).toThrow(/ZENITH_OIDC_SIGNING_JWK.*exactly one/);
    expect(() => loadCredentialsConfig({ ZENITH_OIDC_ISSUER: "http://zenith.example.com" })).toThrow(/ZENITH_OIDC_ISSUER/);
    expect(() => loadCredentialsConfig({ ZENITH_OIDC_ISSUER: "https://u:p@zenith.example.com" })).toThrow(/credentials/);
    expect(loadCredentialsConfig({ ZENITH_OIDC_ISSUER: "https://zenith.example.com/api/oidc/" }).oidcIssuer).toBe(
      "https://zenith.example.com/api/oidc"
    );
    expect(loadCredentialsConfig({ ZENITH_OIDC_ISSUER: "http://localhost:3400/api/oidc" }).oidcIssuer).toBe(
      "http://localhost:3400/api/oidc"
    );
  });

  it("loads OIDC (RS256) and control (EdDSA) signers from their own variables and memoises them", async () => {
    const env = {
      ZENITH_OIDC_SIGNING_JWK: serializePrivateJwk(keys.rsa),
      ZENITH_CONTROL_SIGNING_JWK: serializePrivateJwk(keys.ed),
    };
    const oidc = await getOidcSigner(env);
    const control = await getControlSigner(env);
    expect(oidc?.alg).toBe("RS256");
    expect(control?.alg).toBe("EdDSA");
    expect(await getOidcSigner(env)).toBe(oidc);
    expect(await getOidcSigner({})).toBeUndefined();
  });

  it("does not let the control key be loaded as the OIDC key (algorithm mismatch)", async () => {
    await expect(getOidcSigner({ ZENITH_OIDC_SIGNING_JWK: serializePrivateJwk(keys.ed) })).rejects.toThrow(
      /ZENITH_OIDC_SIGNING_JWK/
    );
  });

  it("publishes current + extra public keys and refuses a private key in the extras", async () => {
    const next = await generateSigningJwk("RS256");
    const env = {
      ZENITH_OIDC_SIGNING_JWK: serializePrivateJwk(keys.rsa),
      ZENITH_OIDC_EXTRA_PUBLIC_JWKS: JSON.stringify({ keys: [next.publicJwk] }),
    };
    const jwks = await getOidcPublicJwks(env);
    expect(jwks?.map((k) => k.kid)).toEqual([keys.rsa.kid, next.kid]);
    expect(() => parseExtraPublicJwks("oidc", JSON.stringify({ keys: [next.privateJwk] }))).toThrow(/private/);
    expect(() => parseExtraPublicJwks("control", JSON.stringify([keys.rsa.publicJwk]))).toThrow(/EdDSA/);
  });
});

describe("derEcdsaToJose", () => {
  it("converts DER signatures (including short r/s with leading zero padding) to fixed-width r||s", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    for (let i = 0; i < 25; i++) {
      const data = Buffer.from(`message ${i}`);
      const der = nodeSign("sha256", data, { key: privateKey, dsaEncoding: "der" });
      const raw = derEcdsaToJose(der);
      expect(raw.length).toBe(64);
      expect(nodeVerify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
    }
  });

  it("rejects malformed DER", () => {
    expect(() => derEcdsaToJose(Buffer.from([0x30, 0x02, 0x02, 0x00]))).toThrow(SigningError);
    expect(() => derEcdsaToJose(Buffer.from([0x31, 0x00]))).toThrow(SigningError);
  });
});

/** A KMS stand-in: answers GetPublicKey/Sign with a real local key pair. */
function fakeKms(kind: "RS256" | "ES256" | "EdDSA", options: { corruptSignature?: boolean; keySpec?: string } = {}) {
  const pair =
    kind === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : kind === "ES256"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const mock = mockClient(KMSClient);
  mock.on(GetPublicKeyCommand).resolves({
    PublicKey: new Uint8Array(spki),
    KeyUsage: "SIGN_VERIFY",
    KeySpec: (options.keySpec ?? { RS256: "RSA_2048", ES256: "ECC_NIST_P256", EdDSA: "ECC_NIST_EDWARDS25519" }[kind]) as never,
    SigningAlgorithms: [{ RS256: "RSASSA_PKCS1_V1_5_SHA_256", ES256: "ECDSA_SHA_256", EdDSA: "ED25519_SHA_512" }[kind]] as never,
  });
  mock.on(SignCommand).callsFake((input: { Message: Uint8Array; MessageType: string }) => {
    const msg = Buffer.from(input.Message);
    let sig: Buffer;
    if (kind === "RS256") {
      // KMS was handed a DIGEST: build the PKCS#1 v1.5 signature over it.
      expect(input.MessageType).toBe("DIGEST");
      const DIGEST_INFO = Buffer.from("3031300d060960864801650304020105000420", "hex");
      const em = Buffer.concat([DIGEST_INFO, msg]);
      sig = privateEncrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING }, em);
    } else if (kind === "ES256") {
      // Node cannot ECDSA-sign a precomputed digest, so the ES256 fake supports GetPublicKey only.
      throw new Error("ES256 signing is not emulated");
    } else {
      expect(input.MessageType).toBe("RAW");
      sig = nodeSign(null, msg, pair.privateKey);
    }
    if (options.corruptSignature) sig = Buffer.from(sig.map((b) => b ^ 0xff));
    return { Signature: new Uint8Array(sig) };
  });
  return { mock, pair };
}

describe("KmsSigner (aws-sdk-client-mock)", () => {
  afterEach(() => {
    // each test installs its own mock; restore the prototype
    mockClient(KMSClient).restore();
  });

  it("RS256: sends a SHA-256 DIGEST with RSASSA_PKCS1_V1_5_SHA_256, publishes the KMS public key, and verifies", async () => {
    const { mock } = fakeKms("RS256");
    const signer = await KmsSigner.create({ client: new KMSClient({ region: "us-east-1" }), keyId: "alias/zenith-oidc", alg: "RS256" });
    const jws = await signer.sign({ typ: "JWT" }, { sub: "s" });
    await verifyWith(jws, signer.publicJwk());
    const call = mock.commandCalls(SignCommand)[0].args[0].input;
    expect(call.SigningAlgorithm).toBe("RSASSA_PKCS1_V1_5_SHA_256");
    expect(call.MessageType).toBe("DIGEST");
    expect(call.KeyId).toBe("alias/zenith-oidc");
    const signingInput = jws.split(".").slice(0, 2).join(".");
    expect(Buffer.from(call.Message as Uint8Array).toString("hex")).toBe(createHash("sha256").update(signingInput).digest("hex"));
    expect(signer.publicJwk()).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(signer.publicJwk().kid).toBe(jwkThumbprint(signer.publicJwk()));
  });

  it("ES256: accepts a P-256 key and publishes an EC JWK (signing is covered by the DER conversion tests)", async () => {
    fakeKms("ES256");
    const signer = await KmsSigner.create({ client: new KMSClient({}), keyId: "k", alg: "ES256" });
    expect(signer.publicJwk()).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
  });

  it("EdDSA: signs RAW with ED25519_SHA_512 and refuses oversized messages", async () => {
    const { mock } = fakeKms("EdDSA");
    const signer = await KmsSigner.create({ client: new KMSClient({}), keyId: "key-id", alg: "EdDSA" });
    const jws = await signer.sign({ typ: "zenith-grant+jwt" }, { a: 1 });
    await verifyWith(jws, signer.publicJwk());
    expect(mock.commandCalls(SignCommand)[0].args[0].input.SigningAlgorithm).toBe("ED25519_SHA_512");
    await expect(signer.sign({}, { big: "x".repeat(5000) })).rejects.toThrow(/too large/);
  });

  it("refuses to return a signature the published key does not verify", async () => {
    fakeKms("EdDSA", { corruptSignature: true });
    const signer = await KmsSigner.create({ client: new KMSClient({}), keyId: "key-id", alg: "EdDSA" });
    await expect(signer.sign({}, { a: 1 })).rejects.toThrow(/did not verify/);
  });

  it("rejects a key with the wrong spec or usage, naming the source", async () => {
    fakeKms("RS256", { keySpec: "RSA_2048" });
    await expect(
      KmsSigner.create({ client: new KMSClient({}), keyId: "k", alg: "EdDSA", variable: "ZENITH_CONTROL_KMS_KEY_ID" })
    ).rejects.toThrow(/ZENITH_CONTROL_KMS_KEY_ID/);
    const mock = mockClient(KMSClient);
    mock.on(GetPublicKeyCommand).resolves({ KeyUsage: "ENCRYPT_DECRYPT", KeySpec: "RSA_2048" as never, PublicKey: new Uint8Array([1]) });
    await expect(KmsSigner.create({ client: new KMSClient({}), keyId: "k", alg: "RS256" })).rejects.toThrow(/SIGN_VERIFY/);
  });

  it("maps KMS failures to SigningError without leaking the underlying message", async () => {
    const { mock } = fakeKms("EdDSA");
    const signer = await KmsSigner.create({ client: new KMSClient({}), keyId: "k", alg: "EdDSA" });
    mock.on(SignCommand).rejects(new Error("AccessDeniedException: arn:aws:kms:us-east-1:123456789012:key/secret-detail"));
    const err = await signer.sign({}, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SigningError);
    expect((err as Error).message).not.toContain("secret-detail");
  });

  it("loads from ZENITH_OIDC_KMS_KEY_ID through the injected client and does not cache injected clients", async () => {
    fakeKms("RS256");
    const client = new KMSClient({ region: "us-east-1" });
    const s1 = await getOidcSigner({ ZENITH_OIDC_KMS_KEY_ID: "arn:aws:kms:us-east-1:123456789012:key/abc" }, { kmsClient: client });
    const s2 = await getOidcSigner({ ZENITH_OIDC_KMS_KEY_ID: "arn:aws:kms:us-east-1:123456789012:key/abc" }, { kmsClient: client });
    expect(s1?.alg).toBe("RS256");
    expect(s2).not.toBe(s1);
  });
});

describe("public JWK conversion sanity", () => {
  it("createPublicKey round-trips the published JWK", () => {
    const k = createPublicKey({ key: keys.rsa.publicJwk as never, format: "jwk" });
    expect(k.asymmetricKeyType).toBe("rsa");
  });
});
