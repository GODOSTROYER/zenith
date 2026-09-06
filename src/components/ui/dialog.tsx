"use client";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/lib/format";
import { Button } from "./button";
import { useModal } from "./use-modal";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** action row, bottom right */
  footer?: ReactNode;
  width?: number;
  /** destructive confirmations tint the header rule */
  tone?: "default" | "danger";
  className?: string;
  children?: ReactNode;
}

/** Centered modal: focus-trapped, ESC or overlay closes. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  width = 460,
  tone = "default",
  className,
  children,
}: DialogProps) {
  const { ref, present, shown } = useModal(open, onClose);
  const titleId = useId();
  const descId = useId();
  if (!present) return null;

  return createPortal(
    <div inert={!open} className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cx(
          "absolute inset-0 bg-bg0/70 transition-opacity duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]",
          shown ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        style={{ width, maxWidth: "100%" }}
        className={cx(
          "relative flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden rounded-card border border-line bg-bg3 shadow-overlay outline-none",
          "transition-[opacity,transform] duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]",
          shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0",
          className
        )}
      >
        <header
          className={cx(
            "flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4",
            tone === "danger" ? "border-err/30" : "border-line"
          )}
        >
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-[18px] font-semibold leading-snug text-ink">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[12.5px] text-ink-mute">
                {description}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog" title="Close (Esc)">
            <X className="h-4 w-4" />
          </Button>
        </header>
        {children && <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>}
        {footer && (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-bg2 px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
