/**
 * Small helpers shared by the broker modules. Not part of the public surface.
 */
import type { Principal } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "./errors";
import type { BrokerDeps, ResolvedAccess } from "./ports";
import type { BrowserSessionProof } from "./types";

export function defaultNewId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

export const newId = (deps: BrokerDeps, prefix: string): string => (deps.newId ?? defaultNewId)(prefix);

/** The principal's current access in the workspace; a non-member gets the same answer as a foreign id. */
export async function memberAccess(deps: BrokerDeps, principal: Principal, workspaceId: string): Promise<ResolvedAccess> {
  const access = await deps.roles.resolve(principal, workspaceId);
  if (access.role === "none") throw notFound();
  return access;
}

/**
 * The actor must be a plain human user and the session proof must be theirs.
 * `what` completes "Only a signed-in person can …" in the message.
 */
export function requireHumanSession(actor: Principal, session: BrowserSessionProof | undefined, what: string): void {
  if (actor.kind !== "user" || actor.onBehalfOf !== undefined || actor.integrationId !== undefined) {
    throw new BrokerError("approver_not_human", `Only a signed-in person can ${what}. Agents, integrations and the Navigator never can.`, undefined, {
      principalKind: actor.kind,
    });
  }
  if (!session || session.method !== "browser_session" || session.subject !== actor.id) {
    throw new BrokerError("browser_session_required", `Use the signed-in Zenith browser interface to ${what}.`, "Sign in and repeat this from the Zenith web app.");
  }
}

/** The human accountable for a principal's requests: the user themself, or whoever an agent acts for. */
export const requesterOf = (principal: Principal): string => principal.onBehalfOf ?? principal.id;

export const iso = (d: Date): string => d.toISOString();
