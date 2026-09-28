import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { authPageUrl } from "@/lib/auth/oauth";

/** The signup route stays useful while new access is by waitlist admission. */
export function SignupWaitlistNotice({ next }: { next?: string | null }) {
  return (
    <section className="rounded-card border border-line bg-bg2 p-6 sm:p-8" aria-labelledby="signup-waitlist-title">
      <h1 id="signup-waitlist-title" className="app-page-title">A place for what’s next.</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-mute">
        We’re opening Zenith in small batches. Join the waitlist to request early access.
      </p>
      <Link
        href={authPageUrl("/waitlist", next)}
        className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-ctl bg-signal px-4 py-2.5 text-[13px] font-medium text-on-signal transition-colors hover:bg-signal-strong"
      >
        Join the waitlist <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <p className="mt-5 border-t border-line pt-4 text-[13px] leading-relaxed text-ink-mute">
        Already have access?{" "}
        <Link href={authPageUrl("/login", next)} className="text-signal underline underline-offset-4">Sign in</Link>
        {" "}with your approved email.
      </p>
    </section>
  );
}
