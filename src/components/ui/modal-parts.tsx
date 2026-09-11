"use client";
/**
 * The two pieces Dialog and Drawer render the same way: the scrim that closes
 * on click, and the titled header that wires `aria-labelledby` /
 * `aria-describedby` to the panel and carries the close button.
 *
 * Everything else — where the panel sits and how it moves — stays with each
 * of them, because that is the only thing that actually differs.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/format";
import { Button } from "./button";

/** The scrim: click closes, fades with the panel, never announced. */
export function ModalOverlay({ onClose, shown }: { onClose: () => void; shown: boolean }) {
  return (
    <div
      onClick={onClose}
      aria-hidden="true"
      className={cx(
        "absolute inset-0 bg-bg0/70 transition-opacity duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]",
        shown ? "opacity-100" : "opacity-0"
      )}
    />
  );
}

export interface ModalHeaderProps {
  /** the id the panel points `aria-labelledby` at */
  titleId: string;
  /** the id the panel points `aria-describedby` at, when there is a description */
  descId: string;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  /** what the close button announces — "Close dialog", "Close panel" */
  closeLabel: string;
  /** destructive confirmations tint the header rule */
  tone?: "default" | "danger";
  /** extra controls, left of the close button */
  actions?: ReactNode;
  /**
   * Keep the close button in its own flex row even with no actions. Set by
   * surfaces that can grow actions later and must not reflow when they do.
   */
  groupControls?: boolean;
}

export function ModalHeader({
  titleId,
  descId,
  title,
  description,
  onClose,
  closeLabel,
  tone = "default",
  actions,
  groupControls = false,
}: ModalHeaderProps) {
  const close = (
    <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel} title="Close (Esc)">
      <X className="h-4 w-4" />
    </Button>
  );
  const grouped = groupControls || actions !== undefined;

  return (
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
      {grouped ? (
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {close}
        </div>
      ) : (
        close
      )}
    </header>
  );
}
