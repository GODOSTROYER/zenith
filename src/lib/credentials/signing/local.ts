/**
 * LocalJwkSigner — signs with a private JWK held in process memory.
 *
 * Suitable for development and small installs. Production should prefer
 * `KmsSigner` (the OIDC key is the crown jewel, ADR-0006). The private key
 * lives in a `KeyObject` behind a JS private field: it is not enumerable, not
 * JSON-serialisable and never appears in an error message.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { CredentialConfigError } from "../errors";
import type { SecretString } from "../secret";
import {
  MIN_RSA_BITS,
  algForKey,
  b64u,
  jwsSigningInput,
  parseJwkEnvValue,
  protectedHeader,
  publicJwkFromKey,
  rsaBits,
  signRaw,
} from "./jwk";
import type { JwtSigner, PublicJwk, SigningAlg } from "./types";

export interface LocalSignerOptions {
  /** the algorithm the key must be for; a mismatch is a configuration error */
  alg: SigningAlg;
  /** override the derived (RFC 7638 thumbprint) key id, e.g. "cp-2026-09" */
  kid?: string;
}

export class LocalJwkSigner implements JwtSigner {
  readonly kid: string;
  readonly alg: SigningAlg;
  readonly #key: KeyObject;
  readonly #public: PublicJwk;

  private constructor(key: KeyObject, alg: SigningAlg, kid: string | undefined) {
    this.#key = key;
    this.alg = alg;
    this.#public = publicJwkFromKey(createPublicKey(key), alg, kid);
    this.kid = this.#public.kid;
  }

  /**
   * `variable` is only used to name the source in errors. The JWK object is
   * consumed and not retained.
   */
  static fromJwk(variable: string, jwk: Record<string, unknown>, options: LocalSignerOptions): LocalJwkSigner {
    if (typeof jwk.d !== "string") {
      throw new CredentialConfigError(variable, "does not contain a private key (missing private members)");
    }
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: jwk as never, format: "jwk" });
    } catch {
      throw new CredentialConfigError(variable, `is not a valid private JWK for ${options.alg}`);
    }
    const implied = algForKey(key);
    if (implied !== options.alg) {
      throw new CredentialConfigError(
        variable,
        `key type does not match the required algorithm ${options.alg}${options.alg === "EdDSA" ? " (an Ed25519 OKP key)" : options.alg === "RS256" ? " (an RSA key)" : " (a P-256 EC key)"}`
      );
    }
    if (typeof jwk.alg === "string" && jwk.alg !== options.alg) {
      throw new CredentialConfigError(variable, `declares alg ${jwk.alg}, expected ${options.alg}`);
    }
    if (options.alg === "RS256" && rsaBits(key) < MIN_RSA_BITS) {
      throw new CredentialConfigError(variable, `RSA key must be at least ${MIN_RSA_BITS} bits`);
    }
    const kid = options.kid ?? (typeof jwk.kid === "string" && jwk.kid ? jwk.kid : undefined);
    return new LocalJwkSigner(key, options.alg, kid);
  }

  /** Parse `ZENITH_*_SIGNING_JWK`-style configuration (JSON or base64 of JSON). */
  static fromSecret(variable: string, secret: SecretString, options: LocalSignerOptions): LocalJwkSigner {
    return LocalJwkSigner.fromJwk(variable, parseJwkEnvValue(variable, secret.reveal()), options);
  }

  publicJwk(): PublicJwk {
    return { ...this.#public };
  }

  async sign(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const input = jwsSigningInput(protectedHeader(this.alg, this.kid, header), payload);
    const signature = signRaw(this.alg, this.#key, Buffer.from(input, "ascii"));
    return `${input}.${b64u(signature)}`;
  }

  /** Never serialise the signer's internals. */
  toJSON(): { kid: string; alg: SigningAlg } {
    return { kid: this.kid, alg: this.alg };
  }
}
