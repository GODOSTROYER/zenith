"use client";
/** Session-only, same-origin calls. Origin is supplied by the browser, not fabricated by UI code. */
import { api } from "@/lib/client/api";
export function browserMutation<T>(workspaceId: string, path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  if (!path.startsWith("/api/platform/v1/") && path !== "/platform/connections/aws/action") throw new Error("Use a platform or product action endpoint.");
  return api<T>(path, { method, credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, body: JSON.stringify(body) });
}
/** Never echo unknown fetch errors or external server messages into the UI. */
export function mutationError(error: unknown): string {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  if (status === 401) return "Sign in again, then reload before retrying.";
  if (status === 403) return "The server refused this action. Check your workspace role, browser session and policy, then reload.";
  if (status === 404) return "This item is no longer available in the selected workspace. Reload the page.";
  if (status === 409) return "The reviewed state changed or this decision was already recorded. Reload before retrying.";
  return "The action could not be confirmed. Reload to check the current state before retrying.";
}

/** Same-origin session read for live progress; GET only, platform or product read endpoints only. */
export function browserRead<T>(workspaceId: string, path: string, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith("/api/platform/v1/") && !/^\/api\/deployments\/[A-Za-z0-9_-]{1,100}$/.test(path)) throw new Error("Use a platform read endpoint.");
  return api<T>(path, { method: "GET", credentials: "same-origin", headers: { "x-zenith-workspace": workspaceId }, signal });
}
