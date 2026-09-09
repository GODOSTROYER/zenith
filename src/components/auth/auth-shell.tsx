"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { ToastProvider } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Wordmark } from "@/components/shell/wordmark";

/**
 * Shared frame for login / signup / password pages. When Supabase isn't
 * configured, it says so plainly and offers the demo-mode door instead of
 * rendering a form that cannot work.
 */
export function AuthShell({ configured, children }: { configured: boolean; children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col bg-bg0 text-ink">
        <header className="flex h-16 items-center justify-between border-b border-line px-6 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Wordmark size={22} />
          </Link>
          <ThemeToggle />
        </header>
        <main className="mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-10 px-6 py-10 sm:px-8 lg:grid-cols-[1fr_460px] lg:gap-20 lg:py-16">
          <div className="max-w-[440px]">
            <h2 className="font-display text-[42px] leading-[1.08] tracking-[-0.02em] text-ink sm:text-[52px]">Your stack,<br />clearly in view.</h2>
            <p className="mt-5 max-w-[38ch] text-[14px] leading-relaxed text-ink-mute">A workspace for your infrastructure, from the first proposed change to the record it leaves behind.</p>
            <ol className="mt-8 hidden border-y border-line lg:block">
              {["Shape your system", "Review the change and its estimated cost", "Approve, execute, and inspect the result"].map((label, index) => <li key={label} className="flex items-baseline gap-4 border-b border-line py-4 text-[13px] text-ink-mute last:border-0"><span className="tnum font-mono text-[12px] text-signal">{index + 1}</span>{label}</li>)}
            </ol>
          </div>
          <div className="w-full max-w-[460px] justify-self-center lg:justify-self-end">
            {configured ? (
              children
            ) : (
              <div className="rounded-card border border-line bg-bg2 p-6 sm:p-8">
                <h1 className="app-page-title">Sign-in isn&apos;t configured yet</h1>
                <p className="mt-2 text-[14px] leading-[1.6] text-ink-mute">
                  Zenith is running in local demo mode — one local user, no accounts. To turn on
                  accounts, add Supabase keys to{" "}
                  <span className="font-mono text-[12.5px] text-ink">.env.local</span> (see{" "}
                  <span className="font-mono text-[12.5px] text-ink">.env.local.example</span>) and restart.
                </p>
                <Link
                  href="/overview"
                  className="mt-5 inline-flex min-h-9 items-center rounded-ctl bg-signal px-4 py-2 text-[13px] font-medium text-on-signal transition-colors hover:bg-signal-strong"
                >
                  Continue in demo mode
                </Link>
              </div>
            )}
          </div>
        </main>
      </div>
    </ToastProvider>
  );
}
