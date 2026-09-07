/**
 * The banner every state uses, and the polite live region that announces a
 * save. One shape, so "saved", "denied" and "the host is not answering" all
 * read the same way and none of them can be mistaken for the others.
 *
 * Workstream W4 (hosted R3)
 */
import type { ReactNode } from "react";

export type NoticeTone = "info" | "good" | "warn" | "bad";

export function Notice({
  tone,
  title,
  children,
  actions,
  live,
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** true for messages that appear in response to something the person did */
  live?: boolean;
}) {
  return (
    <div
      className={`notice tone-${tone}`}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      <p className="notice-title">{title}</p>
      {children ? <div className="notice-body">{children}</div> : null}
      {actions ? <div className="notice-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * A permanently mounted live region. Mounting the region once and changing its
 * text is what makes an announcement reliable; mounting a new element with the
 * text already in it often is not.
 */
export function LiveNote({ message, tone }: { message: string; tone: NoticeTone }) {
  return (
    <p className={`live-note tone-${tone}`} role="status" aria-live="polite">
      {message}
    </p>
  );
}
