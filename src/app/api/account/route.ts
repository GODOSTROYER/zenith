/**
 * Delete your account.
 *
 *   DELETE /api/account → 204, or 409 naming the workspace that would be left
 *                         without an admin
 *
 * The order below is the whole design, and it is the order a reviewer should
 * check first:
 *
 *  1. **Refuse first.** A workspace whose only admin deletes themselves can
 *     never change its members, budgets, policies or connections again. That
 *     check runs before anything is constructed or touched.
 *  2. **Construct the admin client next.** This is the only call site of the
 *     service-role client in `src/app` — a missing `SUPABASE_SERVICE_ROLE_KEY`
 *     must fail while the account is still whole, not halfway through.
 *  3. **Close the doors before the identity.** App sessions end, then hosted
 *     grants are revoked, then the member rows go, and only then is the
 *     Supabase user deleted. Deleting the identity first would leave live
 *     grants naming a subject nobody can ever sign in as.
 *
 * What survives on purpose: audit rows and revision authors. They record what
 * this person did at the time they did it, and a history that rewrites itself
 * when somebody leaves is not a history.
 */
import { revokeGrant, terminateAppSessionsForSubject } from "@/lib/hosted/access";
import { authority } from "@/lib/hosted/authority";
import { log } from "@/lib/log";
import { removeAccountRecords, requireAccountUser } from "@/lib/server/account";
import { ApiError, route, soleAdminWorkspaces } from "@/lib/server/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Every live grant this person holds, revoked with its ledger row and outbox
 * copy — including one where they are the app's only owner. That guard exists
 * to stop an app losing its last administrator; here it would only preserve a
 * grant naming an account that no longer exists. An admin of the app's
 * workspace grants a replacement owner from the app's access panel.
 */
async function revokeHostedGrants(subject: string): Promise<number> {
  const grants = await authority().repos.grants.listBySubject(subject, { activeOnly: true });
  for (const grant of grants)
    await revokeGrant(grant.id, subject, "the account that held this access was deleted", {
      lastOwnerOk: true,
    });
  return grants.length;
}

export const DELETE = route(async () => {
  const user = requireAccountUser();

  const blocked = soleAdminWorkspaces(user.id);
  if (blocked.length) {
    const names = blocked.map((w) => w.name);
    throw new ApiError(
      `You are the only admin of ${names.join(" and ")}.`,
      409,
      {
        fix: `Make someone else an admin first from Settings → Members, then delete your account.`,
      }
    );
  }

  // Step 2: nothing has been touched yet, so a configuration failure here is
  // harmless. See the header note.
  const admin = createAdminClient();

  const appSessionsEnded = await terminateAppSessionsForSubject(user.id, "signed_out");
  const grantsRevoked = await revokeHostedGrants(user.id);
  const removal = removeAccountRecords(user);

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error)
    throw new ApiError(`Your Zenith sign-in was not deleted: ${error.message}`, 502, {
      fix: "Your workspace memberships and app access are already gone, so nothing opens for you any more. Try again to remove the sign-in itself; if it keeps failing, an operator can delete the user from the Supabase dashboard under Authentication → Users.",
    });

  log.info("account deleted", {
    scope: "account",
    workspaces: removal.workspaces.length,
    invitesRevoked: removal.invitesRevoked,
    grantsRevoked,
    appSessionsEnded,
  });

  // The identity is gone; the cookies in this browser are not. Clearing them
  // is what makes the next request a signed-out one rather than a 401 loop.
  await (await createClient()).auth.signOut();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
