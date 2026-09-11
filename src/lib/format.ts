/**
 * Presentation formatting shared by every surface — the one place money,
 * times and durations are turned into strings.
 *
 * Knows nothing about the domain: no manifest, no store, no React. Naming
 * (slugs for manifest node names) is a domain rule, not a format one, and
 * lives in `@/lib/importers/types`.
 */
import clsx from "clsx";

/** Class-name joiner (clsx re-export). */
export const cx = clsx;

/** U+2009 THIN SPACE — thousands separator for costs. */
const THIN = " ";
/** U+2212 MINUS SIGN — typographic minus, never a hyphen. */
const MINUS = "−";

interface FmtUsdOptions {
  /** render a leading "+" for positive values (deltas) */
  sign?: boolean;
}

/**
 * USD, always 2dp, thin-space thousands: `$1 240.00`, `−$12.50`, `+$3.00`.
 * Values under half a cent render as `$0.00` (never `−$0.00`).
 */
export function fmtUsd(n: number, opts: FmtUsdOptions = {}): string {
  const safe = Number.isFinite(n) ? n : 0;
  const zero = Math.abs(safe) < 0.005;
  const [int, frac] = Math.abs(safe).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  const prefix = zero ? "" : safe < 0 ? MINUS : opts.sign ? "+" : "";
  return `${prefix}$${grouped}.${frac}`;
}

/** Local medium date + short time. Falls back to the raw string if unparseable. */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Compact relative time: `just now`, `4m ago`, `2h ago`, `3d ago`, then the date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const deltaMs = now - t;
  const ahead = deltaMs < 0;
  const s = Math.floor(Math.abs(deltaMs) / 1000);
  if (s < 45) return ahead ? "in a moment" : "just now";
  const unit =
    s < 3600
      ? `${Math.round(s / 60)}m`
      : s < 86400
        ? `${Math.round(s / 3600)}h`
        : s < 86400 * 7
          ? `${Math.round(s / 86400)}d`
          : null;
  if (!unit) return fmtDate(iso);
  return ahead ? `in ${unit}` : `${unit} ago`;
}

/** Step/phase durations: `840ms`, `4.2s`, `1m 12s`. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}
