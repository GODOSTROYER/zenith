/**
 * Which credential authority this process answers from, and the two things
 * every link endpoint does before it touches one.
 *
 * **One selector, and it is the product store's.** A linked credential names a
 * `subject` that has to be a live member row, and membership lives in the
 * product store. If the product store is Postgres and the credential authority
 * were a local file, a Vercel instance would be authenticating against a `/tmp`
 * file no other instance has ever seen — inconsistent state across instances,
 * which is the ARCH-1 class of bug this whole round exists to close. A second
 * flag would be a second thing to get wrong.
 */
import { AgentError } from "../security";
import { isPostgres } from "@/lib/db/store";
import { requireLinkSecrets } from "../link/protocol";
import { fileCredentialAuthority, fileRateLimit } from "./file";
import { pgCredentialAuthority, pgRateLimit } from "./pg";
import type { CredentialAuthority } from "./types";

export type {
  ApproveLinkInput,
  CredentialAuthority,
  ExchangeResult,
  LinkRow,
  LinkStart,
  LinkedCredential,
  IssuedCredential,
} from "./types";

/** The authority `ZENITH_STORE` selects. Cheap; it holds no connection itself. */
export function credentialAuthority(): CredentialAuthority {
  return isPostgres() ? pgCredentialAuthority() : fileCredentialAuthority();
}

/**
 * The gate every link endpoint passes first: agent control enabled, a secret
 * key to seal the issued token with, and an authority that is actually there.
 *
 * Every refusal comes out as `503 link_unavailable` with the original reason
 * kept, because from the terminal's point of view they are one thing — this
 * server cannot link an agent right now — and the plugin prints the reason.
 */
export async function requireLinkAuthority(): Promise<CredentialAuthority> {
  requireLinkSecrets();
  return requireCredentialAuthority();
}

/**
 * The authority, proven reachable — without the link surface's extra demands.
 *
 * Listing and revoking must keep working on an install that can no longer
 * *issue*: a lost `ZENITH_SECRET_KEY` means no new credential can be sealed,
 * and it would be the wrong moment to also refuse to withdraw the ones already
 * out there.
 */
export async function requireCredentialAuthority(): Promise<CredentialAuthority> {
  const authority = credentialAuthority();
  try {
    await authority.ready();
  } catch (error) {
    throw new AgentError(
      "link_unavailable",
      error instanceof Error ? error.message : "The credential authority is unavailable.",
      503
    );
  }
  return authority;
}

/**
 * One durable fixed-window limiter, whichever store is in play — the Postgres
 * table on Postgres, the existing SQLite `DurableRateLimiter` on the file
 * store. Both key `(scope, key, bucket)` and both delete stale buckets on every
 * check.
 */
export function linkRateLimit(
  scope: string,
  key: string,
  options: { limit: number; windowMs: number }
): Promise<void> {
  return isPostgres() ? pgRateLimit(scope, key, options) : fileRateLimit(scope, key, options);
}
