/**
 * The membership policy this install runs, chosen once instead of branched on.
 *
 * Two installs answer "may this person be in this workspace?" differently:
 *
 *  - **Self-hosted** trusts the operator. A role the operator put in
 *    `app_metadata.role` is honoured, and the first real user to sign in owns a
 *    workspace that has nobody in it — there is nobody to defer to, and an
 *    unreachable admin seat would make every admin action impossible.
 *  - **Hosted** (`ZENITH_HOSTED_MODE=1`) trusts only the member table. A
 *    workspace is created by its admin through `POST /api/workspace`, so an
 *    empty one is never a seat for whoever signs in next, and a revoked person
 *    stays out until an admin invites them again — whatever their token says.
 *
 * Those are two rules, not six, so they are stated once here and read as data
 * by `server/membership.ts`, `server/actor.ts` and `actions/core.ts`. The
 * difference between the modes is now one object, which is also the only place
 * to look when a third mode arrives.
 */
import type { Workspace } from "@/lib/domain/types";
import { hostedMode } from "@/lib/hosted/config";
import type { SessionUser } from "@/lib/auth/session";

export interface MembershipPolicy {
  /** Honour `app_metadata.role`: as a way in, and as a way to change a stored role. */
  claimsGrantRoles: boolean;
  /** A workspace with no real members admits the next signed-in user as its admin. */
  emptyWorkspaceGrantsAdmin: boolean;
  /**
   * What to tell someone refused from a workspace that has no admin to ask.
   * The fix differs by mode because the way back in differs by mode.
   */
  deniedFix(user: SessionUser, workspace: Workspace): string;
}

const SELF_HOSTED: MembershipPolicy = {
  claimsGrantRoles: true,
  emptyWorkspaceGrantsAdmin: true,
  deniedFix: () =>
    `No admin exists who could invite you. The operator can grant a role by setting app_metadata.role on your Supabase user (see scripts/seed-users.ts).`,
};

const HOSTED: MembershipPolicy = {
  claimsGrantRoles: false,
  emptyWorkspaceGrantsAdmin: false,
  deniedFix: (user) =>
    `No admin exists who could invite you. In hosted mode role claims are not honoured: the workspace admin must sign in and invite ${user.email || user.name} from Settings → Members.`,
};

/**
 * The policy in force for this process, read fresh: `ZENITH_HOSTED_MODE` is an
 * environment fact, and a test that sets it expects the next call to obey it.
 */
export const membershipPolicy = (): MembershipPolicy => (hostedMode() ? HOSTED : SELF_HOSTED);
