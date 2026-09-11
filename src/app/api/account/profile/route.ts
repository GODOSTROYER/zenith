/**
 * Your display name.
 *
 *   PATCH /api/account/profile  body { name } → { name, members: Member[] }
 *
 * The claim is the source of truth and the member row is the copy every member
 * list, denial sentence and export reads. Writing only the claim would leave
 * the old name on screen until the person's next sign-in, so this refreshes the
 * copy in the same request — through `ensureMember`, which is the one place
 * that rule lives.
 *
 * Names already written into audit rows and revision authors are left as they
 * were: those say who did something at the time they did it.
 */
import { z } from "zod";
import { ApiError, ensureMember, route, workspacesFor } from "@/lib/server/context";
import { requireAccountUser } from "@/lib/server/account";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(80) });

export const PATCH = route(async (req) => {
  const user = requireAccountUser();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("That display name cannot be used.", 400, {
      fix: 'Send { "name": "…" } — between 1 and 80 characters, and not only spaces.',
    });
  const name = parsed.data.name;

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ data: { full_name: name } });
  if (error)
    throw new ApiError(`The name was not saved: ${error.message}`, 400, {
      fix: "Try again. If it keeps failing, sign out and back in — the change is written against your current session.",
    });

  // One refresh per workspace they belong to: `ensureMember()` with no target
  // picks a single workspace, and somebody in two of them would keep the old
  // name in the other. A brand-new account belongs to none yet, and the bare
  // call is what resolves a pending invite for them.
  const updated = { ...user, name };
  const mine = workspacesFor(updated);
  const results = mine.length
    ? mine.map((ws) => ensureMember(updated, ws))
    : [ensureMember(updated)];

  return {
    name,
    members: results.flatMap((r) => ("member" in r ? [r.member] : [])),
  };
});
