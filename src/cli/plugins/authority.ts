import { createHash } from "node:crypto";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import type { PluginManifest } from "@/lib/plugins/manifest";
import { LaunchLease, LAUNCH_CHECK_PATH, type LaunchBinding } from "@/lib/plugins/launch-contract";
export { LaunchLease, LaunchBinding, LAUNCH_CHECK_PATH } from "@/lib/plugins/launch-contract";

export class LauncherError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Read live review AND a dedicated,
 * attenuated za_ child, never a parent bearer or a caller's self-asserted scope.
 * This endpoint is deliberately required; the legacy zp_ path is not a fallback. */
export interface LauncherAuthority {
  check(binding: LaunchBinding, token: string, signal?: AbortSignal): Promise<unknown>;
}
export const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");

export function assertLease(raw: unknown, binding: LaunchBinding, manifest: PluginManifest, previous?: LaunchLease): LaunchLease {
  const parsed = LaunchLease.safeParse(raw);
  if (!parsed.success) throw new LauncherError("launch_authority_refused");
  const lease = parsed.data;
  if (Object.entries(binding).some(([key, value]) => lease[key as keyof LaunchBinding] !== value) ||
      Date.parse(lease.expiresAt) <= Date.now() || Date.parse(lease.expiresAt) > Date.now() + 86_400_000 ||
      !lease.scopes.includes("read") ||
      lease.scopes.some((s) => !manifest.capabilities.scopes.includes(s)) ||
      lease.tools.some((t) => !manifest.capabilities.tools.includes(t) || !lease.scopes.includes(toolDescriptor(t)!.requiredScope))) {
    throw new LauncherError("launch_authority_refused");
  }
  // Narrowing stops and requires a new launch. The gateway and plugin never
  // keep running with an old, wider lease, and authority cannot broaden a run.
  if (previous && JSON.stringify(lease) !== JSON.stringify(previous)) throw new LauncherError("launch_authority_changed");
  return lease;
}

export function apiUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new LauncherError("invalid_api_origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new LauncherError("invalid_api_origin");
  }
  return url;
}

export function httpAuthority(origin: URL, fetcher: typeof fetch = fetch): LauncherAuthority {
  return { async check(binding, token, signal) {
    try {
      const response = await fetcher(new URL(LAUNCH_CHECK_PATH, origin), {
        method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(binding),
      });
      if (response.status === 401 || response.status === 403) throw new LauncherError("launch_authority_refused");
      if (!response.ok) throw new Error();
      // Read a bounded body; a missing/unwired endpoint, redirects or outages
      // refuse launch and terminate active runs rather than probing another API.
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 16_384) throw new Error();
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof LauncherError) throw error;
      throw new LauncherError("launch_authority_unavailable");
    }
  } };
}
