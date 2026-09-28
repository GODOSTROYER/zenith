import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isWaitlistOperator } from "@/lib/waitlist/access";
import { WaitlistQueue } from "./waitlist/waitlist-queue";
import { AdminShell } from "./admin-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Administration · Zenith", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (!isWaitlistOperator(user)) notFound();

  return <AdminShell email={user.email}><WaitlistQueue operatorId={user.id} /></AdminShell>;
}
