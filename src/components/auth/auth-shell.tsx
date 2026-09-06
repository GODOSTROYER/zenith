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
        <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-10 sm:items-center sm:pt-0">
          <div className="w-full max-w-[460px]">
            {configured ? (
              children
            ) : (
              <div className="rounded-[12px] border border-line bg-bg1 p-6">
                <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Sign-in isn&apos;t configured yet</h1>
                <p className="mt-2 text-[14px] leading-[1.6] text-ink-mute">
                  Orrery is running in local demo mode — one local user, no accounts. To turn on
                  accounts, add Supabase keys to{" "}
                  <span className="font-mono text-[12.5px] text-ink">.env.local</span> (see{" "}
                  <span className="font-mono text-[12.5px] text-ink">.env.local.example</span>) and restart.
                </p>
                <Link
                  href="/overview"
                  className="mt-5 inline-flex items-center rounded-[8px] bg-signal px-4 py-2 text-[13.5px] font-semibold text-on-signal"
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
