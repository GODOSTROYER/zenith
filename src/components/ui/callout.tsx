import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/format";

export type CalloutTone = "info" | "ok" | "warn" | "err";

/** How loudly a notice is announced. `off` leaves the region out entirely. */
export type CalloutLive = "alert" | "status" | "off";

const TONES: Record<CalloutTone, { frame: string; ink: string; Icon: LucideIcon }> = {
  info: { frame: "border-info/30 bg-info-dim", ink: "text-info", Icon: Info },
  ok: { frame: "border-ok/30 bg-ok-dim", ink: "text-ok", Icon: CheckCircle2 },
  warn: { frame: "border-warn/30 bg-warn-dim", ink: "text-warn", Icon: AlertTriangle },
  err: { frame: "border-err/30 bg-err-dim", ink: "text-err", Icon: AlertTriangle },
};

/**
 * An error interrupts, a warning is announced politely, and the two calm tones
 * are read in document order like any other text. Notices used to pick this by
 * hand and disagree; the tone decides it now, and `live` is the way out.
 */
const LIVE: Record<CalloutTone, CalloutLive> = {
  err: "alert",
  warn: "status",
  ok: "off",
  info: "off",
};

export interface CalloutProps {
  tone: CalloutTone;
  /** one line above the body, when the notice needs a name */
  title?: ReactNode;
  children?: ReactNode;
  /** replaces the tone's own glyph; `null` removes it */
  icon?: ReactNode;
  /** the way out of the situation, under the body */
  actions?: ReactNode;
  /** override the tone's announcement: err → alert, warn → status, else off */
  live?: CalloutLive;
  /** the tighter box used inside panels and rows */
  compact?: boolean;
  className?: string;
}

/**
 * The one notice in the product: a hairline frame, its tone's dim ground, one
 * glyph, and whatever the surface has to say. Tokens only.
 */
export function Callout({
  tone,
  title,
  children,
  icon,
  actions,
  live,
  compact = false,
  className,
}: CalloutProps) {
  const { frame, ink, Icon } = TONES[tone];
  const announce = live ?? LIVE[tone];

  return (
    <div
      role={announce === "off" ? undefined : announce}
      className={cx(
        "flex gap-2.5 border",
        compact ? "rounded-ctl px-3 py-2 text-[12.5px]" : "rounded-card px-4 py-3 text-[13px]",
        frame,
        className
      )}
    >
      {icon === undefined ? (
        <Icon
          className={cx("mt-0.5 shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4", ink)}
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {/* No spacing between the slots beyond this: children keep whatever
          margins they arrived with, so migrating a notice does not reflow it. */}
      <div className="min-w-0 flex-1 text-ink">
        {/* a div, not a p: surfaces that own a heading pass their own h2/h3 in */}
        {title ? (
          <div className={cx("font-medium text-ink", children && "mb-1")}>{title}</div>
        ) : null}
        {children}
        {actions ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
