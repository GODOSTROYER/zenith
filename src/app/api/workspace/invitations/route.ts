import { requireAccountUser } from "@/lib/server/account";
import { route } from "@/lib/server/context";
import { pendingInvitations } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
export const GET = route(async () => {
  const user = requireAccountUser();
  return { email: user.email, invitations: await pendingInvitations(user) };
});
