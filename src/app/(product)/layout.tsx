"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle, ToastProvider } from "@/components/ui";
import { ActivityBell } from "@/components/shell/activity-bell";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { ShellProvider, useShell } from "@/components/shell/shell-context";
import { Wordmark } from "@/components/shell/wordmark";

function WorkspaceChip() {
  const { boot } = useShell();
  if (!boot?.workspace)
    return <span className="h-6 w-24 animate-pulse rounded-full bg-bg2" aria-hidden="true" />;
  return (
    <span
      title={`Workspace · ${boot.workspace.name}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-bg2 px-2.5 py-0.5 text-[12px] text-ink-mute"
    >
      {boot.workspace.name}
    </span>
  );
}

/** The product shell: one top bar, one toast queue, one notification home. */
export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ShellProvider>
        <div className="flex h-dvh flex-col bg-bg0">
          <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg1 px-4">
            <Link
              href="/overview"
              title="Workspace overview"
              className="rounded-ctl px-1 py-0.5 transition-opacity duration-[120ms] [transition-timing-function:var(--ease-swift)] hover:opacity-80"
            >
              <Wordmark />
            </Link>
            <div className="flex items-center gap-2">
              <ActivityBell />
              <ThemeToggle />
              <WorkspaceChip />
            </div>
          </header>
          <main className="min-h-0 flex-1 bg-bg0">
            <ErrorBoundary what="This screen">{children}</ErrorBoundary>
          </main>
        </div>
      </ShellProvider>
    </ToastProvider>
  );
}
