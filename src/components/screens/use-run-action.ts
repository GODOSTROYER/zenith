"use client";
/**
 * The action runner every screen shares: it turns an ApiError into a toast
 * that names its fix, and hands back `undefined` when the call failed.
 */
import { useCallback, useState } from "react";
import type { ActionResult } from "@/lib/actions/core";
import { ApiError, executeAction } from "@/lib/client/api";
import { useToasts } from "@/components/ui/toast";

/**
 * Kept as a name because screens import it. `useToasts()` itself now degrades
 * to a no-op outside a provider (see components/ui/toast.tsx), so this is a
 * plain hook call — no try/catch, no conditional hook, no "rendered fewer
 * hooks than expected" when a provider unmounts mid-tree.
 */
export const useSafeToasts = useToasts;

export interface Scope {
  projectId?: string;
  environmentId?: string;
}

/** Human sentence for anything thrown by the client spine. */
export function errorText(e: unknown): { message: string; fix?: string } {
  if (e instanceof ApiError) return { message: e.message, fix: e.fix };
  if (e instanceof Error) return { message: e.message };
  return { message: "Something went wrong.", fix: "Reload the page and try again." };
}

/**
 * Execute an action, toast the outcome, hand back the result.
 * Returns `undefined` when the call failed, so callers can `if (!r) return`.
 */
export function useRunAction(onSettled?: () => void) {
  const toasts = useSafeToasts();
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = useCallback(
    async (
      actionId: string,
      call: { input?: unknown; scope?: Scope },
      opts: { busyKey?: string; silent?: boolean } = {}
    ): Promise<ActionResult | undefined> => {
      setBusyId(opts.busyKey ?? actionId);
      try {
        const result = await executeAction(actionId, call);
        if (!result.ok) {
          toasts.push({
            kind: "err",
            title: result.summary,
            body: result.error ?? "The action did not complete.",
          });
        } else if (!opts.silent) {
          toasts.push({ kind: "ok", title: result.summary });
        }
        onSettled?.();
        return result.ok ? result : undefined;
      } catch (e) {
        const { message, fix } = errorText(e);
        toasts.push({ kind: "err", title: message, body: fix });
        return undefined;
      } finally {
        setBusyId(null);
      }
    },
    [toasts, onSettled]
  );

  return { run, busyId, busy: busyId !== null };
}
