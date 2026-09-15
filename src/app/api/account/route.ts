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
 *  3. **Close the live doors before the identity.** App sessions end and
 *     hosted grants are revoked before the Supabase user is deleted. Local
 *     membership cleanup follows the irreversible provider operation, so a
 *     failed provider call leaves the account retryable rather than half-gone.
 *  4. **Journal the attempt, not the outcome.** The provider call and the local
 *     store are two authorities and cannot commit together, so the window
 *     around `deleteUser` is recorded *before* it
 *     (`identity-delete-attempted`) — see `server/account.ts` for why that is
 *     the side that makes a dead process recoverable.
 *
 * What survives on purpose: audit rows and revision authors. They record what
 * this person did at the time they did it, and a history that rewrites itself
 * when somebody leaves is not a history.
 */
import { revokeGrant, terminateAppSessionsForSubject } from "@/lib/hosted/access";
import { authority } from "@/lib/hosted/authority";
import { log } from "@/lib/log";
import {
  advanceAccountDeletion,
  beginAccountDeletion,
  finishAccountDeletion,
  pendingAccountDeletion,
  removeAccountRecordsAsync,
  requireAccountUser,
} from "@/lib/server/account";
import { ApiError, route, soleAdminWorkspaces } from "@/lib/server/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { withMutationGate } from "@/lib/actions/mutation-gate";
import { isPostgres } from "@/lib/db/store";

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

export const DELETE = route(async () => withMutationGate(async () => {
  const user = requireAccountUser();

  // Product state and the Supabase identity are separate authorities. The
  // process-local mutation gate below protects the file/single-writer mode,
  // but it cannot fence another Postgres-backed instance or make provider
  // deletion and local cleanup one transaction. Refuse before constructing a
  // service-role client or changing a grant until a durable deletion journal
  // coordinates those authorities.
  if (isPostgres()) {
    throw new ApiError(
      "Account deletion is unavailable while Product storage uses PostgreSQL.",
      503,
      {
        fix: "Use the supported single-writer file-store mode for self-service deletion, or ask an operator to run the coordinated account-deletion workflow. No identity, grant, session or membership was changed.",
      }
    );
  }

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
  const existing = pendingAccountDeletion(user.id);
  const journal = await beginAccountDeletion(user, existing?.operationId);
  let appSessionsEnded = 0;
  let grantsRevoked = 0;

  if (journal.stage !== "identity-deleted") {
    appSessionsEnded = await terminateAppSessionsForSubject(user.id, "signed_out");
    grantsRevoked = await revokeHostedGrants(user.id);
    await advanceAccountDeletion(journal.operationId, "doors-closed");

    // Journal the *attempt* before the irreversible call, not after it. The
    // window between `deleteUser` returning and the next journal write landing
    // cannot be closed — they are two authorities — so it is recorded on the
    // side that makes it answerable: a process that dies in there leaves an
    // entry saying "we were about to delete this identity", and reconciliation
    // asks the provider which side of the call it died on. Recording only
    // afterwards left that window invisible and the account stranded.
    await advanceAccountDeletion(journal.operationId, "identity-delete-attempted");

    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error)
      throw new ApiError(`Your Zenith sign-in was not deleted: ${error.message}`, 502, {
        fix: "Your active app sessions and hosted grants were closed and the deletion is journaled for retry, but your local workspace memberships were preserved. Try again to remove the sign-in itself; if it keeps failing, an operator can delete the user from the Supabase dashboard under Authentication → Users.",
      });

    // The provider confirmed it. From here local cleanup is owed unconditionally.
    await advanceAccountDeletion(journal.operationId, "identity-deleted");
  }

  // The identity-provider deletion is irreversible and cannot share the local
  // store transaction. Keep the local membership cleanup after it so a failed
  // provider call leaves the account retryable instead of half-removed.
  const removal = await removeAccountRecordsAsync(user, journal.operationId);
  await finishAccountDeletion(journal.operationId);

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
}));
