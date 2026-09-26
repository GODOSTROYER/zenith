import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";
import { isWaitlistOperator } from "@/lib/waitlist/access";
import { WaitlistQueue } from "./waitlist-queue";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Waitlist administration", robots: { index: false, follow: false } };

export default async function WaitlistAdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/waitlist");
  if (!isWaitlistOperator(user)) notFound();

  return (
    <div className="min-h-dvh bg-bg0 text-ink">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-3 sm:px-8">
        <Link href="/" aria-label="Zenith home"><Wordmark size={22} /></Link>
        <div className="flex items-center gap-4">
          <Link href="/auth/continue" className="text-[13px] text-ink-mute hover:text-ink">Open Zenith</Link>
          <form action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] px-6 py-10 sm:px-8">
        <div className="mb-8">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-signal">Operator access</p>
          <h1 className="app-page-title">Waitlist</h1>
          <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink-mute">Review what people want to build and admit the next people in queue order. Admission lets them continue with the same verified email address.</p>
        </div>
        <WaitlistQueue operatorId={user.id} />
      </main>
    </div>
  );
}
