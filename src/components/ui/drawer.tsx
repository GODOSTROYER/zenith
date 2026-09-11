"use client";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/format";
import { ModalHeader, ModalOverlay } from "./modal-parts";
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
      <ModalOverlay onClose={onClose} shown={shown} />
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
        <ModalHeader
          titleId={titleId}
          descId={descId}
          title={title}
          description={description}
          onClose={onClose}
          closeLabel="Close panel"
          actions={actions}
          groupControls
        />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
        {footer && (
          <footer className="shrink-0 border-t border-line bg-bg2 px-5 py-4">{footer}</footer>
        )}
      </div>
    </div>,
    document.body
  );
}
