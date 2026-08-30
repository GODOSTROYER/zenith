import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export interface EmptyStateProps {
  /** a lucide icon element, e.g. `<Boxes className="h-5 w-5" />` */
  icon?: ReactNode;
  title: string;
  /** one sentence explaining what goes here and why it's empty */
  body?: ReactNode;
  /** the single obvious next step */
  action?: ReactNode;
  /** quieter secondary link/button */
  secondaryAction?: ReactNode;
  className?: string;
}

/** Centered empty state. Always names the next step — never a dead end. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className
      )}
    >
      {icon && (
        <span className="grid h-10 w-10 place-items-center rounded-card border border-line bg-bg2 text-ink-mute">
          {icon}
        </span>
      )}
      <div className="space-y-1.5">
        <h3 className="text-[15px] font-medium text-ink">{title}</h3>
        {body && <p className="mx-auto max-w-[46ch] text-[13px] text-ink-mute">{body}</p>}
      </div>
      {(action || secondaryAction) && (
        <div className="mt-1 flex items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
