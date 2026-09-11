"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { TimeAgo } from "@/components/ui/time-ago";
import { type ToastRecord } from "@/components/ui/toast";
import { useShell } from "@/components/shell/shell-context";

const KEEP = 20;

/** Per-tab, so a reload keeps the buffer and a new tab starts clean. */
const STORE_KEY = "zenith-activity";

const DOT: Record<string, DotStatus> = { ok: "ok", warn: "warn", err: "err", info: "info" };

function read(): ToastRecord[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ToastRecord[]).slice(0, KEEP) : [];
  } catch {
    /* private mode or corrupt entry — an empty buffer is the honest fallback */
    return [];
  }
}

function write(items: ToastRecord[]): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(items));
  } catch {
    /* the in-memory buffer still works for this page */
  }
}

/**
 * Every toast also lands here, so a notification that auto-dismissed is never
 * simply gone — including across a refresh, which is exactly when someone
 * looks for the one they missed. The durable record lives on a project's
 * Activity tab, and every row here leads there; this panel is the last few
 * minutes, in reach from anywhere.
 */
export function ActivityBell() {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const pathname = usePathname();
  const { boot } = useShell();

  useEffect(() => setItems(read()), []);

  useEffect(() => {
    window.__zenithActivity = (toast) => {
      setItems((list) => {
        const next = [toast, ...list].slice(0, KEEP);
        write(next);
        return next;
      });
      setUnseen((n) => Math.min(n + 1, 99));
    };
    return () => {
      delete window.__zenithActivity;
    };
  }, []);

  /**
   * The trail these notifications end up in: the project you are looking at,
   * or the workspace's first one. With no project there is no trail yet, and
   * the rows stay plain text rather than pretending to lead somewhere.
   */
  const slug = /^\/p\/([^/]+)/.exec(pathname ?? "")?.[1] ?? boot?.projects[0]?.slug;
  const activityHref = slug ? `/p/${slug}/activity` : undefined;

  return (
    <Popover
      open={open}
      onClose={close}
      label="Recent notifications"
      role="dialog"
      width={340}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-haspopup="dialog"
          title={unseen ? `${unseen} recent notification(s)` : "Recent notifications"}
          onClick={() => {
            setOpen((o) => !o);
            setUnseen(0);
          }}
          icon={<Bell className="h-4 w-4" aria-hidden="true" />}
        >
          <span className="sr-only">Notifications</span>
          {unseen > 0 && (
            <span
              aria-hidden="true"
              className="tnum absolute -top-0.5 -right-0.5 min-w-[15px] rounded-full bg-signal px-1 text-[10px] leading-[15px] font-semibold text-on-signal"
            >
              {unseen}
            </span>
          )}
        </Button>
      }
    >
      <header className="flex items-baseline justify-between border-b border-line px-3.5 py-2.5">
        <h2 className="text-[13px] font-medium text-ink">Recent</h2>
        <span className="text-[11.5px] text-ink-faint">last {KEEP}</span>
      </header>
      <div className="max-h-[320px] overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[12.5px] text-ink-faint">
            Nothing yet. Actions you take show up here as they happen.
          </p>
        ) : (
          <ul>
            {items.map((t) => {
              const body = (
                <>
                  <StatusDot status={DOT[t.kind] ?? "info"} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] text-ink">{t.title}</span>
                    {t.body && <span className="mt-0.5 block text-[12px] text-ink-mute">{t.body}</span>}
                  </span>
                  <TimeAgo iso={t.ts} className="shrink-0 text-[11.5px] text-ink-faint" />
                </>
              );
              return (
                <li key={t.id} className="border-b border-line last:border-b-0">
                  {activityHref ? (
                    <Link
                      href={activityHref}
                      onClick={close}
                      title="Open the full activity trail"
                      className="flex items-start gap-2.5 px-3.5 py-2.5 transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)] hover:bg-bg2"
                    >
                      {body}
                    </Link>
                  ) : (
                    <span className="flex items-start gap-2.5 px-3.5 py-2.5">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <footer className="border-t border-line px-3.5 py-2">
        {activityHref ? (
          <Link
            href={activityHref}
            onClick={close}
            className="text-[12.5px] text-signal hover:underline"
          >
            See all activity →
          </Link>
        ) : (
          <span
            className="text-[12.5px] text-ink-faint"
            title="The durable trail lives on a project's Activity tab, and this workspace has no project yet."
          >
            No activity trail yet — create a project first.
          </span>
        )}
      </footer>
    </Popover>
  );
}
