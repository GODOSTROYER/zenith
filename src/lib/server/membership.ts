/**
 * Joining a workspace: who may, as what, and what a refusal says.
 *
 * Signing up is not joining. A real user joins only as that workspace's first
 * real member, with a role the operator granted through `app_metadata.role`, or
 * by accepting an invite that names their email. Everyone else is refused by
 * name, with the admins who can invite them.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import { db, save } from "@/lib/db/store";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import { membershipPolicy } from "@/lib/auth/policy";
import type { SessionUser } from "@/lib/auth/session";

/** Invites in the settings bag: the store's `Database` shape is a spine file. */
// TODO(ceiling): settings.invites; move to a Database column when the store gains one
export const readInvites = (): Invite[] => {
  const raw = db().settings.invites;
  return Array.isArray(raw) ? (raw as Invite[]) : [];
};

export const writeInvites = (invites: Invite[]): void => {
  db().settings.invites = invites;
  save();
};

/** Seeded stand-ins nobody can sign in as. They must never hold the admin seat. */
const PLACEHOLDER_EMAILS = new Set(["you@local", "you@kepler.dev"]);
const isPlaceholder = (m: Member): boolean =>
  !m.email || PLACEHOLDER_EMAILS.has(m.email.toLowerCase());

export interface MemberDenial {
  message: string;
  fix: string;
}

/**
 * Which workspace this user's sign-in is about, when the caller has not said.
 *
 * Order matters. An invite is checked **before** the first-real-member rule:
 * with two workspaces, someone invited to B must join B, not silently take the
 * admin seat of an empty A that happens to sort first.
 */
function joinTarget(user: SessionUser): Workspace | undefined {
  const d = db();
  const email = user.email.toLowerCase();
  const held = d.members.find((m) => m.id === user.id || m.email.toLowerCase() === email);
  if (held) return d.workspaces.find((w) => w.id === held.workspaceId);

  const invite = readInvites().find((i) => !i.acceptedAt && i.email.toLowerCase() === email);
  const invited = invite && d.workspaces.find((w) => w.id === invite.workspaceId);
  if (invited) return invited;

  // Where the policy admits by membership or invite only, that is the whole
  // answer: no taking over an empty workspace, no install-wide role claim.
  const policy = membershipPolicy();
  const empty = policy.emptyWorkspaceGrantsAdmin
    ? d.workspaces.find((w) => !d.members.some((m) => m.workspaceId === w.id && !isPlaceholder(m)))
    : undefined;
  if (empty) return empty;
  // An operator-granted app_metadata.role is install-wide, not per workspace,
  // so it admits them to the one workspace there is — never picks between many.
  return policy.claimsGrantRoles && user.role && d.workspaces.length === 1
    ? d.workspaces[0]
    : undefined;
}

/**
 * Upsert the signed-in user into a workspace's member list.
 *
 * Every rule below is scoped to one workspace: being admin of A grants nothing
 * in B.
 */
export function ensureMember(
  user: SessionUser,
  target?: Workspace
): { member: Member } | { denied: MemberDenial } {
  const d = db();
  const policy = membershipPolicy();
  const ws = target ?? joinTarget(user);
  if (!ws)
    return {
      denied: d.workspaces.length
        ? denial(user, d.workspaces)
        : {
            message: "No workspace exists yet, so there is nothing to join.",
            fix: "Complete onboarding at /onboarding, or run `npm run seed`.",
          },
    };

  const mine = (): Member[] => d.members.filter((m) => m.workspaceId === ws.id);
  const email = user.email.toLowerCase();
  let member = mine().find((m) => m.id === user.id || m.email.toLowerCase() === email);
  let dirty = false;

  if (member) {
    // An invite names an email; the id only exists once they sign in.
    if (member.id !== user.id || member.name !== user.name) {
      member.id = user.id;
      member.name = user.name;
      dirty = true;
    }
    // A confirmed email change arrives as a claim on the first request after
    // the confirmation link is opened — `userFromClaims` reads it, and this is
    // the one place the stored copy follows. The member row is what every
    // member list, export and denial sentence reads, so it must not keep
    // showing the address the person no longer has. Pending invites are keyed
    // by the address they named and are deliberately untouched: an invite is a
    // standing offer to an email, not to a person.
    if (user.email && member.email !== user.email) {
      member.email = user.email;
      dirty = true;
    }
    // Where claims do not grant roles, one never rewrites a stored role
    // either: the member table is the only authority, so a demotion or a
    // removal sticks.
    if (policy.claimsGrantRoles && user.role && member.role !== user.role) {
      member.role = user.role;
      dirty = true;
    }
  } else {
    const role = (policy.claimsGrantRoles ? user.role : undefined) ?? joinRole(ws.id, email);
    if (!role) return { denied: denial(user, [ws]) };
    member = { id: user.id, workspaceId: ws.id, name: user.name, email: user.email, role };
    d.members.push(member);
    dirty = true;
  }

  // Self-heal: a workspace whose only admin is a placeholder has, in practice,
  // no admin at all — every admin action is unreachable for everybody. The
  // first real user to sign in takes the seat, and the placeholder goes.
  const stale = mine().filter((m) => m !== member && isPlaceholder(m));
  if (stale.length) {
    if (!mine().some((m) => !stale.includes(m) && m.role === "admin")) member.role = "admin";
    for (const p of stale) d.members.splice(d.members.indexOf(p), 1);
    dirty = true;
  }

  if (dirty) save();
  return { member };
}

/* ------------------------------- last admin ------------------------------- */

/**
 * True when this member is the only thing standing between us and no admin.
 *
 * A workspace with no admin is a workspace where members, budgets, policies
 * and connections can never be changed again by anybody, so both the member
 * routes and account deletion refuse to create one. Both read this, so there
 * is one rule rather than two that can drift.
 */
export const isLastAdmin = (member: Member): boolean =>
  member.role === "admin" &&
  !db().members.some(
    (m) => m.workspaceId === member.workspaceId && m.role === "admin" && m !== member
  );

/**
 * The workspaces this user is the sole admin of — the reason to refuse a
 * deletion, named so the refusal can say which one and where to fix it.
 */
export function soleAdminWorkspaces(userId: string): Workspace[] {
  const d = db();
  const out: Workspace[] = [];
  for (const member of d.members) {
    if (member.id !== userId || !isLastAdmin(member)) continue;
    const ws = d.workspaces.find((w) => w.id === member.workspaceId);
    if (ws) out.push(ws);
  }
  return out;
}

/** The role a never-seen user may join with, or undefined to refuse them. */
function joinRole(workspaceId: string, email: string): Member["role"] | undefined {
  const real = db().members.filter((m) => m.workspaceId === workspaceId && !isPlaceholder(m));
  // The first real user owns the workspace, where the policy says an empty one
  // is a seat at all.
  if (real.length === 0 && membershipPolicy().emptyWorkspaceGrantsAdmin) return "admin";

  const invites = readInvites();
  const invite = invites.find(
    (i) => i.workspaceId === workspaceId && !i.acceptedAt && i.email.toLowerCase() === email
  );
  if (!invite) return undefined;
  invite.acceptedAt = new Date().toISOString();
  writeInvites(invites);
  return invite.role;
}

/** Refused by name, naming the admins of the workspace(s) who could let them in. */
function denial(user: SessionUser, workspaces: Workspace[]): MemberDenial {
  const who = user.email || user.name;
  // Naming the admins only works when there is one workspace to name them of:
  // handing a stranger every admin address on the server is not a fix.
  if (workspaces.length !== 1)
    return {
      message: `${who} is not a member of any of the ${workspaces.length} workspaces on this server.`,
      fix: `Ask an admin of the workspace you should be in to invite ${who} from Settings → Members.`,
    };
  const ws = workspaces[0];
  const admins = db().members.filter(
    (m) => m.workspaceId === ws.id && m.role === "admin" && !isPlaceholder(m)
  );
  return {
    message: `${who} is not a member of ${ws.name}.`,
    fix: admins.length
      ? `Ask ${admins.map((a) => `${a.name} (${a.email})`).join(" or ")} to invite ${who} from Settings → Members.`
      : membershipPolicy().deniedFix(user, ws),
  };
}
