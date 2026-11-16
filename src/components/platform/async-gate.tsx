"use client";
/**
 * The loading and error states every platform surface shares.
 *
 * A surface keeps its own heading while it loads or fails (the `Card` around it
 * does), so the page never jumps and a screen reader still finds the region.
 * Loading is a skeleton announced as a status, not a bare spinner. An error says
 * what went wrong in a sentence and only offers "Try again" when the host
 * actually supplied a way to retry: no dead controls.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Skeleton } from "@/components/ui/skeleton";

export interface AsyncSurfaceProps {
  /** true while the first load is in flight */
  loading?: boolean;
  /** what went wrong, as a sentence for a person; never a stack trace */
  error?: string | null;
  /** refetch; the "Try again" button only appears when this is supplied */
  onRetry?: () => void;
}

export interface SurfaceGateProps extends AsyncSurfaceProps {
  /** what is loading, for the announcements: "the timeline", "the plan" */
  what: string;
  /** how many skeleton rows to draw */
  rows?: number;
  children: ReactNode;
}

/** Renders a skeleton, an error notice, or its children, in that order of priority. */
export function SurfaceGate({ loading = false, error, onRetry, what, rows = 3, children }: SurfaceGateProps) {
  if (loading) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
        <span className="sr-only">Loading {what}…</span>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} height={i === 0 ? 20 : 14} width={i === 0 ? "40%" : `${92 - i * 12}%`} />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <Callout
        tone="err"
        title={`Could not load ${what}`}
        actions={
          onRetry ? (
            <Button size="sm" variant="quiet" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        <p>{error}</p>
        {!onRetry && <p className="mt-1 text-ink-mute">Reload the page to try again.</p>}
      </Callout>
    );
  }
  return <>{children}</>;
}
