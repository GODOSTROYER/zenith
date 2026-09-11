"use client";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/format";
import { ModalHeader, ModalOverlay } from "./modal-parts";
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
      <ModalOverlay onClose={onClose} shown={shown} />
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
        <ModalHeader
          titleId={titleId}
          descId={descId}
          title={title}
          description={description}
          onClose={onClose}
          closeLabel="Close dialog"
          tone={tone}
        />
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
