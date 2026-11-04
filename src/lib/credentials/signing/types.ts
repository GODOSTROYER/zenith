/**
 * Signing contracts.
 *
 * Two independent key families (RUNNER-PROTOCOL §1):
 *  - OIDC issuer key — RS256, used ONLY to mint cloud workload-identity tokens.
 *  - control-plane key — EdDSA (Ed25519), signs capability grants, runner jobs
 *    and machine requests.
 * They must never be the same key; the loaders below read different variables
 * and validate the algorithm of each.
 */

export type SigningAlg = "RS256" | "ES256" | "EdDSA";

/** A public JWK as published in a JWKS. Never contains private members. */
export interface PublicJwk {
  kty: "RSA" | "EC" | "OKP";
  kid: string;
  alg: SigningAlg;
  use: "sig";
  /** RSA modulus / exponent */
  n?: string;
  e?: string;
  /** EC / OKP curve and coordinates */
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtSigner {
  /** stable key id placed in the JWS header and the JWKS */
  readonly kid: string;
  readonly alg: SigningAlg;
  /** the public half, safe to publish; never contains private members */
  publicJwk(): PublicJwk;
  /**
   * Produce a compact JWS. `header` supplies extra protected-header members
   * (typically `typ`); `alg` and `kid` are set by the signer and a header that
   * names a different `alg`/`kid` is rejected.
   */
  sign(header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string>;
}

/** Members whose presence marks a JWK as containing private/secret material. */
export const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
