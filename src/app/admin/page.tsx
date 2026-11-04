import type { Metadata } from "next";
import { getSessionUser } from "@/lib/auth/session";
import { isWaitlistOperator } from "@/lib/waitlist/access";
import { opsAdminIds } from "@/lib/ops/config";
import { WaitlistQueue } from "./waitlist/waitlist-queue";
import { AdminEntry } from "./admin-entry";
import { AdminShell } from "./admin-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Administration · Zenith", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) return <AdminEntry />;
  if (!isWaitlistOperator(user)) return <AdminEntry accessDenied />;

  return <AdminShell email={user.email} showRetention={opsAdminIds().has(user.id)}><WaitlistQueue operatorId={user.id} /></AdminShell>;
}
