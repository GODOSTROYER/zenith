/**
 * Custom-domain claim, verification, renewal and revocation (PROD-MAN-03), over the platform store and a DNS port.
 *
 * Callers: the REST routes under `/api/platform/v1/environments/:id/domains` (a person in the browser), and the durable
 * `domain-renewal` critical job (`renewalPass`). Both use the same functions, so a renewal is exactly a re-verification.
 *
 * What a caller can learn: the challenge TXT record (once, at claim time) and the state of its OWN claims. A hostname that
 * another workspace has verified is reported only as "not available".
 */
import { ControlStoreError } from "@/lib/controlplane/db";
import { repos } from "@/lib/controlplane/db";
import type { ManagedDomain } from "@/lib/controlplane/db/repos/managed-serving";
import type { Sql } from "@/lib/controlplane/types";
import {
  GRACE_MS, MAX_DOMAINS_PER_ENVIRONMENT, PENDING_TTL_MS, RENEWAL_WINDOW_MS,
  checkCustomHostname, decideDomainTransition, describeDomain, newChallenge, verifyChallenge, type DomainDecision, type DomainDnsPort, type VerificationResult,
} from "./domains";

export class ManagedDomainError extends Error {
  constructor(readonly code: "invalid_hostname" | "managed_suffix" | "reserved_hostname" | "unavailable" | "limit_reached" | "not_found" | "challenge_expired" | "revoked" | "stale", message: string) {
    super(message);
    this.name = "ManagedDomainError";
  }
}

export interface DomainServiceDeps {
  sql: Sql;
  dns: DomainDnsPort;
  /** the platform's own app domain; hosts under it are never claimable */
  baseDomain: string;
  clock?: () => Date;
}

export interface DomainView {
  id: string;
  environmentId: string;
  hostname: string;
  status: ManagedDomain["status"];
  /** what the claim means now: pending, serving, renewal_due, in_grace, lapsed, revoked */
  state: ReturnType<typeof describeDomain>;
  verifiedAt: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  lastOutcome: ManagedDomain["lastOutcome"];
  failureCount: number;
  challengeRecord: string;
}

const now = (deps: DomainServiceDeps): Date => (deps.clock ? deps.clock() : new Date());
const recordName = (host: string): string => `_zenith-challenge.${host}`;

export function domainView(d: ManagedDomain, at: Date): DomainView {
  return {
    id: d.id, environmentId: d.environmentId, hostname: d.hostname, status: d.status, state: describeDomain(d.status, d.expiresAt, at), verifiedAt: d.verifiedAt, expiresAt: d.expiresAt,
    lastCheckedAt: d.lastCheckedAt, lastOutcome: d.lastOutcome, failureCount: d.failureCount, challengeRecord: recordName(d.hostname),
  };
}

export interface ClaimAnswer {
  outcome: "created" | "reissued" | "already_verified";
  domain: DomainView;
  /** present when a challenge was issued; shown once and never recoverable */
  challenge?: { recordName: string; recordType: "TXT"; recordValue: string; note: string };
}

export async function claimCustomDomain(deps: DomainServiceDeps, input: { workspaceId: string; environmentId: string; hostname: string; requestedBy: string }): Promise<ClaimAnswer> {
  const checked = checkCustomHostname(input.hostname, deps.baseDomain);
  if (!checked.ok) throw new ManagedDomainError(checked.code, checked.reason);
  const at = now(deps);
  const challenge = newChallenge(checked.hostname);
  try {
    const claimed = await repos.managedServing.claimDomain(deps.sql, {
      workspaceId: input.workspaceId, environmentId: input.environmentId, hostname: checked.hostname, challengeHash: challenge.hash, requestedBy: input.requestedBy,
      maxLive: MAX_DOMAINS_PER_ENVIRONMENT, pendingTtlMs: PENDING_TTL_MS, now: at,
    });
    return {
      outcome: claimed.outcome,
      domain: domainView(claimed.domain, at),
      ...(claimed.outcome === "already_verified" ? {} : {
        challenge: {
          recordName: challenge.recordName, recordType: challenge.recordType, recordValue: challenge.recordValue,
          note: "Publish this TXT record at your DNS provider, then ask Zenith to verify. The value is shown only now; claim again to get a new one. The record must stay in place: Zenith re-checks it before each renewal.",
        },
      }),
    };
  } catch (error) {
    if (error instanceof ControlStoreError && error.code === "conflict") throw new ManagedDomainError("unavailable", "That hostname is not available to claim.");
    if (error instanceof ControlStoreError && error.code === "value_out_of_range") throw new ManagedDomainError("limit_reached", error.message);
    throw error;
  }
}

export interface VerifyAnswer {
  domain: DomainView;
  verification: VerificationResult;
  change: DomainDecision["change"];
}

/** Check the challenge record now and apply the outcome. Used for first proof, manual re-proof of a lapsed claim, and renewal. */
export async function verifyCustomDomain(deps: DomainServiceDeps, input: { workspaceId: string; id: string }): Promise<VerifyAnswer> {
  const row = await repos.managedServing.getDomainForVerification(deps.sql, input.workspaceId, input.id);
  if (!row) throw new ManagedDomainError("not_found", "No such domain claim.");
  if (row.status === "revoked") throw new ManagedDomainError("revoked", "This claim was revoked; claim the domain again.");
  const at = now(deps);
  if (row.status === "pending" && at.getTime() - Date.parse(row.challengeIssuedAt) > PENDING_TTL_MS) {
    throw new ManagedDomainError("challenge_expired", "This challenge has expired; claim the domain again to get a new one.");
  }
  const verification = await verifyChallenge(row.hostname, row.challengeHash, deps.dns);
  const decision = decideDomainTransition({ status: row.status, expiresAt: row.expiresAt ? new Date(row.expiresAt) : null, failureCount: row.failureCount }, verification.outcome, at);
  if (!decision) throw new ManagedDomainError("revoked", "This claim was revoked; claim the domain again.");
  let saved: ManagedDomain | null;
  try {
    saved = await repos.managedServing.applyDomainTransition(deps.sql, input.workspaceId, input.id, {
      expect: row.status, status: decision.status, outcome: decision.outcome, checkedAt: at, verifiedAt: decision.verifiedAt, expiresAt: decision.expiresAt,
      failureCount: decision.failureCount, lapsedAt: decision.lapsedAt,
    });
  } catch (error) {
    if (error instanceof ControlStoreError && error.code === "conflict") throw new ManagedDomainError("unavailable", "That hostname is not available to claim.");
    throw error;
  }
  if (!saved) throw new ManagedDomainError("stale", "The claim changed while it was being checked; read it again.");
  return { domain: domainView(saved, at), verification, change: decision.change };
}

export async function listCustomDomains(deps: DomainServiceDeps, input: { workspaceId: string; environmentId: string }): Promise<DomainView[]> {
  const at = now(deps);
  return (await repos.managedServing.listDomains(deps.sql, input.workspaceId, input.environmentId)).map((d) => domainView(d, at));
}

export async function revokeCustomDomain(deps: DomainServiceDeps, input: { workspaceId: string; id: string; by: string }): Promise<DomainView> {
  const at = now(deps);
  const revoked = await repos.managedServing.revokeDomain(deps.sql, input.workspaceId, input.id, input.by, at);
  if (!revoked) throw new ManagedDomainError("not_found", "No such claim, or it was already revoked.");
  return domainView(revoked, at);
}

/** The hostnames the render step may serve for an environment (verified and inside proof plus grace). */
export async function servedCustomHostnames(deps: Pick<DomainServiceDeps, "sql" | "clock">, workspaceId: string, environmentId: string): Promise<string[]> {
  return repos.managedServing.verifiedHostnames(deps.sql, workspaceId, environmentId, { now: deps.clock ? deps.clock() : new Date(), graceMs: GRACE_MS });
}

export interface RenewalResult {
  due: number;
  renewed: number;
  failing: number;
  lapsed: number;
  uncertain: number;
  conflicts: number;
}

/**
 * One bounded renewal pass over every workspace: re-verify each claim whose proof expires within the renewal window (or already
 * has). Level-triggered and idempotent, so a missed tick or a restart only delays work. DNS is the only external call and each
 * lookup has its own timeout; the pass also stops at `budgetMs`.
 */
export async function renewalPass(deps: DomainServiceDeps, opts: { budgetMs?: number; limit?: number; signal?: AbortSignal } = {}): Promise<RenewalResult> {
  const result: RenewalResult = { due: 0, renewed: 0, failing: 0, lapsed: 0, uncertain: 0, conflicts: 0 };
  const started = Date.now();
  const budget = opts.budgetMs ?? 15_000;
  const due = await repos.managedServing.listDomainsDue(deps.sql, { now: now(deps), windowMs: RENEWAL_WINDOW_MS, limit: opts.limit ?? 50 });
  result.due = due.length;
  for (const row of due) {
    opts.signal?.throwIfAborted();
    if (Date.now() - started > budget) break;
    try {
      const r = await verifyCustomDomain(deps, { workspaceId: row.workspaceId, id: row.id });
      if (r.change === "renewed") result.renewed++;
      else if (r.change === "lapsed") result.lapsed++;
      else if (r.change === "renewal_failing" || r.change === "unchanged") result.failing++;
      if (r.verification.outcome === "uncertain") result.uncertain++;
    } catch (error) {
      if (error instanceof ManagedDomainError && (error.code === "stale" || error.code === "unavailable")) result.conflicts++;
      else if (error instanceof ManagedDomainError) continue;
      else throw error;
    }
  }
  return result;
}
