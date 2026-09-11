/**
 * App grants: who may open a hosted app, in what role, and what it takes to
 * remove them.
 *
 * The rule PLAN-R3 R3-02 turns on: `app_grants` is the *only* authority. No
 * workspace membership, no `app_metadata` claim and no cached copy adds,
 * restores or upgrades access here. That is what makes a revoke stick.
 *
 * Two invariants this file exists to hold:
 *
 *  - **An app never loses its last owner.** Demoting or revoking the only
 *    active owner is refused, and the count is read inside the same transaction
 *    as the write — a check outside it would be a race with the other owner's
 *    revoke, and the loser is an app nobody can administer.
 *  - **A revoke is one transaction.** State change, session termination,
 *    revocation-ledger append, outbox row and event commit together or not at
 *    all. Anything else can leave a grant marked revoked whose sessions are
 *    still serving pages.
 */
import {
  HostedError,
  type AppGrant,
  type AppRole,
  type RevocationLedgerEntry,
  type Subject,
} from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { log } from "@/lib/log";
import {
  accessDenied,
  appendAccessEvent,
  requireApp,
  requireEmail,
  roleAtLeast,
  subjectHashUnchecked,
  uuid,
} from "./internal";

/** Scope a grant operation to one app, so an owner of A cannot reach a grant on B. */
export interface GrantScope {
  /** When given, the grant must belong to this app or the call answers `not_found`. */
  appId?: string;
}

/** What a completed revoke wrote, all of it committed together. */
export interface RevokedGrant {
  grant: AppGrant;
  revocation: RevocationLedgerEntry;
  /** Live app sessions that ended with the grant. */
  sessionsTerminated: number;
}

/* --------------------------------- reads ---------------------------------- */

/**
 * The caller's one live grant on this app, or null. The admission read: never
 * cached, because a grant revoked a second ago must stop the next request.
 */
export function activeGrant(appId: string, subject: Subject): AppGrant | null {
  return authority().repos.grants.activeFor(appId, subject);
}

/**
 * The caller's active grant at or above `min`, or `forbidden`.
 *
 * A stranger, a revoked grant, an unknown app and a role that is too junior all
 * get the identical message — see `accessDenied`.
 */
export function requireAppRole(appId: string, subject: Subject, min: AppRole): AppGrant {
  const grant = activeGrant(appId, subject);
  if (!grant || !roleAtLeast(grant.role, min)) throw accessDenied(min);
  return grant;
}

/** Every grant on an app, newest first, revoked ones included — this is the history. */
export function listGrants(appId: string): AppGrant[] {
  return authority().repos.grants.listByApp(appId);
}

/* -------------------------------- mutations ------------------------------- */

/** What a direct grant needs. `subject` must be a platform user id, not an email. */
export interface DirectGrant {
  subject: Subject;
  email: string;
  role: AppRole;
}

/**
 * Grant access to someone who already has a platform account.
 *
 * Whether the caller may do this is the route's check (`requireAppRole` at
 * `owner`); what this refuses is a second live grant for the same person, which
 * the partial unique index would reject anyway — answered here as a `conflict`
 * that says what to do instead.
 */
export function grantDirect(appId: string, input: DirectGrant, by: Subject): AppGrant {
  const email = requireEmail(input.email);
  const subject = input.subject.trim();
  if (!subject)
    throw new HostedError("invalid_input", "A direct grant needs the person's platform user id.", {
      fix: "Send an invitation instead — it works for someone who has not signed in here yet.",
    });

  const a = authority();
  return a.tx(() => {
    const app = requireApp(appId);
    const existing = a.repos.grants.activeFor(appId, subject);
    if (existing)
      throw new HostedError(
        "conflict",
        `That person already has ${existing.role} access to ${app.name}.`,
        {
          fix: `Change their role instead of granting again, or revoke the existing ${existing.role} access first.`,
          details: { grantId: existing.id, role: existing.role },
        }
      );
    const byEmail = a.repos.grants
      .listByApp(appId, { activeOnly: true })
      .find((grant) => grant.email === email);
    if (byEmail)
      throw new HostedError("conflict", `${email} already has access to ${app.name}.`, {
        fix: "Change that person's role instead, or revoke their access first.",
        details: { grantId: byEmail.id, role: byEmail.role },
      });
    return a.repos.grants.insert({
      id: uuid(),
      appId,
      subject,
      email,
      role: input.role,
      grantedBy: by,
    });
  });
}

/**
 * Change a live grant's role.
 *
 * The last active owner cannot be demoted: the check and the write are one
 * transaction, so two owners demoting each other at the same instant cannot
 * both succeed.
 */
export function changeGrantRole(
  grantId: string,
  role: AppRole,
  by: Subject,
  scope: GrantScope = {}
): AppGrant {
  const a = authority();
  const grant = a.tx(() => {
    const current = scopedGrant(grantId, scope);
    if (current.state !== "active")
      throw new HostedError("conflict", "That access is no longer active, so its role cannot change.", {
        fix: "Send a fresh invitation, or grant access again with the role you want.",
        details: { grantId, state: current.state },
      });
    if (current.role === role) return current;
    refuseLastOwnerChange(current, role);
    if (!a.repos.grants.setRole(grantId, role))
      throw new HostedError("conflict", "That access changed while this request was in flight.", {
        fix: "Reload the app's access panel and try again.",
        details: { grantId },
      });
    return a.repos.grants.get(grantId) as AppGrant;
  });
  // No event name covers a role change (HOSTED_EVENTS has none), so the audit
  // line goes to the server log — with the actor as a hash, the same rule the
  // events table follows.
  log.info("hosted app grant role changed", {
    scope: "hosted.access",
    appId: grant.appId,
    grantId,
    role,
    byHash: subjectHashUnchecked(by),
  });
  return grant;
}

/**
 * Revoke a grant, end its sessions, record it in the off-host ledger and queue
 * the ledger copy — in one transaction, returning only after it committed.
 *
 * The outbox row is what carries the revocation off this host, so a restore
 * from an older backup can re-apply it (G23). Its idempotency key includes the
 * ledger sequence, so a replay after a crash is one effect, not two.
 */
export function revokeGrant(
  grantId: string,
  by: Subject,
  reason?: string,
  scope: GrantScope = {}
): RevokedGrant {
  const why = (reason ?? "").trim() || "access removed by an owner";
  const a = authority();
  return a.tx(() => {
    const current = scopedGrant(grantId, scope);
    if (current.state === "revoked")
      throw new HostedError("conflict", "That access was already revoked.", {
        fix: "Nothing more to do — the person's sessions ended when it was revoked. Reload the access panel to see the current list.",
        details: { grantId, revokedAt: current.revokedAt },
      });
    refuseLastOwnerChange(current, null);

    const app = requireApp(current.appId);
    const grant = a.repos.grants.revoke(grantId, by, why);
    if (!grant || grant.state !== "revoked")
      throw new HostedError("conflict", "That access changed while this request was in flight.", {
        fix: "Reload the app's access panel and try again.",
        details: { grantId },
      });

    const sessionsTerminated = a.repos.sessions.terminateByGrant(grantId, "revoked");
    const revocation = a.repos.revocations.append({
      appId: grant.appId,
      grantId,
      subject: grant.subject,
      by,
      reason: why,
    });
    a.repos.outbox.enqueue({
      id: uuid(),
      idempotencyKey: `revocation:${grantId}:${revocation.seq}`,
      kind: "revocation_ledger",
      // Built field by field rather than spread: the payload column is JSON and
      // an interface carries no index signature.
      payload: {
        seq: revocation.seq,
        at: revocation.at,
        appId: revocation.appId,
        grantId: revocation.grantId,
        subject: revocation.subject,
        by: revocation.by,
        reason: revocation.reason,
      },
    });
    appendAccessEvent({
      event: "grant.revoked",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: grant.subject,
      logicalId: grantId,
      props: { role: grant.role, sessionsTerminated },
    });
    return { grant, revocation, sessionsTerminated };
  });
}

/* -------------------------------- internals ------------------------------- */

/** The grant, checked against the app the caller reached it through. */
function scopedGrant(grantId: string, scope: GrantScope): AppGrant {
  const grant = authority().repos.grants.get(grantId);
  // A grant on another app answers exactly as an unknown one: an owner of one
  // app must not be able to discover ids belonging to another.
  if (!grant || (scope.appId !== undefined && grant.appId !== scope.appId))
    throw new HostedError("not_found", "That access record does not exist on this app.", {
      fix: "Reload the app's access panel — the list you are looking at may be out of date.",
      details: { grantId },
    });
  return grant;
}

/**
 * Refuse the change that would leave an app with no owner. `nextRole` is null
 * for a revoke.
 *
 * Called inside the transaction that does the write, never before it.
 */
function refuseLastOwnerChange(grant: AppGrant, nextRole: AppRole | null): void {
  if (grant.state !== "active" || grant.role !== "owner") return;
  if (nextRole === "owner") return;
  if (authority().repos.grants.countActiveOwners(grant.appId) > 1) return;
  throw new HostedError(
    "conflict",
    nextRole === null
      ? "This is the app's only owner, so removing it would leave the app with nobody who can administer it."
      : "This is the app's only owner, so it cannot be given a lesser role.",
    {
      fix: "Give someone else the owner role first, then make this change.",
      details: { grantId: grant.id, appId: grant.appId },
    }
  );
}
