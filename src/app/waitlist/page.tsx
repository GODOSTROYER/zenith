import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";
import { getWaitlistAccess } from "@/lib/waitlist/access";
import { waitlistEnabled } from "@/lib/waitlist/config";
import { WaitlistJoinForm } from "./waitlist-join-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Early access", robots: { index: false, follow: false } };

export default async function WaitlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/waitlist");
  const access = await getWaitlistAccess(user);
  if (access.allowed) redirect("/auth/continue");
  const intakeEnabled = waitlistEnabled();

  return (
    <div className="flex min-h-dvh flex-col bg-bg0 text-ink">
      <header className="flex h-16 items-center justify-between border-b border-line px-6 sm:px-8">
        <Link href="/" aria-label="Zenith home"><Wordmark size={22} /></Link>
        <form action="/auth/signout" method="post"><Button type="submit" variant="ghost" size="sm">Sign out</Button></form>
      </header>
      <main className="mx-auto w-full max-w-[600px] flex-1 px-6 py-12 sm:py-20">
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-signal">Zenith early access</p>
        <h1 className="font-display text-[40px] leading-[1.1] tracking-[-0.02em] sm:text-[48px]">A little more time<br />before lift-off.</h1>
        <p className="mt-5 text-[14px] leading-relaxed text-ink-mute">You&apos;re signed in. Access to Zenith is opening in batches, and this account is waiting for admission.</p>
        <p className="mt-3 break-all text-[13px] text-ink-mute">Signed in as <span className="font-medium text-ink">{user.email || user.name}</span></p>
        <div className="mt-7 flex flex-wrap items-center gap-4">
          <a href="/waitlist" className="inline-flex h-9 items-center justify-center rounded-ctl border border-transparent bg-signal px-3.5 text-[13px] font-medium text-on-signal transition-colors hover:bg-signal-strong">Check access again</a>
          <p className="text-[12px] text-ink-faint">Already admitted? Use the same verified email.</p>
        </div>
        {intakeEnabled && user.email ? <WaitlistJoinForm email={user.email} /> : intakeEnabled ? <p className="mt-8 border-t border-line pt-6 text-[13px] leading-relaxed text-ink-mute">Sign in with an account that has a verified email address to join the waitlist.</p> : <p className="mt-8 border-t border-line pt-6 text-[13px] leading-relaxed text-ink-mute">New waitlist requests are currently paused. If you have already joined, your request stays in the queue. You can return here to check your access.</p>}
      </main>
    </div>
  );
}
