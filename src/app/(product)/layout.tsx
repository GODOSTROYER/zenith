import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { ProductChrome } from "@/components/shell/product-chrome";
import { ShellProvider } from "@/components/shell/shell-context";
import type { ActionEntry } from "@/components/shell/command-palette";
import { listActions } from "@/lib/actions/defs";

/**
 * The product shell: one top bar, one toast queue, one notification home.
 *
 * A server component so the command palette can be handed the real action
 * registry rather than a hand-maintained copy of it — only the four fields a
 * picker needs cross to the client, and none of the handlers do.
 */
export default function ProductLayout({ children }: { children: ReactNode }) {
  const catalog: ActionEntry[] = listActions().map((a) => ({
    id: a.id,
    title: a.title,
    category: a.category,
    risk: a.risk,
    requiredRole: a.requiredRole,
  }));

  return (
    <ToastProvider>
      <ShellProvider>
        <div className="flex h-dvh flex-col bg-bg0">
          {/* First tab stop on every product page: past the chrome, into the screen. */}
          <a
            href="#main"
            className="sr-only rounded-ctl bg-signal px-3 py-2 text-[13px] font-medium text-on-signal focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[70]"
          >
            Skip to content
          </a>
          <ProductChrome catalog={catalog} />
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 bg-bg0 outline-none">
            <ErrorBoundary what="This screen">{children}</ErrorBoundary>
          </main>
        </div>
      </ShellProvider>
    </ToastProvider>
  );
}
