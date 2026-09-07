/**
 * App access — grants, invitations, exchanges and app sessions.
 *
 * STUB written by the integrator so sibling workstreams compile against the
 * agreed signatures. Workstream W5 replaces this file; every function below
 * must keep its signature. Until then each call refuses with
 * `policy_unavailable`, never a pass.
 */
import type { NextRequest } from "next/server";
import {
  HostedError,
  type AppGrant,
  type AppRole,
  type AppSession,
  type Subject,
  type VerifiedIdentity,
} from "@/lib/hosted/contracts";

const pending = (): never => {
  throw new HostedError("policy_unavailable", "App access is not available in this build.", {
    fix: "Workstream W5 (src/lib/hosted/access) has not landed; do not serve private apps from this build.",
  });
};

/** The caller's active grant at or above `min`, or `forbidden`. */
export function requireAppRole(appId: string, subject: Subject, min: AppRole): AppGrant {
  void appId;
  void subject;
  void min;
  return pending();
}

export function activeGrant(appId: string, subject: Subject): AppGrant | null {
  void appId;
  void subject;
  return pending();
}

/** Live session + live grant for a cookie value on this app, or null. Never cached. */
export function resolveAppSession(
  cookieValue: string,
  appId: string
): { session: AppSession; grant: AppGrant } | null {
  void cookieValue;
  void appId;
  return pending();
}

/** Atomic single-use redemption; throws `sign_in_required`/`forbidden`. */
export function redeemExchange(
  code: string,
  opts: { appId: string; state: string }
): { cookieValue: string; session: AppSession; grant: AppGrant } {
  void code;
  void opts;
  return pending();
}

/** Control side: mint a single-use code for an active grant; returns the app-host callback URL. */
export function createExchange(appId: string, subject: Subject, state: string): { redirect: string } {
  void appId;
  void subject;
  void state;
  return pending();
}

export function terminateAppSession(
  cookieValue: string,
  reason: NonNullable<AppSession["terminatedReason"]>
): boolean {
  void cookieValue;
  void reason;
  return pending();
}

export function terminateAppSessionsForSubject(
  subject: Subject,
  reason: NonNullable<AppSession["terminatedReason"]>
): number {
  void subject;
  void reason;
  return pending();
}

/** `Set-Cookie` header value for the `__Host-zenith_app` cookie. */
export function appSessionCookie(value: string, expiresAt: string): string {
  void value;
  void expiresAt;
  return pending();
}

export function clearAppSessionCookie(): string {
  return pending();
}

/** Live identity check against the provider (getUser), never a bare claim read. */
export async function verifyRequestIdentity(req: NextRequest): Promise<VerifiedIdentity> {
  void req;
  return pending();
}

/** Registers the `invite_email` outbox handler. Called by `ensureHosted()`. */
export function registerAccessOutboxHandlers(): void {}
