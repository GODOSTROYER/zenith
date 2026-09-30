/**
 * `JoseGrantSigner` — signs capability grants as compact EdDSA JWS with a
 * private Ed25519 JWK from `ZENITH_CONTROL_SIGNING_JWK`.
 *
 * CLEARLY REPLACEABLE. The credential-broker workstream owns control-plane
 * signing (`src/lib/credentials/signing`, KMS support, key rotation, pinned
 * public-key sets). This implementation exists so the broker is complete and
 * testable on its own; it satisfies the `GrantSigner` port and emits the same
 * token shape that workstream verifies:
 *
 *     header  { "alg": "EdDSA", "typ": "zenith-grant+jwt", "kid": <RFC 7638 thumbprint> }
 *     payload CapabilityGrantClaims
 *
 * The orchestrator swaps it for an adapter over `signCapabilityGrant` by
 * passing a different `GrantSigner` to `platformBroker()`; nothing else here
 * changes.
 *
 * The value of `ZENITH_CONTROL_SIGNING_JWK` is a private JWK as JSON, or base64
 * of that JSON. It is read, imported into a key object and never retained as
 * text, returned, logged or put in an error. `publicJwk()` returns the public
 * half only. A grant may live at most one hour; longer is refused at signing.
 */
import { CompactSign, calculateJwkThumbprint, compactVerify, importJWK, type JWK } from "jose";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { BrokerError } from "./errors";
import type { GrantSigner } from "./ports";

export const GRANT_TYP = "zenith-grant+jwt";
export const MAX_GRANT_LIFETIME_SEC = 3600;
export const SIGNING_JWK_ENV = "ZENITH_CONTROL_SIGNING_JWK";

const str = (max = 300) => z.string().min(1).max(max);

const ClaimsSchema = z
  .object({
    jti: str(),
    iss: str(),
    aud: str(),
    sub: str(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    cap: str(100),
    op: str(),
    digest: str(),
    ws: str(),
    proj: str().optional(),
    env: str().optional(),
    res: str().optional(),
    fence: z.number().int().nonnegative().optional(),
    constraints: z.record(z.unknown()).optional(),
  })
  .strict();

const unavailable = (why: string): BrokerError =>
  new BrokerError("signer_unavailable", `Capability grants cannot be signed: ${why}.`, `Set ${SIGNING_JWK_ENV} to a private Ed25519 JWK (JSON or base64 of JSON).`);

interface LoadedKey {
  /** what the env value looked like, so a changed value is re-imported */
  source: string;
  key: Awaited<ReturnType<typeof importJWK>>;
  kid: string;
  publicJwk: JWK;
}

function parseJwk(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim();
  const candidates = text.startsWith("{") ? [text] : [Buffer.from(text, "base64").toString("utf8")];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through: one generic error below, which never quotes the input */
    }
  }
  return undefined;
}

export class JoseGrantSigner implements GrantSigner {
  #loaded?: LoadedKey;

  /** `source` returns the raw env value; injectable so tests need not touch `process.env`. */
  constructor(private readonly source: () => string | undefined = () => process.env[SIGNING_JWK_ENV]) {}

  async #load(): Promise<LoadedKey> {
    const raw = this.source();
    if (!raw || !raw.trim()) throw unavailable(`${SIGNING_JWK_ENV} is not set`);
    if (this.#loaded && this.#loaded.source === raw) return this.#loaded;
    const jwk = parseJwk(raw);
    if (!jwk) throw unavailable(`${SIGNING_JWK_ENV} is not valid JSON (or base64 of JSON)`);
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
      throw unavailable(`${SIGNING_JWK_ENV} must be a private Ed25519 (OKP) JWK`);
    }
    const { d: _private, ...publicMembers } = jwk;
    const publicJwk: JWK = { ...(publicMembers as JWK), alg: "EdDSA", use: "sig" };
    try {
      const key = await importJWK(jwk as JWK, "EdDSA");
      const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : await calculateJwkThumbprint(publicJwk);
      this.#loaded = { source: raw, key, kid, publicJwk: { ...publicJwk, kid } };
      return this.#loaded;
    } catch {
      throw unavailable(`${SIGNING_JWK_ENV} is not a usable Ed25519 private key`);
    }
  }

  async ready(): Promise<void> {
    await this.#load();
  }

  /** The public half, for verifiers and JWKS publication. */
  async publicJwk(): Promise<JWK> {
    return { ...(await this.#load()).publicJwk };
  }

  async sign(claims: CapabilityGrantClaims): Promise<string> {
    const parsed = ClaimsSchema.safeParse(claims);
    if (!parsed.success) throw new BrokerError("grant_issue_failed", "Refusing to sign a grant with malformed claims.");
    const { iat, exp } = parsed.data;
    if (exp <= iat || exp - iat > MAX_GRANT_LIFETIME_SEC) {
      throw new BrokerError("grant_issue_failed", `A grant must expire after it is issued and live at most ${MAX_GRANT_LIFETIME_SEC} seconds.`);
    }
    const { key, kid } = await this.#load();
    return new CompactSign(new TextEncoder().encode(JSON.stringify(parsed.data)))
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_TYP, kid })
      .sign(key);
  }
}

/**
 * Verify a grant against ONE pinned public JWK and return its claims. For
 * tests and for in-process consumers of read grants; execution surfaces use
 * the credential broker's verifier, which pins a key set and adds revocation.
 * Checks signature (EdDSA only), typ, expiry, audience and lifetime.
 */
export async function verifyGrantJws(
  jws: string,
  publicJwk: JWK,
  options: { audience: string; now?: Date }
): Promise<CapabilityGrantClaims> {
  const key = createPublicKey({ key: publicJwk as never, format: "jwk" });
  const { payload, protectedHeader } = await compactVerify(jws, key, { algorithms: ["EdDSA"] });
  if (protectedHeader.typ !== GRANT_TYP) throw new Error("grant has the wrong typ");
  const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(payload).toString("utf8"))) as CapabilityGrantClaims;
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp <= nowSec) throw new Error("grant is expired");
  if (claims.exp - claims.iat > MAX_GRANT_LIFETIME_SEC) throw new Error("grant lifetime too long");
  if (claims.aud !== options.audience) throw new Error("grant audience mismatch");
  return claims;
}
