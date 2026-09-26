/**
 * The credential authority — the one interface both storage backends answer.
 *
 * Zenith issues its own agent credentials. Where the rows live depends on which
 * product store this install runs (`isPostgres()`, `src/lib/db/store.ts:67`):
 * a private POSIX file on a single long-lived host, or `agent.*` on Supabase
 * Postgres when the product store is Postgres. One selector, because a linked
 * credential names a `subject` that has to be a live member row, and membership
 * lives in the product store — a Vercel instance authenticating against its own
 * `/tmp` file that no other instance has ever seen is the bug this prevents.
 *
 * This file is a frozen contract (WORK-GRAPH-2 F1). Nothing here may change
 * without the integrator: P2's capability probe and P3's two transports both
 * code against it.
 */
import type { Credential } from "../security";

/** What `/api/agent/link/start` puts in the store. Both codes arrive hashed. */
export interface LinkStart {
  userCodeHash: string;
  deviceCodeHash: string;
  clientName: string;
  clientVersion?: string;
  label?: string;
  requestedScopes: string[];
  createdAt: string;
  expiresAt: string;
}

/** One link request, as the approval screen is allowed to see it. */
export interface LinkRow {
  /**
   * The display form — never the hash.
   *
   * Both stores keep only `sha256(code)`, so neither can recover it: an
   * implementation answers `''` here and the caller, which looked the row up
   * with the plaintext, echoes the code it already has. A store that ever does
   * hold the display form may fill it in; nothing reads it as authority.
   */
  userCode: string;
  state: "pending" | "approved" | "denied" | "consumed" | "expired";
  clientName: string;
  clientVersion?: string;
  label?: string;
  requestedScopes: string[];
  createdAt: string;
  expiresAt: string;
  credentialId?: string;
}

/** A credential and the secret that opens it. Only `/token` ever sees this. */
export interface IssuedCredential {
  credential: Credential;
  token: string;
}

/**
 * A credential as the Integrations screen lists it.
 *
 * Every `LinkedCredential` is a `Credential`, so `listCredentials` refining its
 * return type to this adds the columns the screen needs (F9) without changing
 * what F1 promises. `tokenHash` is `''` on every row this returns: the
 * authority strips it before the record leaves the module.
 */
export interface LinkedCredential extends Credential {
  clientVersion?: string;
  lastUsedAt?: string;
}

/** Everything the approval handler decided, after it rechecked all of it. */
export interface ApproveLinkInput {
  /** sha256 of the normalized user code. */
  userCodeHash: string;
  /** The signed-in member. In phase 1 this is also the credential's subject. */
  subject: string;
  workspaceId: string;
  projectIds: string[];
  environmentIds?: string[];
  scopes: Credential["scopes"];
  /** 1..30. The ceiling is enforced here and again by `parseCredentials`. */
  days: number;
  label?: string;
  now?: number;
}

/**
 * What one poll of `/api/agent/link/token` found.
 *
 * The pacing lives here rather than in the route because `poll_count` and
 * `last_polled_at` are columns on the row being exchanged: one statement reads
 * the state, records the poll and decides whether this caller is early.
 */
export type ExchangeResult =
  | { status: "issued"; credential: Credential; token: string }
  | { status: "authorization_pending"; interval: number }
  | { status: "slow_down"; interval: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unknown" };

export interface CredentialAuthority {
  readonly kind: "file" | "postgres";

  /**
   * Fail-closed capability probe. Resolves when this authority can actually be
   * read and written; throws `AgentError('policy_unavailable', …, 503)`
   * otherwise. Callers on the link surface translate that to
   * `link_unavailable`; the reader translates it to its own refusal.
   */
  ready(): Promise<void>;

  /** Bearer header -> Credential, or throw `AgentError('unauthorized', …, 401)`. */
  verify(authorizationHeader: string | null, now?: number): Promise<Credential>;

  /**
   * Best-effort `last_used_at`. Never on the authorization path, never awaited
   * by it, and a failure is swallowed: a diagnostics write must not be able to
   * deny a request.
   */
  touch(credentialId: string, at: string): Promise<void>;

  startLink(start: LinkStart): Promise<void>;
  linkByUserCode(userCodeHash: string, now?: number): Promise<LinkRow | undefined>;
  approveLink(input: ApproveLinkInput): Promise<{ credentialId: string; expiresAt: string }>;
  denyLink(userCodeHash: string, subject: string): Promise<boolean>;
  /** Admission runs before consuming an approved code; failures leave it retryable. */
  exchange(deviceCodeHash: string, now?: number, admit?: (subject: string) => Promise<void>): Promise<ExchangeResult>;

  listCredentials(subject: string, workspaceId: string): Promise<LinkedCredential[]>;
  /**
   * `subject` is `null` for a workspace admin revoking another member's
   * credential; the statement drops the subject predicate in that case only.
   */
  revokeCredential(
    subject: string | null,
    workspaceId: string,
    credentialId: string
  ): Promise<boolean>;

  /** Bounded housekeeping for the tick route. Returns rows moved to `expired`. */
  expireLinks(now?: number): Promise<number>;
}
