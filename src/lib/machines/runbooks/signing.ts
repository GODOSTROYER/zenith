/**
 * Runbook version signatures (PROD-MACH-03).
 *
 * A published runbook version is a compact JWS (`typ: zenith-runbook+jwt`,
 * `alg: EdDSA`) signed with the control-plane key (`getControlSigner`) over
 * claims that bind the workspace, runbook id, version number and the SHA-256 of
 * the canonical definition. The runner re-verifies the signature against PINNED
 * public keys and re-derives the digest from the stored definition at EVERY run,
 * so a database row that was edited after signing is refused, never executed.
 *
 * Header rules mirror capability grants: only EdDSA, a `kid` that is pinned,
 * and no embedded-key headers (`jwk`, `jku`, `x5*`, `crit`).
 */
import { createPublicKey } from "node:crypto";
import { compactVerify } from "jose";
import { z } from "zod";
import type { JwtSigner, PublicJwk } from "@/lib/credentials/signing/types";
import { RunbookError, definitionDigest, type RunbookDefinition } from "./definition";

export const RUNBOOK_TYP = "zenith-runbook+jwt";
const B64U = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "x5t", "x5t#S256", "crit"] as const;
const MAX_JWS_BYTES = 4096;

export interface RunbookSignatureClaims {
  iss: "zenith-control";
  ws: string;
  rb: string;
  ver: number;
  dig: string;
  iat: number;
}

const ClaimsSchema = z
  .object({
    iss: z.literal("zenith-control"),
    ws: z.string().min(1).max(128),
    rb: z.string().min(1).max(64),
    ver: z.number().int().min(1),
    dig: z.string().regex(/^[a-f0-9]{64}$/),
    iat: z.number().int().min(0),
  })
  .strict();

export interface SignedRunbook {
  signature: string;
  kid: string;
  digest: string;
}

export async function signRunbookVersion(
  signer: JwtSigner,
  input: { workspaceId: string; runbookId: string; version: number; definition: RunbookDefinition; now: Date }
): Promise<SignedRunbook> {
  if (signer.alg !== "EdDSA") throw new RunbookError("signature_invalid", "Runbooks must be signed with the EdDSA control-plane key.");
  const dig = definitionDigest(input.definition);
  const claims: RunbookSignatureClaims = { iss: "zenith-control", ws: input.workspaceId, rb: input.runbookId, ver: input.version, dig, iat: Math.floor(input.now.getTime() / 1000) };
  const signature = await signer.sign({ typ: RUNBOOK_TYP }, claims as unknown as Record<string, unknown>);
  return { signature, kid: signer.kid, digest: dig };
}

export interface RunbookSignatureSubject {
  workspaceId: string;
  runbookId: string;
  version: number;
  definition: RunbookDefinition;
  signature: string;
}

const fail = (): never => {
  // one fixed message: the reason never distinguishes forged from tampered
  throw new RunbookError("signature_invalid", "The runbook version signature does not verify; it will not run.");
};

/** Throws `signature_invalid` unless the signature verifies AND binds exactly this stored definition. */
export async function verifyRunbookVersion(subject: RunbookSignatureSubject, keys: readonly PublicJwk[]): Promise<RunbookSignatureClaims> {
  const jws = subject.signature;
  if (typeof jws !== "string" || jws.length === 0 || jws.length > MAX_JWS_BYTES) return fail();
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64U.test(p))) return fail();
  let header: Record<string, unknown>;
  try {
    const h: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!h || typeof h !== "object" || Array.isArray(h)) return fail();
    header = h as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (header.alg !== "EdDSA" || header.typ !== RUNBOOK_TYP || typeof header.kid !== "string" || !header.kid) return fail();
  if (FORBIDDEN_HEADERS.some((h) => h in header)) return fail();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return fail();
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(jws, createPublicKey({ key: jwk as never, format: "jwk" }), { algorithms: ["EdDSA"] }));
  } catch {
    return fail();
  }
  let claims: RunbookSignatureClaims;
  try {
    const parsed = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payload).toString("utf8")));
    if (!parsed.success) return fail();
    claims = parsed.data as RunbookSignatureClaims;
  } catch {
    return fail();
  }
  if (claims.ws !== subject.workspaceId || claims.rb !== subject.runbookId || claims.ver !== subject.version) return fail();
  if (claims.dig !== definitionDigest(subject.definition)) return fail();
  return claims;
}
