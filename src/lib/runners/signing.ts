/**
 * Control-plane JWS signing (RUNNER-PROTOCOL.md sections 1, 4, 5).
 *
 * The control plane signs three things with ONE Ed25519 key (`EdDSA`):
 *   - runner jobs              `typ: zenith-job+jwt`
 *   - zenithd requests         `typ: zenith-machine+jwt`
 *   - capability grants        `typ: zenith-grant+jwt`   (issued by the broker; this
 *                                                          module only VERIFIES them, to
 *                                                          refuse dispatching a job whose
 *                                                          grant the agent would reject)
 *
 * The protected header is exactly `{"alg":"EdDSA","kid":…,"typ":…}` in that
 * order — the Go agents decode it with unknown members refused, and a golden
 * vector (tests/runners/fixtures/go-jws-vector.json) pins the byte form: the
 * same seed, header and payload produce the same compact JWS as the Go tests.
 *
 * `ControlSigner` is a PORT. `createControlSignerFromJwk` implements it from
 * the private JWK in `ZENITH_CONTROL_SIGNING_JWK`; a KMS-backed signer replaces
 * it by implementing `sign` (use `jwsSigningInput` + `jwsFinish` around the
 * KMS `Sign` call, so the wire form cannot drift).
 *
 * Key rotation (spec section 1): agents pin the keys returned at registration.
 * A new key is first announced through `nextKeys()` (heartbeat responses) at
 * least 24 hours before it signs anything; the operator puts its PUBLIC half in
 * `ZENITH_CONTROL_NEXT_KEYS` (`[{"kid","publicKey"}]`) and later swaps
 * `ZENITH_CONTROL_SIGNING_JWK`. This module cannot enforce the 24 hours.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { CompactSign, importJWK, type JWK } from "jose";
import { RunnerConfigError, type JwsTyp } from "@/lib/runners/types";

export interface ControlKey {
  kid: string;
  /** base64url of the raw 32-byte Ed25519 public key */
  publicKey: string;
}

export interface ControlSigner {
  /** kid of the key `sign` uses */
  readonly kid: string;
  /** compact JWS over `JSON.stringify(payload)` */
  sign(typ: JwsTyp, payload: object): Promise<string>;
  /** keys an agent must pin at registration (the active signing key) */
  publicKeys(): ControlKey[];
  /** announced rotation keys, delivered in heartbeat responses */
  nextKeys(): ControlKey[];
}

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
const B64U = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/* ------------------------- wire form (shared with KMS) ------------------------- */

/** `b64url(header) "." b64url(payload)` — exactly what is signed. */
export function jwsSigningInput(typ: JwsTyp, kid: string, payload: object): string {
  const header = JSON.stringify({ alg: "EdDSA", kid, typ });
  return `${b64u(Buffer.from(header, "utf8"))}.${b64u(Buffer.from(JSON.stringify(payload), "utf8"))}`;
}

/** Attach a raw 64-byte Ed25519 signature to a signing input. */
export function jwsFinish(signingInput: string, signature: Uint8Array): string {
  if (signature.length !== 64) throw new Error("An Ed25519 signature is 64 bytes.");
  return `${signingInput}.${b64u(signature)}`;
}

/* -------------------------------- verification -------------------------------- */

function publicKeyObject(publicKey: string) {
  if (!PUBLIC_KEY.test(publicKey)) throw new Error("Not a base64url raw 32-byte Ed25519 public key.");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();
/** Verify `data` against a raw public key; false for any malformed input. */
export function verifyEd25519(publicKey: string, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    let key = keyCache.get(publicKey);
    if (!key) {
      key = publicKeyObject(publicKey);
      if (keyCache.size > 512) keyCache.clear();
      keyCache.set(publicKey, key);
    }
    return cryptoVerify(null, data, key, signature);
  } catch {
    return false;
  }
}

export class JwsError extends Error {
  constructor(
    readonly code: "malformed" | "bad_header" | "bad_typ" | "unknown_key" | "bad_signature",
    message: string
  ) {
    super(message);
    this.name = "JwsError";
  }
}

export interface VerifiedJws {
  header: { alg: "EdDSA"; kid: string; typ: JwsTyp };
  payload: Record<string, unknown>;
}

/**
 * Verify a compact JWS signed by one of `keys`: three parts, a header with
 * exactly `alg`/`kid`/`typ`, `alg` EdDSA, the expected `typ`, a known `kid`,
 * and a valid Ed25519 signature. The payload must be a JSON object. Throws
 * `JwsError`; claims (exp, aud, …) are the caller's to check.
 */
export function verifyControlJws(token: string, typ: JwsTyp, keys: readonly ControlKey[]): VerifiedJws {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !B64U.test(p))) throw new JwsError("malformed", "A compact JWS has three base64url parts.");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new JwsError("malformed", "The JWS header is not JSON.");
  }
  const names = header && typeof header === "object" ? Object.keys(header).sort().join(",") : "";
  if (names !== "alg,kid,typ" || header.alg !== "EdDSA" || typeof header.kid !== "string") throw new JwsError("bad_header", "The JWS header must be exactly alg EdDSA, kid, typ.");
  if (header.typ !== typ) throw new JwsError("bad_typ", `typ must be ${typ}.`);
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) throw new JwsError("unknown_key", "The JWS kid is not a control-plane key.");
  const signature = Buffer.from(parts[2], "base64url");
  if (!verifyEd25519(key.publicKey, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), signature)) throw new JwsError("bad_signature", "The JWS signature does not verify.");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new JwsError("malformed", "The JWS payload is not JSON.");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new JwsError("malformed", "The JWS payload must be a JSON object.");
  return { header: { alg: "EdDSA", kid: key.kid, typ }, payload: payload as Record<string, unknown> };
}

/** Read the claims of a compact JWS WITHOUT verifying it (diagnostics only; never trust the result). */
export function unverifiedClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------ JWK-backed signer ------------------------------ */

export interface JwkSignerOptions {
  /** defaults to the JWK's own `kid`, else `cp-<first 12 chars of the RFC 7638 thumbprint>` */
  kid?: string;
  nextKeys?: readonly ControlKey[];
}

/** RFC 7638 thumbprint of an Ed25519 public key (base64url). */
function thumbprint(x: string): string {
  return b64u(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());
}

function parseSigningJwk(raw: unknown): { jwk: JWK & { d: string; x: string } } {
  const jwk = raw as JWK | null;
  if (!jwk || typeof jwk !== "object" || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string")
    throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK must be a private Ed25519 JWK ({kty:OKP, crv:Ed25519, d, x}).");
  if (!PUBLIC_KEY.test(jwk.x) || !PUBLIC_KEY.test(jwk.d)) throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK has malformed key members.");
  // the public half must be the one the private half derives; a mismatched pair would publish a key that cannot verify
  const derived = createPublicKey(createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, format: "jwk" })).export({ format: "jwk" }).x;
  if (derived !== jwk.x) throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK: `x` does not match `d`.");
  return { jwk: jwk as JWK & { d: string; x: string } };
}

export function createControlSignerFromJwk(raw: unknown, options: JwkSignerOptions = {}): ControlSigner {
  const { jwk } = parseSigningJwk(raw);
  const kid = options.kid ?? (typeof jwk.kid === "string" && jwk.kid.length > 0 ? jwk.kid : `cp-${thumbprint(jwk.x).slice(0, 12)}`);
  if (kid.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(kid)) throw new RunnerConfigError("The control-plane signing kid must be 1-128 characters of A-Za-z0-9_.:-.");
  const next = [...(options.nextKeys ?? [])];
  for (const k of next) if (!PUBLIC_KEY.test(k.publicKey) || !k.kid || k.kid === kid) throw new RunnerConfigError("ZENITH_CONTROL_NEXT_KEYS holds an invalid or duplicate key.");
  let imported: ReturnType<typeof importJWK> | undefined;
  return {
    kid,
    async sign(typ, payload) {
      imported ??= importJWK({ kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, "EdDSA");
      const key = await imported;
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({ alg: "EdDSA", kid, typ }).sign(key);
    },
    publicKeys: () => [{ kid, publicKey: jwk.x }],
    nextKeys: () => next.map((k) => ({ ...k })),
  };
}

/** `ZENITH_CONTROL_SIGNING_JWK` (+ optional `ZENITH_CONTROL_SIGNING_KID`, `ZENITH_CONTROL_NEXT_KEYS`). */
export function createControlSignerFromEnv(env: Record<string, string | undefined> = process.env): ControlSigner {
  const raw = env.ZENITH_CONTROL_SIGNING_JWK;
  if (!raw) throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK is not set; the runner plane cannot sign jobs.");
  let jwk: unknown;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new RunnerConfigError("ZENITH_CONTROL_SIGNING_JWK is not valid JSON.");
  }
  let nextKeys: ControlKey[] = [];
  if (env.ZENITH_CONTROL_NEXT_KEYS) {
    try {
      const parsed: unknown = JSON.parse(env.ZENITH_CONTROL_NEXT_KEYS);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      nextKeys = parsed.map((k: { kid?: unknown; publicKey?: unknown }) => ({ kid: String(k.kid), publicKey: String(k.publicKey) }));
    } catch {
      throw new RunnerConfigError("ZENITH_CONTROL_NEXT_KEYS must be a JSON array of {kid, publicKey}.");
    }
  }
  return createControlSignerFromJwk(jwk, { kid: env.ZENITH_CONTROL_SIGNING_KID || undefined, nextKeys });
}

/** A fresh Ed25519 private JWK with `kid` (tests and first-time key generation). */
export function generateControlSigningJwk(kid: string): JWK & { d: string; x: string; kid: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as JWK & { d: string; x: string };
  return { ...jwk, kid };
}
