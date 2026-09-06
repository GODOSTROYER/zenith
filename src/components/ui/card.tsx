import type { ReactNode } from "react";
import { cx } from "@/lib/format";

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** right-aligned header controls */
  actions?: ReactNode;
  footer?: ReactNode;
  /** false when the body manages its own padding (tables, maps, logs) */
  padded?: boolean;
  /** production surfaces carry the prod ring everywhere they appear */
  prod?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/** Raised surface: hairline border, card radius, subtle depth. */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  padded = true,
  prod = false,
  className,
  bodyClassName,
  children,
}: CardProps) {
  const hasHeader = Boolean(title || subtitle || actions);
  return (
    <section
      className={cx(
        "min-w-0 rounded-card border border-line bg-bg2",
        prod && "ring-1 ring-prod/45",
        className
      )}
    >
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h3 className="text-[16px] font-medium text-ink">{title}</h3>}
            {subtitle && (
              <p className="mt-0.5 text-[12.5px] text-ink-mute">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(padded && "p-5", bodyClassName)}>{children}</div>
      {footer && (
        <footer className="border-t border-line px-5 py-3 text-[12.5px] text-ink-mute">
          {footer}
        </footer>
      )}
    </section>
  );
}
