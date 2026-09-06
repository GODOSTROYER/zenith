import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { ProductChrome } from "@/components/shell/product-chrome";
import { ShellProvider } from "@/components/shell/shell-context";
import "@/components/shell/workbench.css";

/**
 * The product shell: one top bar, one toast queue, one notification home.
 *
 * The bootstrap response carries the real action catalog. Rendering the shell
 * does not import deployment engines and action handlers just to list titles.
 */
export default function ProductLayout({ children }: { children: ReactNode }) {
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
          <ProductChrome>
            <main id="main" tabIndex={-1} className="min-h-0 min-w-0 flex-1 bg-bg0 outline-none">
              <ErrorBoundary what="This screen">{children}</ErrorBoundary>
            </main>
          </ProductChrome>
        </div>
      </ShellProvider>
    </ToastProvider>
  );
}
