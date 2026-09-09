/**
 * The small primitives every file in `access/` shares: secure random values,
 * the one denial sentence, email normalisation, and the event envelope.
 *
 * Two rules live here rather than at each call site, because a copy of either
 * one that drifts is a hole:
 *
 *  - **Every access denial says the same thing.** A stranger, a revoked grant
 *    and a viewer who needs `owner` get one message. Anything that told them
 *    apart would answer "does this person have a grant on this app?" for
 *    whoever asked, which is exactly the question a denial must not answer.
 *  - **Nothing here ever writes a subject into an event.** `hosted_events`
 *    stores `subject_hash`; `subjectHashUnchecked()` is the only way this module
 *    produces one.
 *
 * Workstream W5 (hosted R3).
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  APP_ROLE_RANK,
  HostedError,
  type ActorClass,
  type AppRole,
  type HostedApp,
  type HostedEventName,
  type Subject,
} from "@/lib/hosted/contracts";
import { authority, nowIso } from "@/lib/hosted/authority";
import { hostedConfig } from "@/lib/hosted/config";
import { sha256Hex } from "@/lib/hosted/digest";

/** A fresh identifier, the shape every id in the control authority uses. */
export const uuid = (): string => randomUUID();

/** SHA-256 hex — what the token, code and session columns store instead of the value. */
export { sha256Hex };

/**
 * 32 bytes of CSPRNG output as base64url: the invitation token, the exchange
 * code and the app session cookie value. base64url is URL-safe and cookie-safe,
 * so none of the three needs escaping anywhere it travels.
 */
export const secretValue = (): string => randomBytes(32).toString("base64url");

/** ISO-8601 UTC, `ms` from now — the only timestamp format the authority stores. */
export const isoIn = (ms: number): string => nowIso(Date.now() + ms);

export { nowIso };

/* --------------------------------- denials -------------------------------- */

/**
 * The one refusal for every "you may not touch this app" case.
 *
 * Deliberately identical for an unknown app, a stranger, a revoked grant and a
 * grant that is real but too junior. The `min` role is named because the person
 * needs to know what to ask for; nothing else in the sentence varies.
 */
export function accessDenied(min: AppRole): HostedError {
  return new HostedError(
    "forbidden",
    `This needs the ${min} role on this app, and this account does not have it.`,
    {
      fix: `Ask an owner of the app to give you the ${min} role from its access panel. If your access was removed, you need a fresh invitation.`,
      details: { requiredRole: min },
    }
  );
}

/** True when `held` is at least `min` in the owner > editor > viewer order. */
export const roleAtLeast = (held: AppRole, min: AppRole): boolean =>
  APP_ROLE_RANK[held] >= APP_ROLE_RANK[min];

/* ---------------------------------- email --------------------------------- */

/** Lowercase and trimmed. An email is a display value and a match key, never an id. */
export const normalizeEmail = (raw: string): string => raw.trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalise and refuse anything that is not an address, before it is stored. */
export function requireEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (!EMAIL_RE.test(email))
    throw new HostedError("invalid_input", `"${raw}" is not an email address.`, {
      fix: "Give the address the invitation should go to, for example person@example.com.",
    });
  return email;
}

/* ---------------------------------- apps ---------------------------------- */

/**
 * The app, or `not_found`.
 *
 * Callers that are deciding admission must ask `activeGrant` **first**, so an
 * unknown app and an app the caller has no grant on answer alike. This is for
 * the paths that have already passed that check.
 */
export function requireApp(appId: string): HostedApp {
  const app = authority().repos.apps.get(appId);
  if (!app || app.state === "deleted")
    throw new HostedError("not_found", "That app does not exist.", {
      fix: "Check the link, or pick the app from your workspace's app list.",
      details: { appId },
    });
  return app;
}

/** Refuses a suspended or recovering app with the status the gateway contract fixes. */
export function requireAppActive(app: HostedApp): void {
  if (app.state === "active") return;
  if (app.state === "suspended")
    throw new HostedError("suspended", `${app.name} is suspended, so it cannot be opened.`, {
      fix: "An owner can resume the app from its overview; the data is untouched while it is suspended.",
      details: { appId: app.id, reason: app.stateReason },
    });
  if (app.state === "recovering")
    throw new HostedError("recovering", `${app.name} is being recovered, so it cannot be opened yet.`, {
      fix: "Wait for the restore to finish — the app's overview shows its progress — then open it again.",
      details: { appId: app.id, reason: app.stateReason },
    });
  throw new HostedError("not_found", "That app does not exist.", {
    fix: "Check the link, or pick the app from your workspace's app list.",
    details: { appId: app.id },
  });
}

/* --------------------------------- events --------------------------------- */

/**
 * The HMAC `hosted_events.subject_hash` holds.
 *
 * `ZENITH_EVENTS_SALT` is read here and nowhere else in this module. With no
 * salt configured this is still a one-way hash of the subject — never the
 * subject itself — so an install that forgot the salt records a pseudonym
 * rather than an identifier.
 *
 * Not `subjectHash` from `@/lib/hosted/events`: that one returns undefined and
 * warns when the salt is missing, this one always returns a hash.
 */
export const subjectHashUnchecked = (subject: Subject): string =>
  createHmac("sha256", process.env.ZENITH_EVENTS_SALT ?? "").update(subject, "utf8").digest("hex");

/** Founder/test subjects are excluded from activation metrics; everyone else is external. */
export const actorClassOf = (subject: Subject): ActorClass =>
  hostedConfig().founderSubjects.has(subject) ? "founder" : "external";

/** What one access event records. `logicalId` is what makes a retry one row, not two. */
export interface AccessEvent {
  event: HostedEventName;
  workspaceId: string;
  appId?: string;
  subject?: Subject;
  logicalId: string;
  outcome?: "ok" | "error" | "denied";
  props?: Record<string, string | number | boolean>;
}

/**
 * Append one access event. Call inside the transaction that writes the state it
 * describes, so a rolled-back change cannot leave an event claiming it happened.
 */
export function appendAccessEvent(input: AccessEvent): void {
  authority().repos.events.append({
    id: uuid(),
    event: input.event,
    workspaceId: input.workspaceId,
    appId: input.appId,
    subjectHash: input.subject ? subjectHashUnchecked(input.subject) : undefined,
    outcome: input.outcome ?? "ok",
    logicalId: input.logicalId,
    assisted: false,
    actorClass: actorClassOf(input.subject ?? "system"),
    props: input.props,
  });
}
