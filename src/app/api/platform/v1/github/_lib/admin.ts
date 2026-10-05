/**
 * Shared human-admin guard for GitHub source routes: callback form, binding API and
 * inspection. Moved verbatim from the callback route so every writer takes the same
 * fresh-admin, installation-then-tenant lock order. Not a route module.
 */
import type { NextRequest } from "next/server";
import { platformDb } from "@/lib/controlplane/db/open";
import { db, isPostgres } from "@/lib/db/store";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { ApiError } from "@/lib/server/errors";
import { requireWorkspace } from "@/lib/server/workspace";
import { createGithubSourceStore, INSTALL_LIFETIME_MS } from "@/lib/sources/github/store";
import { GithubSourceError } from "@/lib/sources/github/types";
import { assertGithubWebhookFence, captureGithubWebhookFence, type GithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { isBrokerError } from "@/lib/capabilities/errors";
import { assertBrowserSession, expectedOrigin } from "../../_lib/browser";

export const GITHUB_CALLBACK_PATH = "/api/platform/v1/github/callback";
export const GITHUB_INSTALL_COOKIE = "zenith-github-install";
const PATH = GITHUB_CALLBACK_PATH;

export function callbackUrl(req: NextRequest): string {
  const origin = expectedOrigin(req); const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new GithubSourceError("unavailable");
  return `${origin}${PATH}`;
}

export function safeFailure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof GithubSourceError) throw new ApiError(error.message, { invalid: 400, refused: 403, conflict: 409, unavailable: 503 }[error.code]);
  throw new ApiError("GitHub source connection could not be confirmed. Start again.", 503);
}

export function cookieOptions(req: NextRequest) { return { httpOnly: true, secure: new URL(callbackUrl(req)).protocol === "https:", sameSite: "lax" as const, path: PATH, maxAge: INSTALL_LIFETIME_MS / 1000 }; }
export async function browserCaller(req: NextRequest, mutation: boolean) {
  try {
    const caller = await assertBrowserSession(req, { mutation });
    if (requireWorkspace().id !== caller.workspaceId) throw new ApiError("Select the workspace before connecting GitHub.", 403);
    return caller;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isBrokerError(error)) throw new ApiError(error.message, error.status);
    return safeFailure(error);
  }
}


/** Slow bodies and GitHub HTTP cannot retain an earlier admin/identity grant. */
async function freshBrowserAdmin(req: NextRequest, expected: Awaited<ReturnType<typeof browserCaller>>, mutation: boolean): Promise<void> {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(8_000)]);
  const unavailable = () => new ApiError("Workspace access could not be verified.", 503);
  const verify = async () => {
    if (signal.aborted) throw unavailable();
    const current = await browserCaller(req, mutation);
    // A late identity response may finish after rollback, but cannot reach the
    // member query or authorize a mutation after its deadline/cancellation.
    if (signal.aborted) throw unavailable();
    if (current.workspaceId !== expected.workspaceId || current.principal.id !== expected.principal.id) throw new ApiError("Workspace access changed. Start again.", 403);
    if (!isSupabaseConfigured()) return;
    if (isPostgres()) {
      // Request snapshots remain frozen; read the current authority directly.
      try {
        const { pgClient } = await import("@/lib/db/postgres-store");
        const { data, error } = await pgClient().from("members").select("id,role")
          .eq("workspace_id", current.workspaceId).eq("id", current.principal.id).abortSignal(signal).maybeSingle();
        if (signal.aborted || error) throw unavailable();
        if (data?.id !== current.principal.id || data.role !== "admin") throw new ApiError("Current workspace admin access is required.", 403);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw unavailable();
      }
    } else {
      const data = db();
      if (!data.workspaces.some(w => w.id === current.workspaceId) || !data.members.some(m => m.workspaceId === current.workspaceId && m.id === current.principal.id && m.role === "admin")) throw new ApiError("Current workspace admin access is required.", 403);
    }
  };
  // Rejecting this read-only wait releases transaction locks. Its eventual
  // resolution is handled here and never invokes the mutation callback.
  await new Promise<void>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(unavailable()); };
    signal.addEventListener("abort", abort, { once: true });
    void verify().then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}


/** Serialize first bindings as well as existing rows, then refresh human authority. */
export async function currentAdminMutation<T>(req: NextRequest, caller: Awaited<ReturnType<typeof browserCaller>>, mutation: boolean, fn: (store: ReturnType<typeof createGithubSourceStore>) => Promise<T>, installation?: Omit<GithubWebhookFence, "generation"> & { generation?: string }): Promise<T> {
  const database = await platformDb();
  return database.tx(async tx => {
    // Installation precedes tenant locks in browser and webhook writers alike.
    if (installation) {
      if (installation.generation !== undefined) await assertGithubWebhookFence(tx, { ...installation, generation: installation.generation });
      else await captureGithubWebhookFence(tx, installation.appId, installation.installationId);
    }
    // PostgreSQL transactions can wait on another first INSERT. A tenant lock
    // closes that wait before checking identity/roles, including an absent row.
    // PGlite serializes transactions through its engine instead of SQL locks.
    if (database.kind === "postgres") await tx.query("select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [caller.workspaceId]);
    await tx.query("select workspace_id from platform.github_source_bindings where workspace_id=$1 for update", [caller.workspaceId]);
    await freshBrowserAdmin(req, caller, mutation);
    return fn(createGithubSourceStore(tx, database.kind));
  });
}

