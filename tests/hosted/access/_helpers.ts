/**
 * Fixtures shared by the access tests: the two apps, the four identities, and
 * the smallest legal rows their foreign keys demand.
 *
 * Nothing here stubs the authority. Every helper writes through the real
 * repositories, inside a real transaction, against a real SQLite file in an
 * isolated data directory.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AppRole, VerifiedIdentity } from "@/lib/hosted/contracts";
import type { Authority } from "@/lib/hosted/authority";
import { APPS, IDENTITIES, WORKSPACES, type TestIdentity } from "../_fixtures";

export { APPS, IDENTITIES, WORKSPACES };

/** A fresh id, the shape every id in the authority uses. */
export const uuid = (): string => randomUUID();

/** SHA-256 hex — what the token, code and session columns store instead of the value. */
export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** An ISO timestamp offset from now, for expiry and lease boundaries. */
export const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** Insert one of the fixture apps (or a named one) and answer with it. */
export function seedApp(
  a: Authority,
  opts: { slug?: string; name?: string; workspaceId?: string; createdBy?: string } = {}
) {
  const slug = opts.slug ?? APPS.alpha.slug;
  return a.tx((repos) =>
    repos.apps.insert({
      id: uuid(),
      workspaceId: opts.workspaceId ?? WORKSPACES.one.id,
      slug,
      name: opts.name ?? `App ${slug}`,
      createdBy: opts.createdBy ?? IDENTITIES.owner.subject,
      runtime: "local",
    })
  );
}

/** Insert an active grant for one of the fixture identities. */
export function seedGrant(
  a: Authority,
  appId: string,
  who: TestIdentity,
  role: AppRole = "viewer",
  grantedBy = IDENTITIES.owner.subject
) {
  return a.tx((repos) =>
    repos.grants.insert({
      id: uuid(),
      appId,
      subject: who.subject,
      email: who.email,
      role,
      grantedBy,
    })
  );
}

/** Open a session directly, for the paths that need one to already exist. */
export async function seedSession(
  a: Authority,
  appId: string,
  who: TestIdentity,
  grantId: string,
  expiresAt = iso(3_600_000)
): Promise<{ cookieValue: string; id: string }> {
  const cookieValue = `test-${uuid()}`;
  const id = sha256Hex(cookieValue);
  await a.tx((repos) =>
    repos.sessions.insert({ id, appId, subject: who.subject, grantId, expiresAt })
  );
  return { cookieValue, id };
}

/** What a live provider check would answer for one of the fixture identities. */
export const verified = (
  who: TestIdentity,
  opts: { emailVerified?: boolean; email?: string } = {}
): VerifiedIdentity => ({
  subject: who.subject,
  email: (opts.email ?? who.email).toLowerCase(),
  emailVerified: opts.emailVerified ?? true,
  sessionId: `session-${who.subject.slice(0, 8)}`,
});
