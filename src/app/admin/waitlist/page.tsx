import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isWaitlistOperator } from "@/lib/waitlist/access";

export const dynamic = "force-dynamic";

export default async function WaitlistAdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin");
  if (!isWaitlistOperator(user)) notFound();

  redirect("/admin#waitlist");
}
