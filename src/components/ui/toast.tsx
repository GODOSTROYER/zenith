"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/format";
import { Button } from "./button";
import { StatusDot, type DotStatus } from "./status-dot";

export type ToastKind = "ok" | "warn" | "err" | "info";

export interface ToastInput {
  title: string;
  /** one extra sentence — for errors, the fix */
  body?: string;
  kind?: ToastKind;
  /** the control that resolves the toast; the toast never covers it */
  action?: { label: string; onClick: () => void };
}

export interface ToastRecord extends ToastInput {
  id: string;
  kind: ToastKind;
  ts: string;
}

declare global {
  interface Window {
    /** Set by the app shell so every toast is mirrored into the Activity feed. */
    __zenithActivity?: (toast: ToastRecord) => void;
  }
}

/** Visible at once. Older ones are dropped from view — Activity keeps them all. */
const MAX_VISIBLE = 3;
const DISMISS_MS = 6000;

export interface ToastApi {
  toasts: ToastRecord[];
  push: (t: ToastInput) => string;
  dismiss: (id: string) => void;
}

interface ToastCtx extends ToastApi {
  pause: (id: string) => void;
  resume: (id: string) => void;
}

/**
 * Nullable by design: a missing provider must degrade to silence, never to a
 * thrown hook (a throw here white-screens whatever tree the toast lives in).
 */
const NO_PROVIDER: ToastCtx = {
  toasts: [],
  push: () => "",
  dismiss: () => {},
  pause: () => {},
  resume: () => {},
};

const ToastContext = createContext<ToastCtx | null>(null);

function useToastCtx(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx && process.env.NODE_ENV !== "production")
    console.warn(
      "useToasts() was called outside <ToastProvider>; notifications are dropped. Wrap the app shell (app/layout or the product shell) in <ToastProvider>."
    );
  return ctx ?? NO_PROVIDER;
}

/** Toast api: `push({ title, body?, kind, action? })`, `dismiss(id)`, `toasts`. */
export function useToasts(): ToastApi {
  return useToastCtx();
}

export interface ToastProviderProps {
  children: ReactNode;
  /** set false to place <Toaster/> yourself */
  renderToaster?: boolean;
}

/** Holds the toast queue and, by default, renders the bottom-left stack. */
export function ToastProvider({ children, renderToaster = true }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** the one place a timer dies — every removal path goes through here */
  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((list) => list.filter((x) => x.id !== id));
    },
    [clearTimer]
  );

  const arm = useCallback(
    (id: string) => {
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS)
      );
    },
    [clearTimer, dismiss]
  );

  const pause = clearTimer;

  const push = useCallback(
    (input: ToastInput) => {
      const toast: ToastRecord = {
        ...input,
        kind: input.kind ?? "info",
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        ts: new Date().toISOString(),
      };
      setToasts((list) => {
        const next = [...list, toast].slice(-MAX_VISIBLE);
        // dropped by the overflow trim — they leave the screen, so their
        // timers leave too (clearTimeout is idempotent under StrictMode)
        for (const t of list) if (!next.includes(t)) clearTimer(t.id);
        return next;
      });
      arm(toast.id);
      try {
        window.__zenithActivity?.(toast);
      } catch {
        /* mirroring to Activity must never break the notification */
      }
      return toast.id;
    },
    [arm, clearTimer]
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastCtx>(
    () => ({ toasts, push, dismiss, pause, resume: arm }),
    [toasts, push, dismiss, pause, arm]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {renderToaster && <Toaster />}
    </ToastContext.Provider>
  );
}

const DOT: Record<ToastKind, DotStatus> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  info: "info",
};

const EDGE: Record<ToastKind, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
};

/**
 * The notification stack — fixed bottom-LEFT so it never covers the map
 * toolbar (bottom-right) or any header. Hover pauses auto-dismiss.
 *
 * The deploy dock also lives along the bottom edge; it publishes its height as
 * `--zenith-dock-h` on <html> while mounted, and the stack sits above it, so
 * the two never overlap at any width.
 */
export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastCtx();
  if (toasts.length === 0) return null;

  return (
    <div
      className={cx(
        "pointer-events-none fixed left-4 z-[60] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2",
        "bottom-[calc(1rem+var(--zenith-dock-h,0px))] transition-[bottom] duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]"
      )}
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live={t.kind === "err" ? "assertive" : "polite"}
          onMouseEnter={() => pause(t.id)}
          onMouseLeave={() => resume(t.id)}
          onFocus={() => pause(t.id)}
          onBlur={() => resume(t.id)}
          className="animate-enter pointer-events-auto relative overflow-hidden rounded-card border border-line bg-bg3 shadow-overlay"
        >
          <span aria-hidden="true" className={cx("absolute inset-y-0 left-0 w-0.5", EDGE[t.kind])} />
          <div className="flex items-start gap-2.5 py-3 pr-2 pl-3.5">
            <StatusDot status={DOT[t.kind]} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[12.5px] text-ink-mute">{t.body}</p>}
              {t.action && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </Button>
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss notification"
              title="Dismiss"
              onClick={() => dismiss(t.id)}
              icon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
