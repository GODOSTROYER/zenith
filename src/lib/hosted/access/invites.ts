/**
 * Invitations: a hashed, single-use, 48-hour link, and an honest account of
 * what happened when we tried to deliver it.
 *
 * The token is generated once, returned to the owner once, and never stored in
 * clear: `app_invites` keeps its SHA-256, and the only other copy is the
 * AES-GCM sealed payload on the outstanding delivery row, erased the moment
 * that row settles. So "show me the link again" is deliberately impossible —
 * resend, which mints a new token and kills the old one, is the answer.
 *
 * Acceptance is bound to the *verified* address the invitation names. A signed
 * -in caller whose email is unconfirmed, or confirmed but different, is refused
 * with the same sentence: telling those two apart would let anyone with a
 * stolen link enumerate who it was for.
 *
 * The email leaves through the outbox, never inside the transaction: the
 * invitation is durable before the first byte moves, and a crash mid-send
 * leaves a claimable row rather than an invitation nobody knows was half sent.
 *
 * Workstream W5 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import {
  HostedError,
  INVITE_TTL_MS,
  type AppGrant,
  type AppInvite,
  type AppRole,
  type HostedApp,
  type HostedOutboxEntry,
  type InviteDelivery,
  type Subject,
  type VerifiedIdentity,
} from "@/lib/hosted/contracts";
import {
  OUTBOX_LEASE_MS,
  authority,
  drainOutbox,
  registerOutboxHandler,
  type Authority,
} from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import { log } from "@/lib/log";
import {
  appendAccessEvent,
  isoIn,
  normalizeEmail,
  nowIso,
  requireApp,
  requireEmail,
  secretValue,
  sha256Hex,
  subjectHashUnchecked,
  uuid,
} from "./internal";
import { inviteEmailProblem, sendInviteEmail } from "./mail";
import { sealInvite, unsealInvite, type SealedInvite } from "./seal";

/** What an invitation the owner just created looks like. The URL is returned once. */
export interface IssuedInvite {
  invite: AppInvite;
  delivery: InviteDelivery;
  /**
   * The accept link, in clear, for this response only. It is never stored in
   * clear and never returned again — the owner copies it when email is not
   * configured, and otherwise it is only in the message that was sent.
   */
  acceptUrl: string;
}

/** Scope an invitation operation to one app, so an owner of A cannot reach B's invitation. */
export interface InviteScope {
  appId?: string;
}

/** What an accepted invitation produced. */
export interface AcceptedInvite {
  app: HostedApp;
  grant: AppGrant;
}

/** Every invitation on an app, newest first. */
export function listInvites(appId: string): AppInvite[] {
  return authority().repos.invites.listByApp(appId);
}

/** The control-origin URL a recipient opens. The token travels only here and in the email. */
export const inviteAcceptUrl = (token: string): string => {
  const url = new URL("/apps/accept", hostedConfig().ZENITH_CONTROL_ORIGIN);
  url.searchParams.set("token", token);
  return url.toString();
};

/* --------------------------------- create --------------------------------- */

/** What an owner supplies to invite someone. */
export interface NewInviteInput {
  email: string;
  role: AppRole;
}

/**
 * Invite someone to an app.
 *
 * Refuses when that address already has live access (the fix points at the
 * access list, where a role change is the real intent), and supersedes any
 * outstanding invitation for the same address so only one link is ever live.
 */
export function createInvite(appId: string, input: NewInviteInput, by: Subject): IssuedInvite {
  return issueInvite(appId, input, by, {});
}

/**
 * Replace an outstanding invitation with a fresh one.
 *
 * The old token stops working at the same instant the new one starts: both
 * happen in the transaction that writes the replacement.
 */
export function resendInvite(inviteId: string, by: Subject, scope: InviteScope = {}): IssuedInvite {
  const previous = scopedInvite(inviteId, scope);
  if (previous.state !== "pending")
    throw new HostedError(
      "conflict",
      `That invitation is ${previous.state}, so there is nothing outstanding to resend.`,
      {
        fix:
          previous.state === "accepted"
            ? "The person already accepted it — they are in the app's access list."
            : "Send a new invitation instead.",
        details: { inviteId, state: previous.state },
      }
    );
  return issueInvite(
    previous.appId,
    { email: previous.email, role: previous.role },
    by,
    { supersedes: previous.id }
  );
}

/** Withdraw an outstanding invitation. Its link stops working immediately. */
export function revokeInvite(inviteId: string, by: Subject, scope: InviteScope = {}): AppInvite {
  const a = authority();
  const invite = a.tx(() => {
    const current = scopedInvite(inviteId, scope);
    if (!a.repos.invites.setState(inviteId, "revoked"))
      throw new HostedError(
        "conflict",
        `That invitation is ${current.state}, so it cannot be withdrawn.`,
        {
          fix:
            current.state === "accepted"
              ? "Revoke the person's access from the app's access list instead."
              : "It is already no longer usable; reload the invitation list.",
          details: { inviteId, state: current.state },
        }
      );
    return a.repos.invites.get(inviteId) as AppInvite;
  });
  log.info("hosted app invitation revoked", {
    scope: "hosted.access",
    appId: invite.appId,
    inviteId,
    byHash: subjectHashUnchecked(by),
  });
  return invite;
}

/* --------------------------------- accept --------------------------------- */

const UNUSABLE_INVITE = "This invitation link is no longer usable.";
const WRONG_ADDRESS = "This invitation was sent to a different address.";

/**
 * Redeem an invitation as the person the identity provider says is calling.
 *
 * `identity` must come from a live provider check (`verifyRequestIdentity`),
 * never from a claim read out of a cookie: a terminated session that still
 * carries a valid-looking JWT must not be able to accept anything.
 */
export function acceptInvite(token: string, identity: VerifiedIdentity): AcceptedInvite {
  const tokenHash = sha256Hex(token ?? "");
  const email = normalizeEmail(identity.email ?? "");
  const a = authority();

  return a.tx(() => {
    const at = nowIso();
    const invite = a.repos.invites.getByTokenHash(tokenHash);
    // Unknown, revoked, superseded, already accepted and expired are one
    // answer: any difference between them is an oracle over tokens.
    if (!invite || invite.state !== "pending" || invite.expiresAt <= at) throw unusableInvite();

    // Unverified and mismatched are also one answer, for the same reason.
    if (!identity.emailVerified || !email || email !== invite.email)
      throw new HostedError("forbidden", WRONG_ADDRESS, {
        fix: "Sign in as the person the invitation names, with that address confirmed, then open the link again.",
      });

    const app = requireApp(invite.appId);
    if (!a.repos.invites.accept(invite.id, identity.subject, at)) throw unusableInvite();

    // A revoked grant is history, not a seat to reoccupy: acceptance always
    // produces a *new* active row, which is what the partial unique index
    // allows and what keeps the revocation visible.
    const existing = a.repos.grants.activeFor(invite.appId, identity.subject);
    const grant =
      existing ??
      a.repos.grants.insert({
        id: uuid(),
        appId: invite.appId,
        subject: identity.subject,
        email,
        role: invite.role,
        grantedBy: invite.createdBy,
        createdAt: at,
      });

    appendAccessEvent({
      event: "invite.accepted",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: identity.subject,
      logicalId: invite.id,
      props: { role: grant.role, reusedGrant: existing !== null },
    });
    return { app, grant };
  });
}

/* -------------------------------- delivery -------------------------------- */

/** The outbox kind this module owns. */
export const INVITE_EMAIL_KIND = "invite_email" as const;

/**
 * Register the `invite_email` outbox handler. Called by `ensureHosted()`.
 *
 * Idempotent: `registerOutboxHandler` replaces the entry for a kind, so a hot
 * reload or a second boot path leaves exactly one handler registered.
 */
export function registerAccessOutboxHandlers(): void {
  registerOutboxHandler(INVITE_EMAIL_KIND, deliverInviteEmail);
}

/**
 * Nudge the outbox after an invitation has committed.
 *
 * Scheduled rather than awaited, and unref'd, so a slow SMTP server never holds
 * up the response or keeps the process alive — the same shape `ensureHosted`
 * uses for its boot replay. Losing the nudge costs a delay, never the email:
 * the row stays `pending` until some drain picks it up.
 */
export function scheduleInviteDelivery(): void {
  const timer = setTimeout(() => {
    void drainOutbox({ kinds: [INVITE_EMAIL_KIND] }).catch((err) =>
      log.warn("hosted invitation delivery drain failed", { scope: "hosted.access", error: err })
    );
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Perform one queued invitation email.
 *
 * Claim → send → settle, with the claim durable before anything leaves. A
 * failure settles the delivery row with its reason *and* rethrows, so the
 * outbox retries and — after its attempts — records the failure too. Both rows
 * end up saying the same true thing.
 */
async function deliverInviteEmail(entry: HostedOutboxEntry): Promise<void> {
  const inviteId = stringField(entry, "inviteId");
  const deliveryId = stringField(entry, "deliveryId");
  const a = authority();

  const claim = a.tx((db) => claimDelivery(db, deliveryId));
  if (claim.kind === "sent") return;
  if (claim.kind === "missing")
    throw new Error(
      `Invitation delivery ${deliveryId} does not exist, so the email named by outbox entry ${entry.idempotencyKey} cannot be sent.`
    );
  if (claim.kind === "busy")
    throw new Error(
      `Invitation delivery ${deliveryId} is held by another sender, so this attempt did not send anything.`
    );

  const invite = a.repos.invites.get(inviteId);
  if (!invite || invite.state !== "pending") {
    // Not a failure of the transport: the invitation stopped being outstanding
    // before its email went out (revoked, resent, or already accepted).
    settleFailed(
      a,
      deliveryId,
      invite
        ? `The invitation was ${invite.state} before its email was sent, so nothing was sent.`
        : "The invitation this delivery belongs to no longer exists, so nothing was sent."
    );
    return;
  }

  if (!claim.sealedPayload) {
    settleFailed(
      a,
      deliveryId,
      "The sealed invitation payload is gone, so the email cannot be rebuilt. Resend the invitation to mint a new link."
    );
    throw new Error(`Invitation delivery ${deliveryId} has no sealed payload to send.`);
  }

  let payload: SealedInvite;
  try {
    payload = unsealInvite(inviteId, claim.sealedPayload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    settleFailed(a, deliveryId, reason);
    throw err;
  }

  let providerMessageId: string | undefined;
  try {
    providerMessageId = await sendInviteEmail(payload);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    settleFailed(a, deliveryId, reason);
    throw err;
  }

  a.tx(() => {
    a.repos.deliveries.settle(deliveryId, "sent", { transport: "smtp", providerMessageId });
    // The only remaining copy of the token in this database goes now.
    a.repos.deliveries.clearSealedPayload(deliveryId);
  });
}

/* -------------------------------- internals ------------------------------- */

interface IssueOptions {
  supersedes?: string;
}

/** The one path that mints an invitation, used by both create and resend. */
function issueInvite(
  appId: string,
  input: NewInviteInput,
  by: Subject,
  opts: IssueOptions
): IssuedInvite {
  const email = requireEmail(input.email);
  const inviteId = uuid();
  const deliveryId = uuid();
  const token = secretValue();
  const acceptUrl = inviteAcceptUrl(token);
  // Read before the transaction: whether this install can send email is an
  // environment question, and the answer decides whether the delivery row is
  // born queued or born settled.
  const problem = inviteEmailProblem();
  const a = authority();

  const issued = a.tx((db) => {
    const app = requireApp(appId);

    const held = a.repos.grants
      .listByApp(appId, { activeOnly: true })
      .find((grant) => grant.email === email);
    if (held)
      throw new HostedError("conflict", `${email} already has access to ${app.name}.`, {
        fix: `Change their role or revoke their access from the app's access list; an invitation would give them a second seat they do not need.`,
        details: { grantId: held.id, role: held.role },
      });

    // Only one link per address is ever live.
    for (const outstanding of a.repos.invites.listByApp(appId, { state: "pending" }))
      if (outstanding.email === email) a.repos.invites.supersede(outstanding.id);

    const invite = a.repos.invites.insert({
      id: inviteId,
      appId,
      email,
      role: input.role,
      tokenHash: sha256Hex(token),
      createdBy: by,
      expiresAt: isoIn(INVITE_TTL_MS),
      supersedes: opts.supersedes,
    });

    const sealed = problem
      ? null
      : sealInvite(inviteId, { token, email, appName: app.name, acceptUrl });
    const queued = a.repos.deliveries.insert({
      id: deliveryId,
      inviteId,
      sealedPayload: sealed,
    });

    let delivery = queued;
    if (problem) {
      // Nothing to attempt, so the row is settled here rather than queued for
      // an effect this install cannot perform. The owner still has the link.
      markUndeliverable(db, deliveryId, problem);
      delivery = a.repos.deliveries.get(deliveryId) ?? queued;
    } else {
      a.repos.outbox.enqueue({
        id: uuid(),
        idempotencyKey: `invite:${inviteId}:${deliveryId}`,
        kind: INVITE_EMAIL_KIND,
        payload: { inviteId, deliveryId },
      });
    }

    appendAccessEvent({
      event: "invite.sent",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: by,
      logicalId: inviteId,
      props: { role: input.role, queued: !problem, resend: opts.supersedes !== undefined },
    });
    return { invite, delivery };
  });

  return { invite: issued.invite, delivery: issued.delivery, acceptUrl };
}

/** The invitation, checked against the app the caller reached it through. */
function scopedInvite(inviteId: string, scope: InviteScope): AppInvite {
  const invite = authority().repos.invites.get(inviteId);
  if (!invite || (scope.appId !== undefined && invite.appId !== scope.appId))
    throw new HostedError("not_found", "That invitation does not exist on this app.", {
      fix: "Reload the app's access panel — the list you are looking at may be out of date.",
      details: { inviteId },
    });
  return invite;
}

const unusableInvite = (): HostedError =>
  new HostedError("conflict", UNUSABLE_INVITE, {
    fix: "Ask an owner of the app to send you a new invitation — links work once and expire after 48 hours.",
  });

/** One typed field of an outbox payload, or a failure that says which one is missing. */
function stringField(entry: HostedOutboxEntry, key: string): string {
  const value = entry.payload[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Outbox entry ${entry.idempotencyKey} has no "${key}" to deliver against.`);
  return value;
}

type DeliveryClaim =
  | { kind: "claimed"; sealedPayload: Uint8Array | null }
  | { kind: "sent" }
  | { kind: "busy" }
  | { kind: "missing" };

/**
 * Take one delivery row, by id, and make the claim durable before anything is
 * sent.
 *
 * Targeted rather than `claimPending`, which claims the whole queue: this
 * handler is invoked once per outbox row and must own exactly the row that row
 * names. A `failed` row is claimable again — that is what makes the outbox's
 * retries reach the transport — while a `sent` row never is.
 */
function claimDelivery(db: DatabaseSync, deliveryId: string): DeliveryClaim {
  const at = nowIso();
  const staleBefore = nowIso(Date.parse(at) - OUTBOX_LEASE_MS);
  const rows = db
    .prepare(
      "UPDATE invite_deliveries SET state = 'sending', claimed_at = ?, attempts = attempts + 1 " +
        "WHERE id = ? AND (state IN ('pending','failed') " +
        "OR (state = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?))) " +
        "RETURNING sealed_payload"
    )
    .all(at, deliveryId, staleBefore);
  if (rows.length === 1) {
    const raw = rows[0].sealed_payload;
    return { kind: "claimed", sealedPayload: raw instanceof Uint8Array ? raw : null };
  }
  const existing = db
    .prepare("SELECT state FROM invite_deliveries WHERE id = ?")
    .get(deliveryId);
  if (!existing) return { kind: "missing" };
  return existing.state === "sent" ? { kind: "sent" } : { kind: "busy" };
}

/** Settle a claimed row `failed`, with the reason on the row. Its own transaction. */
function settleFailed(a: Authority, deliveryId: string, error: string): void {
  a.tx(() => a.repos.deliveries.settle(deliveryId, "failed", { error: error.slice(0, 2000) }));
}

/**
 * Record a delivery that was never attempted because this install has no
 * transport.
 *
 * Written as SQL rather than through `deliveries.settle` for two reasons: the
 * row is `pending` (settle only moves a `sending` row), and the contract's
 * `transport: "none"` — "no transport configured: the owner must share the link
 * by hand" — is a value the v1 CHECK constraint on that column does not list.
 * Until the migration requested of the integrator lands, the column is left
 * NULL on a settled row, which says the same thing: no transport was used. The
 * reason, naming the variable to set, is always on the row either way.
 */
function markUndeliverable(db: DatabaseSync, deliveryId: string, reason: string): void {
  db.prepare(
    "UPDATE invite_deliveries SET state = 'failed', settled_at = ?, claimed_at = NULL, " +
      "transport = ?, error = ? WHERE id = ? AND state = 'pending'"
  ).run(nowIso(), noTransportValue(db), reason.slice(0, 2000), deliveryId);
}

const noneSupported = new WeakMap<DatabaseSync, boolean>();

/** `"none"` where the schema accepts it, SQL NULL where it does not. */
function noTransportValue(db: DatabaseSync): string | null {
  let supported = noneSupported.get(db);
  if (supported === undefined) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invite_deliveries'")
      .get();
    const ddl = typeof row?.sql === "string" ? row.sql : "";
    supported = /transport[\s\S]*?'none'/.test(ddl);
    noneSupported.set(db, supported);
  }
  return supported ? "none" : null;
}
