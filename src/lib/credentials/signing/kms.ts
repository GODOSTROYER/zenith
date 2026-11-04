/**
 * KmsSigner — the private key never leaves AWS KMS.
 *
 *  - RS256: `RSASSA_PKCS1_V1_5_SHA_256` over the SHA-256 digest (RSA_2048+ key,
 *    KeyUsage SIGN_VERIFY). This is what the OIDC issuer uses in production.
 *  - ES256: `ECDSA_SHA_256` over the digest (ECC_NIST_P256). KMS returns a DER
 *    signature; JOSE needs the fixed-width r||s form, converted here.
 *  - EdDSA: `ED25519_SHA_512` (pure Ed25519, ECC_NIST_EDWARDS25519). KMS limits
 *    RAW messages to 4096 bytes; grants and job envelopes are far smaller and
 *    an oversize message is refused rather than truncated.
 *
 * The public JWK comes from `GetPublicKey` (SPKI DER). Every signature is
 * verified locally against that cached public key before it is returned, so a
 * misconfigured alias, a wrong key spec or a key swapped under an alias fails
 * loudly here instead of producing tokens no relying party accepts.
 *
 * Verified against aws-sdk-client-mock only; not exercised against real KMS.
 */
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand, type KMSClient } from "@aws-sdk/client-kms";
import { CredentialConfigError, SigningError } from "../errors";
import { algForKey, b64u, jwsSigningInput, protectedHeader, publicJwkFromKey, verifyRaw, MIN_RSA_BITS, rsaBits } from "./jwk";
import type { JwtSigner, PublicJwk, SigningAlg } from "./types";

const KMS_ALGORITHM: Record<SigningAlg, "RSASSA_PKCS1_V1_5_SHA_256" | "ECDSA_SHA_256" | "ED25519_SHA_512"> = {
  RS256: "RSASSA_PKCS1_V1_5_SHA_256",
  ES256: "ECDSA_SHA_256",
  EdDSA: "ED25519_SHA_512",
};

const KEY_SPECS: Record<SigningAlg, readonly string[]> = {
  RS256: ["RSA_2048", "RSA_3072", "RSA_4096"],
  ES256: ["ECC_NIST_P256"],
  EdDSA: ["ECC_NIST_EDWARDS25519"],
};

/** KMS RAW-message limit for Ed25519. */
const KMS_RAW_MAX_BYTES = 4096;

/** Convert an ASN.1 DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) to fixed-width r||s. */
export function derEcdsaToJose(der: Uint8Array, size = 32): Buffer {
  const b = Buffer.from(der);
  let o = 0;
  const fail = (): never => {
    throw new SigningError("KMS returned a malformed ECDSA signature.");
  };
  const readLen = (): number => {
    let len = b[o++];
    if (len === undefined) return fail();
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2) return fail();
      len = 0;
      for (let i = 0; i < n; i++) {
        const next = b[o++];
        if (next === undefined) return fail();
        len = (len << 8) | next;
      }
    }
    return len;
  };
  if (b[o++] !== 0x30) fail();
  const total = readLen();
  if (o + total !== b.length) fail();
  const ints: Buffer[] = [];
  for (let i = 0; i < 2; i++) {
    if (b[o++] !== 0x02) fail();
    const len = readLen();
    if (len < 1 || o + len > b.length) fail();
    let int = b.subarray(o, o + len);
    o += len;
    while (int.length > 1 && int[0] === 0) int = int.subarray(1);
    if (int.length > size) fail();
    ints.push(Buffer.concat([Buffer.alloc(size - int.length), int]));
  }
  if (o !== b.length) fail();
  return Buffer.concat(ints);
}

export interface KmsSignerOptions {
  client: KMSClient;
  /** key id, key ARN or alias */
  keyId: string;
  alg: SigningAlg;
  /** override the derived (thumbprint) key id */
  kid?: string;
  /** names the source in configuration errors */
  variable?: string;
}

export class KmsSigner implements JwtSigner {
  readonly kid: string;
  readonly alg: SigningAlg;
  readonly #client: KMSClient;
  readonly #keyId: string;
  readonly #publicKey: KeyObject;
  readonly #public: PublicJwk;

  private constructor(client: KMSClient, keyId: string, alg: SigningAlg, publicKey: KeyObject, kid?: string) {
    this.#client = client;
    this.#keyId = keyId;
    this.alg = alg;
    this.#publicKey = publicKey;
    this.#public = publicJwkFromKey(publicKey, alg, kid);
    this.kid = this.#public.kid;
  }

  /** Fetch and validate the key's public half, then return a ready signer. */
  static async create(options: KmsSignerOptions): Promise<KmsSigner> {
    const variable = options.variable ?? "KMS key";
    let out;
    try {
      out = await options.client.send(new GetPublicKeyCommand({ KeyId: options.keyId }));
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      throw new SigningError(`KMS GetPublicKey failed (${name}); check the key id and the caller's kms:GetPublicKey permission.`);
    }
    if (out.KeyUsage !== "SIGN_VERIFY") {
      throw new CredentialConfigError(variable, "KMS key usage must be SIGN_VERIFY");
    }
    const spec = out.KeySpec ?? out.CustomerMasterKeySpec;
    if (!spec || !KEY_SPECS[options.alg].includes(spec)) {
      throw new CredentialConfigError(
        variable,
        `KMS key spec must be one of ${KEY_SPECS[options.alg].join(", ")} for ${options.alg}`
      );
    }
    if (out.SigningAlgorithms && !out.SigningAlgorithms.includes(KMS_ALGORITHM[options.alg])) {
      throw new CredentialConfigError(variable, `KMS key does not support ${KMS_ALGORITHM[options.alg]}`);
    }
    if (!out.PublicKey) throw new SigningError("KMS returned no public key.");
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: Buffer.from(out.PublicKey), format: "der", type: "spki" });
    } catch {
      throw new SigningError("KMS returned a public key that could not be parsed.");
    }
    if (algForKey(publicKey) !== options.alg) {
      throw new CredentialConfigError(variable, `KMS public key type does not match ${options.alg}`);
    }
    if (options.alg === "RS256" && rsaBits(publicKey) < MIN_RSA_BITS) {
      throw new CredentialConfigError(variable, `RSA key must be at least ${MIN_RSA_BITS} bits`);
    }
    return new KmsSigner(options.client, options.keyId, options.alg, publicKey, options.kid);
  }

  publicJwk(): PublicJwk {
    return { ...this.#public };
  }

  async sign(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const input = Buffer.from(jwsSigningInput(protectedHeader(this.alg, this.kid, header), payload), "ascii");
    let raw: Buffer;
    if (this.alg === "EdDSA") {
      if (input.length > KMS_RAW_MAX_BYTES) throw new SigningError("Message is too large for KMS Ed25519 signing.");
      raw = await this.#kmsSign(input, "RAW");
    } else {
      raw = await this.#kmsSign(createHash("sha256").update(input).digest(), "DIGEST");
      if (this.alg === "ES256") raw = derEcdsaToJose(raw);
    }
    // Never return a signature the published key would not accept.
    if (!verifyRaw(this.alg, this.#publicKey, input, raw)) {
      throw new SigningError("KMS signature did not verify against the key's published public key; refusing to issue it.");
    }
    return `${input.toString("ascii")}.${b64u(raw)}`;
  }

  async #kmsSign(message: Buffer, type: "RAW" | "DIGEST"): Promise<Buffer> {
    try {
      const out = await this.#client.send(
        new SignCommand({
          KeyId: this.#keyId,
          Message: message,
          MessageType: type,
          SigningAlgorithm: KMS_ALGORITHM[this.alg],
        })
      );
      if (!out.Signature) throw new SigningError("KMS returned no signature.");
      return Buffer.from(out.Signature);
    } catch (e) {
      if (e instanceof SigningError) throw e;
      const name = e instanceof Error ? e.name : "Error";
      throw new SigningError(`KMS Sign failed (${name}).`);
    }
  }

  toJSON(): { kid: string; alg: SigningAlg } {
    return { kid: this.kid, alg: this.alg };
  }
}
