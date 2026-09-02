"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Button, StatusDot, TimeAgo, type DotStatus, type ToastRecord } from "@/components/ui";
import { useModal } from "@/components/ui/use-modal";
import { cx } from "@/lib/format";

const KEEP = 20;

/** Per-tab, so a reload keeps the buffer and a new tab starts clean. */
const STORE_KEY = "orrery-activity";

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
 * looks for the one they missed. The durable record lives on the project's
 * Activity tab; this is the last few minutes, in reach from anywhere.
 */
export function ActivityBell() {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  // Focus trap, ESC and focus restore, from the same primitive Dialog uses.
  const { ref: panel, present } = useModal(open, close);

  useEffect(() => setItems(read()), []);

  useEffect(() => {
    window.__orreryActivity = (toast) => {
      setItems((list) => {
        const next = [toast, ...list].slice(0, KEEP);
        write(next);
        return next;
      });
      setUnseen((n) => Math.min(n + 1, 99));
    };
    return () => {
      delete window.__orreryActivity;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={box} className="relative">
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

      {present && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Recent notifications"
          tabIndex={-1}
          className="animate-enter absolute top-full right-0 z-50 mt-2 w-[340px] overflow-hidden rounded-card border border-line bg-bg3 shadow-overlay outline-none"
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
                {items.map((t) => (
                  <li
                    key={t.id}
                    className={cx(
                      "flex items-start gap-2.5 border-b border-line px-3.5 py-2.5 last:border-b-0"
                    )}
                  >
                    <StatusDot status={DOT[t.kind] ?? "info"} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] text-ink">{t.title}</p>
                      {t.body && <p className="mt-0.5 text-[12px] text-ink-mute">{t.body}</p>}
                    </div>
                    <TimeAgo iso={t.ts} className="shrink-0 text-[11.5px] text-ink-faint" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
