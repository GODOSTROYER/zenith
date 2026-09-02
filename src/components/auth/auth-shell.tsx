"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { ToastProvider } from "@/components/ui";

/**
 * Shared frame for login / signup / password pages. When Supabase isn't
 * configured, it says so plainly and offers the demo-mode door instead of
 * rendering a form that cannot work.
 */
export function AuthShell({ configured, children }: { configured: boolean; children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col bg-bg0 text-ink">
        <header className="flex h-14 items-center px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span aria-hidden className="relative inline-block h-[18px] w-[18px] rounded-full border-[1.5px] border-signal">
              <span className="absolute -top-[3px] left-[9px] h-[6px] w-[6px] rounded-full bg-signal" />
            </span>
            <span className="text-[15px] font-semibold tracking-[-0.01em]">Orrery</span>
          </Link>
        </header>
        <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-10 sm:items-center sm:pt-0">
          <div className="w-full max-w-[420px]">
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
