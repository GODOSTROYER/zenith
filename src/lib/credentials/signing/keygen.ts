/**
 * Signing-key generation, as a function (no scripts, no CLI): an operator or a
 * test calls it and stores `privateJwk` as a secret. See
 * `src/lib/credentials/OPERATIONS.md` for the exact one-liners.
 *
 * `privateJwk` is a secret: put it in the secret manager / environment, never
 * in the repository, a manifest, a log or a chat. `publicJwk` is what gets
 * published (and pinned by runners).
 */
import { generateKeyPair, type KeyObject } from "node:crypto";
import { promisify } from "node:util";
import { publicJwkFromKey } from "./jwk";
import type { PublicJwk, SigningAlg } from "./types";

const generate = promisify(generateKeyPair) as (
  type: "rsa" | "ed25519" | "ec",
  options: Record<string, unknown>
) => Promise<{ publicKey: KeyObject; privateKey: KeyObject }>;

export interface GeneratedSigningKey {
  alg: SigningAlg;
  kid: string;
  /** SECRET. JSON-encode it for `ZENITH_OIDC_SIGNING_JWK` / `ZENITH_CONTROL_SIGNING_JWK`. */
  privateJwk: Record<string, string>;
  publicJwk: PublicJwk;
}

export async function generateSigningJwk(alg: SigningAlg, options: { kid?: string } = {}): Promise<GeneratedSigningKey> {
  const { publicKey, privateKey } =
    alg === "RS256"
      ? await generate("rsa", { modulusLength: 2048 })
      : alg === "EdDSA"
        ? await generate("ed25519", {})
        : await generate("ec", { namedCurve: "prime256v1" });

  const publicJwk = publicJwkFromKey(publicKey, alg, options.kid);
  const exported = privateKey.export({ format: "jwk" }) as Record<string, string>;
  return {
    alg,
    kid: publicJwk.kid,
    privateJwk: { ...exported, kid: publicJwk.kid, alg, use: "sig" },
    publicJwk,
  };
}

/** One-line JSON for an environment variable. */
export const serializePrivateJwk = (key: Pick<GeneratedSigningKey, "privateJwk">): string => JSON.stringify(key.privateJwk);
