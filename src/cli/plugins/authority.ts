import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import { INTEGRATION_SCOPES, TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import type { PluginManifest } from "@/lib/plugins/manifest";

export class LauncherError extends Error {
  constructor(readonly code: string) { super(code); }
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const ids = z.array(id).min(1).max(100).refine((v) => new Set(v).size === v.length);
export const LaunchLease = z.strictObject({
  status: z.literal("active"),
  credentialKind: z.literal("plugin_scoped_za"),
  registrationId: id,
  workspaceId: id,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
  audience: z.string().url(),
  projectIds: ids,
  environmentIds: ids,
  tools: z.array(z.enum(TOOL_NAMES)).min(1).refine((v) => new Set(v).size === v.length),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1).refine((v) => new Set(v).size === v.length),
  expiresAt: z.string().datetime(),
});
export type LaunchLease = z.infer<typeof LaunchLease>;
export interface LaunchBinding {
  registrationId: string;
  workspaceId: string;
  manifestDigest: string;
  credentialDigest: string;
  audience: string;
}
/** Join owned by the platform integrator: read live review AND a dedicated,
 * attenuated za_ child, never a parent bearer or a caller's self-asserted scope.
 * This endpoint is deliberately required; the legacy zp_ path is not a fallback. */
export interface LauncherAuthority {
  check(binding: LaunchBinding, token: string, signal?: AbortSignal): Promise<unknown>;
}
export const LAUNCH_CHECK_PATH = "/api/integrations/plugins/launch/check";
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
    } catch { throw new LauncherError("launch_authority_unavailable"); }
  } };
}
