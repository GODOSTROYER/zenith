/**
 * JWK helpers shared by the local signer, the KMS signer, the key generator
 * and the JWKS/verification code. Pure functions over `node:crypto`; no I/O.
 *
 * Nothing here ever includes a private member or the input text in an error.
 */
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { CredentialConfigError, SigningError } from "../errors";
import { PRIVATE_JWK_MEMBERS, type PublicJwk, type SigningAlg } from "./types";

export const b64u = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** RFC 7638 JWK thumbprint (sha256, base64url) over the required public members. */
export function jwkThumbprint(jwk: { kty?: unknown; n?: unknown; e?: unknown; crv?: unknown; x?: unknown; y?: unknown }): string {
  let members: Record<string, unknown>;
  switch (jwk.kty) {
    case "RSA":
      members = { e: jwk.e, kty: "RSA", n: jwk.n };
      break;
    case "EC":
      members = { crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y };
      break;
    case "OKP":
      members = { crv: jwk.crv, kty: "OKP", x: jwk.x };
      break;
    default:
      throw new SigningError("Cannot compute a thumbprint for an unsupported JWK type.");
  }
  for (const v of Object.values(members)) {
    if (typeof v !== "string" || !v) throw new SigningError("JWK is missing a required public member.");
  }
  return createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

export function hasPrivateMembers(jwk: Record<string, unknown>): boolean {
  return PRIVATE_JWK_MEMBERS.some((m) => m in jwk);
}

/** The signing algorithm a public key type implies, or undefined for unsupported types. */
export function algForKey(key: KeyObject): SigningAlg | undefined {
  switch (key.asymmetricKeyType) {
    case "rsa":
      return "RS256";
    case "ec":
      return key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? "ES256" : undefined;
    case "ed25519":
      return "EdDSA";
    default:
      return undefined;
  }
}

/** Build the published JWK from a public `KeyObject` (a private one is reduced to its public half). */
export function publicJwkFromKey(key: KeyObject, alg: SigningAlg, kid?: string): PublicJwk {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const raw = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const jwk: PublicJwk = { kty: raw.kty as PublicJwk["kty"], kid: "", alg, use: "sig" };
  for (const m of ["n", "e", "crv", "x", "y"] as const) {
    if (typeof raw[m] === "string") jwk[m] = raw[m] as string;
  }
  jwk.kid = kid ?? jwkThumbprint(jwk);
  return jwk;
}

/** Minimum RSA modulus size we will sign or publish with. */
export const MIN_RSA_BITS = 2048;

export function rsaBits(key: KeyObject): number {
  return key.asymmetricKeyDetails?.modulusLength ?? 0;
}

/** Raw signature over `input` with the JOSE conventions (RSA v1.5/SHA-256, P1363 ECDSA, pure Ed25519). */
export function signRaw(alg: SigningAlg, key: KeyObject, input: Buffer): Buffer {
  switch (alg) {
    case "RS256":
      return cryptoSign("sha256", input, key);
    case "ES256":
      return cryptoSign("sha256", input, { key, dsaEncoding: "ieee-p1363" });
    case "EdDSA":
      return cryptoSign(null, input, key);
  }
}

export function verifyRaw(alg: SigningAlg, publicKey: KeyObject, input: Buffer, signature: Buffer): boolean {
  switch (alg) {
    case "RS256":
      return cryptoVerify("sha256", input, publicKey, signature);
    case "ES256":
      return cryptoVerify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    case "EdDSA":
      return cryptoVerify(null, input, publicKey, signature);
  }
}

/** `base64url(header).base64url(payload)` — the JWS signing input. */
export function jwsSigningInput(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
}

/**
 * Merge caller header members with the signer's `alg`/`kid`. A caller that
 * names a different alg or kid is a bug, not a request — refuse it.
 */
export function protectedHeader(
  alg: SigningAlg,
  kid: string,
  header: Record<string, unknown>
): Record<string, unknown> {
  if (header.alg !== undefined && header.alg !== alg) throw new SigningError("Header alg does not match the signer.");
  if (header.kid !== undefined && header.kid !== kid) throw new SigningError("Header kid does not match the signer.");
  const { alg: _a, kid: _k, ...rest } = header;
  return { alg, ...rest, kid };
}

/**
 * Parse a JWK-bearing environment value: a JSON object, or base64/base64url of
 * one (handy where multi-line or quote-heavy values are awkward). The error
 * never quotes the input.
 */
export function parseJwkEnvValue(variable: string, raw: string): Record<string, unknown> {
  const text = raw.trim();
  const candidates = text.startsWith("{") || text.startsWith("[") ? [text] : [Buffer.from(text, "base64").toString("utf8")];
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through to the single generic error below */
    }
  }
  throw new CredentialConfigError(variable, "is not valid JSON (or base64 of JSON)");
}
