/**
 * The edge shield (PROD-OPS-02): runs inside `src/middleware.ts` for `/api/*`.
 *
 * Edge runtime rules apply: no `node:` imports, no store, no async hashing. It
 * is deliberately the COARSE layer:
 *   - a per-client token bucket (client = trusted-header IP when configured,
 *     else a fingerprint of the credential on the request) sized well above any
 *     legitimate client, so it only stops floods before they reach the Node
 *     route layer, which applies the precise per-workspace limits;
 *   - the host-level `ZENITH_MAINTENANCE_MODE` override, which is the only
 *     maintenance state the edge can see without a database;
 *   - control lanes (runner polls, cron ticks, operator route, hosted gateway)
 *     are never limited here.
 * Each isolate holds its own buckets, so the effective ceiling scales with the
 * number of isolates; that is stated in the documented guarantee, and it is why
 * the per-workspace limit lives in the Node layer, not here.
 */
import { backpressureResponse, BackpressureError } from "./errors";
import { opsLimitsFromEnv, type OpsLimits } from "./config";
import { assertApiWritable, isControlLane } from "./maintenance";
import { TokenBucketLimiter } from "./token-bucket";

let cached: { limits: OpsLimits; limiter: TokenBucketLimiter; anon: TokenBucketLimiter; fingerprint: string } | undefined;

const ENV_KEYS = ["ZENITH_OPS_EDGE_RATE_PER_SEC", "ZENITH_OPS_EDGE_BURST", "ZENITH_OPS_EDGE_MAX_KEYS", "ZENITH_OPS_TRUSTED_IP_HEADER", "ZENITH_MAINTENANCE_MODE", "ZENITH_MAINTENANCE_REASON", "ZENITH_OPS_RETRY_AFTER_SEC"] as const;

function state(env: Readonly<Record<string, string | undefined>>): NonNullable<typeof cached> {
  const fingerprint = ENV_KEYS.map((k) => env[k] ?? "").join("\u0000");
  if (cached && cached.fingerprint === fingerprint) return cached;
  const limits = opsLimitsFromEnv(env);
  cached = {
    limits, fingerprint,
    limiter: new TokenBucketLimiter({ ratePerSec: limits.edge.ratePerSec, burst: limits.edge.burst }, limits.edge.maxKeys),
    // Unidentified callers share one generous bucket; 10x so it never throttles ordinary anonymous traffic.
    anon: new TokenBucketLimiter({ ratePerSec: limits.edge.ratePerSec * 10, burst: limits.edge.burst * 10 }, 1),
  };
  return cached;
}

/** Non-cryptographic 53-bit FNV-style fingerprint: a bucket key, never a security boundary. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface EdgeRequest { method: string; pathname: string; headers: Headers }

/** A key for the caller that never contains the credential itself. */
export function clientKey(req: EdgeRequest, trustedIpHeader: string | undefined): { key: string; identified: boolean } {
  const ip = trustedIpHeader ? req.headers.get(trustedIpHeader)?.split(",")[0]?.trim() : undefined;
  if (ip && ip.length <= 64) return { key: `ip:${ip.toLowerCase()}`, identified: true };
  const credential = req.headers.get("authorization") ?? req.headers.get("cookie");
  return credential ? { key: `c:${fingerprint(credential)}`, identified: true } : { key: "anon", identified: false };
}

/** A Response to send instead of the request, or null to continue. */
export function edgeAdmit(req: EdgeRequest, env: Readonly<Record<string, string | undefined>> = process.env): Response | null {
  if (!req.pathname.startsWith("/api/") || isControlLane(req.pathname)) return null;
  const s = state(env);
  try {
    if (s.limits.maintenanceOverride?.mode === "read_only") {
      assertApiWritable({ mode: "read_only", reason: s.limits.maintenanceOverride.reason, version: 0, source: "environment" }, req.pathname, req.method);
    }
    const who = clientKey(req, s.limits.edge.trustedIpHeader);
    const taken = (who.identified ? s.limiter : s.anon).take(who.key, 1);
    if (!taken.ok) throw new BackpressureError("rate_limited", "edge", "Too many requests from this client. Slow down and retry.", taken.retryAfterMs / 1000);
    return null;
  } catch (error) {
    if (error instanceof BackpressureError) return backpressureResponse(error);
    return null; // the shield must never be the outage
  }
}

/** Tests: drop cached limiter state. */
export function resetEdgeForTests(): void { cached = undefined; }
