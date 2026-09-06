"use client";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/lib/format";
import { Button } from "./button";
import { useModal } from "./use-modal";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** header controls, right of the title */
  actions?: ReactNode;
  /** sticky bottom bar — primary action lives here */
  footer?: ReactNode;
  /** clamped to 420–560px */
  width?: number;
  className?: string;
  children: ReactNode;
}

/** Right-side panel: focus-trapped, ESC or overlay closes, shared panel motion. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  actions,
  footer,
  width = 480,
  className,
  children,
}: DrawerProps) {
  const { ref, present, shown } = useModal(open, onClose);
  const titleId = useId();
  const descId = useId();
  if (!present) return null;

  const w = Math.min(560, Math.max(420, width));

  return createPortal(
    <div inert={!open} className="fixed inset-0 z-50">
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
        style={{ width: w }}
        className={cx(
          "absolute inset-y-0 right-0 flex max-w-full flex-col border-l border-line bg-bg1 shadow-overlay outline-none",
          "transition-transform duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]",
          shown ? "translate-x-0" : "translate-x-full",
          className
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
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
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel" title="Close (Esc)">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-line bg-bg2 px-5 py-4">{footer}</footer>
        )}
      </div>
    </div>,
    document.body
  );
}
