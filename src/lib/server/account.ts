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
import { appendAuditAsync, appendAuditBatch, db, flushPendingAsync, isPostgres, q, readAudit, readAuditPageAsync, save } from "@/lib/db/store";
import { id } from "@/lib/domain/types";
import type { Actor, AuditEvent, Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { log } from "@/lib/log";
import { ApiError } from "@/lib/server/errors";
import { readInvites } from "@/lib/server/membership";
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

/**
 * Account deletion crosses two authorities: the local store and Supabase
 * Auth. A durable marker makes the irreversible boundary recoverable when a
 * process dies around it. Values are identity metadata only; credentials
 * never enter this journal.
 *
 * ## The stages, and why `identity-delete-attempted` exists
 *
 *   started                    the journal entry is durable
 *   doors-closed               app sessions ended, hosted grants revoked
 *   identity-delete-attempted  written **before** `admin.deleteUser` returns
 *   identity-deleted           the provider confirmed it
 *
 * The journal used to go straight from `doors-closed` to `identity-deleted`,
 * which left the one window it was built to close: a process that died between
 * `deleteUser` returning 200 and the journal write landing left an identity
 * that is gone, a journal that says it is not, and a user who cannot sign in
 * to retry — so the member rows, the invites they issued and the entry itself
 * persisted for ever, and `soleAdminWorkspaces` kept counting a ghost admin.
 *
 * Recording the *attempt* first turns that into a question with an answer:
 * ask the provider whether the identity is still there (`getUserById`). Gone
 * means the call succeeded and local cleanup may finish; present means it did
 * not, and the account is whole and retryable by its owner.
 */
export type PendingAccountDeletion = {
  operationId: string;
  user: Pick<SessionUser, "id" | "email" | "name">;
  stage: "started" | "doors-closed" | "identity-delete-attempted" | "identity-deleted";
  updatedAt: string;
};

const PENDING_DELETIONS = "pendingAccountDeletions";

function pendingDeletions(): PendingAccountDeletion[] {
  const settings = db().settings;
  const value = settings[PENDING_DELETIONS];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PendingAccountDeletion => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Partial<PendingAccountDeletion>;
    return typeof row.operationId === "string" && typeof row.stage === "string" &&
      !!row.user && typeof row.user.id === "string" && typeof row.user.email === "string" &&
      typeof row.user.name === "string";
  });
}

function setPendingDeletions(rows: PendingAccountDeletion[]): void {
  db().settings[PENDING_DELETIONS] = rows;
}

export function pendingAccountDeletion(userId: string): PendingAccountDeletion | undefined {
  return pendingDeletions().find((entry) => entry.user.id === userId);
}

export async function beginAccountDeletion(user: SessionUser, operationId = id()): Promise<PendingAccountDeletion> {
  const existing = pendingAccountDeletion(user.id);
  if (existing) return existing;
  const entry: PendingAccountDeletion = {
    operationId,
    user: { id: user.id, email: user.email, name: user.name },
    stage: "started",
    updatedAt: new Date().toISOString(),
  };
  setPendingDeletions([...pendingDeletions(), entry]);
  save();
  await flushPendingAsync();
  return entry;
}

export async function advanceAccountDeletion(
  operationId: string,
  stage: PendingAccountDeletion["stage"]
): Promise<void> {
  const rows = pendingDeletions();
  const index = rows.findIndex((entry) => entry.operationId === operationId);
  if (index < 0) throw new Error("The account-deletion journal entry is missing; refusing an unjournaled deletion.");
  rows[index] = { ...rows[index], stage, updatedAt: new Date().toISOString() };
  setPendingDeletions(rows);
  save();
  await flushPendingAsync();
}

export async function finishAccountDeletion(operationId: string): Promise<void> {
  setPendingDeletions(pendingDeletions().filter((entry) => entry.operationId !== operationId));
  save();
  await flushPendingAsync();
}

/**
 * Ask the identity provider whether this subject still exists.
 *
 * `"gone"` is the only answer that unblocks local cleanup, so every uncertain
 * outcome — no service-role key, a provider that will not answer, a shape we
 * do not recognise — resolves to `"unknown"` and the entry is left alone. A
 * reconcile pass that guessed "probably deleted" would strip a live account's
 * memberships.
 *
 * The admin client is constructed here rather than imported at module scope so
 * a file-mode install with no service-role key still loads this module.
 */
async function identityState(userId: string): Promise<"gone" | "present" | "unknown"> {
  if (!isSupabaseConfigured()) return "unknown";
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
    if (data?.user?.id) return "present";
    // Supabase answers a missing user with a 404-shaped error, and every other
    // error is a provider problem rather than an answer.
    if (error) return error.status === 404 ? "gone" : "unknown";
    return "gone";
  } catch {
    return "unknown";
  }
}

/**
 * Finish the deletions that already crossed the Supabase identity boundary.
 *
 * Safe to call from an authenticated internal cron pass: it never *guesses*
 * whether an external identity was deleted, and it is idempotent through the
 * operation-scoped audit ids below.
 *
 * `identity-delete-attempted` is the stage the crash window lands in, and it
 * is resolved by asking the provider, not by assuming: gone means the
 * irreversible call did happen and local cleanup is owed; present means it did
 * not, and the account is intact. A present identity is **surfaced, never
 * retried here** — re-running an irreversible provider call from a background
 * pass would delete an account whose owner was last told it had *not* been
 * deleted (the route answers 502 with exactly that). The owner retries by
 * calling `DELETE /api/account` again, which resumes from this same entry.
 */
export async function reconcilePendingAccountDeletionsAsync(): Promise<number> {
  let completed = 0;
  for (const entry of pendingDeletions()) {
    let stage = entry.stage;

    if (stage === "identity-delete-attempted") {
      const state = await identityState(entry.user.id);
      if (state !== "gone") {
        log.warn("account deletion is waiting on its identity provider", {
          scope: "account",
          operationId: entry.operationId,
          identity: state,
          fix:
            state === "present"
              ? "The Supabase user still exists, so the deletion did not happen. The account owner can retry with DELETE /api/account; an operator can delete the user under Authentication → Users."
              : "The identity provider could not be asked (no service-role key, or it did not answer), so nothing was assumed. The entry is kept for the next pass.",
        });
        continue;
      }
      await advanceAccountDeletion(entry.operationId, "identity-deleted");
      stage = "identity-deleted";
    }

    if (stage !== "identity-deleted") continue;
    await removeAccountRecordsAsync(
      { id: entry.user.id, email: entry.user.email, name: entry.user.name },
      entry.operationId
    );
    await finishAccountDeletion(entry.operationId);
    completed++;
  }
  return completed;
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
function exportWorkspace(
  user: SessionUser,
  ws: Workspace,
  d: ReturnType<typeof db>,
  auditEvents: AuditEvent[]
): AccountExportWorkspace {
  const email = user.email.toLowerCase();
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
    audit: auditEvents
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
}

function accountExportBody(
  user: SessionUser,
  audits: Map<string, AuditEvent[]>
): AccountExport {
  const d = db();
  const workspaces = workspacesFor(user);

  return {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, name: user.name },
    notes: [
      "Workspaces you belong to, and only those. Other members' rows are not included.",
      "Audit rows are the ones whose actor is you. A workspace's full history belongs to the workspace.",
      "No secret values, provider credentials or manifests are included. Manifests come out of Settings → Export, per environment.",
      "Hosted app data is exported per app from that app's own export, which produces a runnable bundle rather than a summary.",
    ],
    workspaces: workspaces.map((ws) => exportWorkspace(user, ws, d, audits.get(ws.id) ?? [])),
  };
}

/** Synchronous compatibility export for the file-store contract. */
export function buildAccountExport(user: SessionUser): AccountExport {
  const audits = new Map(
    workspacesFor(user).map((ws) => [
      ws.id,
      readAudit({ workspaceId: ws.id, actorType: "user", limit: EXPORT_AUDIT_LIMIT }),
    ])
  );
  return accountExportBody(user, audits);
}

/** Non-blocking export path for Postgres-backed account requests. */
export async function buildAccountExportAsync(user: SessionUser): Promise<AccountExport> {
  const audits = new Map(
    await Promise.all(
      workspacesFor(user).map(async (ws) => [
        ws.id,
        (await readAuditPageAsync({
          workspaceId: ws.id,
          actorType: "user",
          limit: EXPORT_AUDIT_LIMIT,
        })).events,
      ] as const)
    )
  );
  return accountExportBody(user, audits);
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
 * The account route performs the irreversible identity-provider operation
 * before calling this cleanup. This function therefore returns what it touched
 * rather than assuming the provider operation and local cleanup are atomic.
 */
export async function removeAccountRecordsAsync(user: SessionUser, operationId = id()): Promise<AccountRemoval> {
  const d = db();
  const mine = membershipsOf(user);
  const workspaces = mine
    .map((m) => d.workspaces.find((w) => w.id === m.workspaceId))
    .filter((w): w is Workspace => Boolean(w));

  const originalMembers = d.members.slice();
  const originalInvites = d.settings.invites;

  for (const member of mine) {
    const at = d.members.indexOf(member);
    if (at >= 0) d.members.splice(at, 1);
  }

  const invites = readInvites();
  const kept = invites.filter((i) => i.acceptedAt || i.createdBy !== user.id);
  const invitesRevoked = invites.length - kept.length;
  // Keep all state changes in memory until the required audit rows have been
  // accepted. `writeInvites` calls save immediately, which would allow a
  // Postgres snapshot to commit before an async audit failure is observed.
  if (invitesRevoked) d.settings.invites = kept;

  const actor: Actor = { type: "user", id: user.id, name: user.name };
  const ts = new Date().toISOString();
  try {
    const pendingAudits: AuditEvent[] = mine.flatMap((member) => {
      const ws = d.workspaces.find((w) => w.id === member.workspaceId);
      const auditId = `${operationId}:workspace.removeMember:${member.workspaceId}`;
      if (readAudit({ workspaceId: member.workspaceId }).some((event) => event.id === auditId)) return [];
      return [{
        ts,
        id: auditId,
        workspaceId: member.workspaceId,
        actor,
        actionId: "workspace.removeMember",
        input: { memberId: user.id, reason: "account.delete" },
        result: "ok",
        summary: `${user.name} deleted their Zenith account, which ended their ${member.role} membership of ${ws?.name ?? "this workspace"}.`,
      }];
    });
    if (isPostgres()) {
      for (const event of pendingAudits) await appendAuditAsync(event);
    } else {
      appendAuditBatch(pendingAudits);
    }
  } catch (error) {
    // Restore the mutable snapshot. File-store batches are atomically replaced;
    // Postgres account deletion is refused above until a cross-table transaction
    // exists, so an async audit failure cannot leave a successful deletion.
    d.members.splice(0, d.members.length, ...originalMembers);
    if (invitesRevoked) {
      if (originalInvites === undefined) delete d.settings.invites;
      else d.settings.invites = originalInvites;
    }
    throw error;
  }

  // `save` is deliberately after the required audit writes. The route edge
  // awaits the pending write before returning 204.
  save();

  return { workspaces, invitesRevoked };
}
