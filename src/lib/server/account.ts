/**
 * Account operations: what a person does to their own Zenith sign-in.
 *
 * Everything in `server/membership.ts` answers "may this person be in this
 * workspace"; everything here answers "this person is changing or ending their
 * own account, what happens to the rows that carry their name". The split
 * matters because the two have opposite defaults — an admin removing a member
 * is a permission check, and a person deleting themselves is not.
 *
 * Two rules hold across this file:
 *
 *  - **History keeps your name.** Audit rows and revision authors are what
 *    somebody did, written when they did it. Deleting an account removes the
 *    membership, not the record of the work.
 *  - **Nothing here reads another person's data.** The export is built from
 *    `workspacesFor(user)` and the caller's own audit rows, so a bug that
 *    widens it has to widen membership first.
 */
import { appendAudit, db, q, readAudit, save } from "@/lib/db/store";
import { id } from "@/lib/domain/types";
import type { Actor, Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { ApiError } from "@/lib/server/errors";
import { readInvites, writeInvites } from "@/lib/server/membership";
import { currentRequest } from "@/lib/server/request";
import { workspacesFor } from "@/lib/server/workspace";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/** How many of the caller's own audit rows an export carries per workspace. */
export const EXPORT_AUDIT_LIMIT = 5000;

/**
 * The caller, or a refusal that says how to become one.
 *
 * Every account route needs a real Supabase user: there is no account to
 * rename, re-key or delete in local demo mode, and saying so is more use than
 * a 401 with no explanation.
 */
export function requireAccountUser(): SessionUser {
  const user = currentRequest()?.user;
  if (user) return user;
  throw new ApiError("This changes your account, and nobody is signed in.", 401, {
    fix: isSupabaseConfigured()
      ? "Sign in at /login, then try again."
      : "This server runs in local demo mode, where there is one local user and no account to change. Set NEXT_PUBLIC_SUPABASE_URL and the publishable key to turn authentication on.",
  });
}

/** Every member row that is this person, across every workspace on this server. */
export function membershipsOf(user: SessionUser): Member[] {
  const email = user.email.toLowerCase();
  return db().members.filter((m) => m.id === user.id || m.email.toLowerCase() === email);
}

/* --------------------------------- export --------------------------------- */

export interface AccountExport {
  exportedAt: string;
  user: { id: string; email: string; name: string };
  /** what this file deliberately does not contain, so nobody has to guess */
  notes: string[];
  workspaces: AccountExportWorkspace[];
}

export interface AccountExportWorkspace {
  workspace: Workspace;
  membership: { role: Member["role"]; name: string; email: string } | null;
  projects: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    environments: {
      id: string;
      name: string;
      class: string;
      region: string;
      baseDomain: string;
      deployedRevisionId?: string;
      createdAt: string;
    }[];
    revisions: {
      id: string;
      number: number;
      message: string;
      author: Actor;
      createdAt: string;
      deployedTo: string[];
    }[];
  }[];
  /** audit rows whose actor is this person — not the workspace's whole log */
  audit: {
    ts: string;
    id: string;
    actionId: string;
    projectId?: string;
    environmentId?: string;
    result: "ok" | "error" | "denied";
    summary: string;
    input: unknown;
    error?: string;
  }[];
}

/**
 * The caller's own copy of what Zenith holds about them.
 *
 * Summaries, not the system: manifests, secret values, provider credentials
 * and other members' rows are all absent by construction rather than by
 * filtering, because nothing here reads them. Audit inputs were redacted when
 * the row was written (`actions/core`), so they carry no secret either.
 */
export function buildAccountExport(user: SessionUser): AccountExport {
  const d = db();
  const email = user.email.toLowerCase();

  const workspaces = workspacesFor(user).map((ws): AccountExportWorkspace => {
    const member = d.members.find(
      (m) => m.workspaceId === ws.id && (m.id === user.id || m.email.toLowerCase() === email)
    );
    return {
      workspace: { id: ws.id, name: ws.name, slug: ws.slug, createdAt: ws.createdAt },
      membership: member
        ? { role: member.role, name: member.name, email: member.email }
        : null,
      projects: d.projects
        .filter((p) => p.workspaceId === ws.id)
        .map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          createdAt: p.createdAt,
          environments: q.environmentsOf(p.id).map((e) => ({
            id: e.id,
            name: e.name,
            class: e.class,
            region: e.region,
            baseDomain: e.baseDomain,
            deployedRevisionId: e.deployedRevisionId,
            createdAt: e.createdAt,
          })),
          revisions: q.revisionsOf(p.id).map((r) => ({
            id: r.id,
            number: r.number,
            message: r.message,
            author: r.author,
            createdAt: r.createdAt,
            deployedTo: r.deployedTo ?? [],
          })),
        })),
      audit: readAudit({ workspaceId: ws.id, actorType: "user", limit: EXPORT_AUDIT_LIMIT })
        .filter((e) => e.actor.id === user.id)
        .map((e) => ({
          ts: e.ts,
          id: e.id,
          actionId: e.actionId,
          projectId: e.projectId,
          environmentId: e.environmentId,
          result: e.result,
          summary: e.summary,
          input: e.input,
          error: e.error,
        })),
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, name: user.name },
    notes: [
      "Workspaces you belong to, and only those. Other members' rows are not included.",
      "Audit rows are the ones whose actor is you. A workspace's full history belongs to the workspace.",
      "No secret values, provider credentials or manifests are included. Manifests come out of Settings → Export, per environment.",
      "Hosted app data is exported per app from that app's own export, which produces a runnable bundle rather than a summary.",
    ],
    workspaces,
  };
}

/** A filename that says whose account it is and when, without an email in it. */
export const accountExportFilename = (user: SessionUser, now = new Date()): string =>
  `zenith-account-${user.id.slice(0, 8)}-${now.toISOString().slice(0, 10)}.json`;

/* -------------------------------- deletion -------------------------------- */

export interface AccountRemoval {
  /** the workspaces this person was removed from, in store order */
  workspaces: Workspace[];
  /** invites they had created that nobody had accepted yet */
  invitesRevoked: number;
}

/**
 * Remove the person from the JSON store: member rows, the unaccepted invites
 * they issued, and one audit row per workspace saying they left.
 *
 * Deliberately not removed: audit rows and revision authors already written.
 * Those name who did the work at the time they did it, and rewriting them
 * would make the history a worse record than it was. Invites *to* this address
 * created by somebody else are also left alone — they are that admin's
 * standing offer to an email, not this person's data.
 *
 * The caller does the irreversible half (the Supabase user) afterwards, so
 * this returns what it touched rather than assuming it.
 */
export function removeAccountRecords(user: SessionUser): AccountRemoval {
  const d = db();
  const mine = membershipsOf(user);
  const workspaces = mine
    .map((m) => d.workspaces.find((w) => w.id === m.workspaceId))
    .filter((w): w is Workspace => Boolean(w));

  for (const member of mine) {
    const at = d.members.indexOf(member);
    if (at >= 0) d.members.splice(at, 1);
  }

  const invites = readInvites();
  const kept = invites.filter((i) => i.acceptedAt || i.createdBy !== user.id);
  const invitesRevoked = invites.length - kept.length;
  // `writeInvites` saves; save unconditionally too, because removing the last
  // member of a workspace with no invites is still a change.
  if (invitesRevoked) writeInvites(kept);
  save();

  const actor: Actor = { type: "user", id: user.id, name: user.name };
  const ts = new Date().toISOString();
  for (const member of mine) {
    const ws = d.workspaces.find((w) => w.id === member.workspaceId);
    appendAudit({
      ts,
      id: id(),
      workspaceId: member.workspaceId,
      actor,
      actionId: "workspace.removeMember",
      input: { memberId: user.id, reason: "account.delete" },
      result: "ok",
      summary: `${user.name} deleted their Zenith account, which ended their ${member.role} membership of ${ws?.name ?? "this workspace"}.`,
    });
  }

  return { workspaces, invitesRevoked };
}
