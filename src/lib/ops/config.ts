/**
 * Operator-tunable limits for the fair, bounded control plane (PROD-OPS-02).
 *
 * Every knob is an environment variable with a bounded range and a default that
 * is safe for a single-node install. An out-of-range or malformed value never
 * takes the API down: it falls back to the default and is reported in
 * `issues`, which the admission runtime logs once at start-up.
 *
 *   ZENITH_OPS_EDGE_RATE_PER_SEC              per-principal/IP refill, edge shield      (100)
 *   ZENITH_OPS_EDGE_BURST                     per-principal/IP burst                    (400)
 *   ZENITH_OPS_EDGE_MAX_KEYS                  distinct principals tracked               (10000)
 *   ZENITH_OPS_TRUSTED_IP_HEADER              x-forwarded-for | x-real-ip | x-vercel-forwarded-for
 *   ZENITH_OPS_API_RATE_PER_SEC               per-workspace API refill                  (50)
 *   ZENITH_OPS_API_BURST                      per-workspace API burst                   (200)
 *   ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT  per-workspace in-flight requests          (16)
 *   ZENITH_OPS_API_MAX_IN_FLIGHT              process-wide in-flight requests           (256)
 *   ZENITH_OPS_API_MAX_TENANTS                distinct workspaces tracked               (10000)
 *   ZENITH_OPS_DISPATCH_RATE_PER_SEC          per-workspace dispatch (execute) refill   (1)
 *   ZENITH_OPS_DISPATCH_BURST                 per-workspace dispatch burst              (10)
 *   ZENITH_OPS_MAX_ACTIVE_OPERATIONS          per-workspace queued+running operations   (25)
 *   ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT    per-workspace queued runner jobs          (200)
 *   ZENITH_OPS_RUNNER_QUEUE_MAX_GLOBAL        queued runner jobs, all workspaces        (5000)
 *   ZENITH_OPS_RETRY_AFTER_SEC                Retry-After for capacity refusals         (5)
 *   ZENITH_OPS_MAINTENANCE_CACHE_MS           how long a maintenance read is reused     (2000)
 *   ZENITH_MAINTENANCE_MODE                   host-level override: off | dispatch_paused | read_only
 *   ZENITH_MAINTENANCE_REASON                 text shown with the override
 *   ZENITH_OPS_ADMIN_IDS                      comma-separated Supabase user ids of platform operators
 *   ZENITH_WORKER_FAIR_CAPACITY               heavy-activity permits in the worker      (3/4 of activity slots)
 *   ZENITH_WORKER_FAIR_MAX_WAIT_MS            longest a heavy activity waits for a fair turn (15000)
 *
 * Leaf module: reads only the env object it is given, so the edge runtime can use it.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export interface OpsLimits {
  edge: { ratePerSec: number; burst: number; maxKeys: number; trustedIpHeader?: "x-forwarded-for" | "x-real-ip" | "x-vercel-forwarded-for" };
  api: { ratePerSec: number; burst: number; maxConcurrentPerTenant: number; maxInFlight: number; maxTenants: number };
  dispatch: { ratePerSec: number; burst: number; maxActiveOperations: number };
  runnerQueue: { maxPerTenant: number; maxGlobal: number };
  retryAfterSec: number;
  maintenanceCacheMs: number;
  maintenanceOverride?: { mode: "dispatch_paused" | "read_only"; reason: string };
  worker: { fairCapacity?: number; fairMaxWaitMs: number };
  issues: string[];
}

function bounded(env: Env, name: string, fallback: number, min: number, max: number, issues: string[], allowFloat = false): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  const shapeOk = allowFloat ? /^\d+(\.\d+)?$/.test(raw) : /^\d+$/.test(raw);
  if (!shapeOk || !Number.isFinite(value) || value < min || value > max) {
    issues.push(`${name} must be ${allowFloat ? "a number" : "a whole number"} from ${min} to ${max}; using ${fallback}`);
    return fallback;
  }
  return value;
}

const IP_HEADERS = ["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for"] as const;

export function opsLimitsFromEnv(env: Env = process.env): OpsLimits {
  const issues: string[] = [];
  const header = env.ZENITH_OPS_TRUSTED_IP_HEADER?.trim().toLowerCase();
  let trustedIpHeader: OpsLimits["edge"]["trustedIpHeader"];
  if (header) {
    if ((IP_HEADERS as readonly string[]).includes(header)) trustedIpHeader = header as typeof trustedIpHeader;
    else issues.push("ZENITH_OPS_TRUSTED_IP_HEADER must be x-forwarded-for, x-real-ip or x-vercel-forwarded-for; ignoring it");
  }
  const mode = env.ZENITH_MAINTENANCE_MODE?.trim().toLowerCase();
  let maintenanceOverride: OpsLimits["maintenanceOverride"];
  if (mode && mode !== "off") {
    if (mode === "dispatch_paused" || mode === "read_only") {
      maintenanceOverride = { mode, reason: (env.ZENITH_MAINTENANCE_REASON?.trim() || "Planned maintenance.").slice(0, 300) };
    } else issues.push("ZENITH_MAINTENANCE_MODE must be off, dispatch_paused or read_only; ignoring it");
  }
  const fairCapacityRaw = env.ZENITH_WORKER_FAIR_CAPACITY?.trim();
  return {
    edge: {
      ratePerSec: bounded(env, "ZENITH_OPS_EDGE_RATE_PER_SEC", 100, 0.1, 100_000, issues, true),
      burst: bounded(env, "ZENITH_OPS_EDGE_BURST", 400, 1, 100_000, issues),
      maxKeys: bounded(env, "ZENITH_OPS_EDGE_MAX_KEYS", 10_000, 100, 1_000_000, issues),
      ...(trustedIpHeader ? { trustedIpHeader } : {}),
    },
    api: {
      ratePerSec: bounded(env, "ZENITH_OPS_API_RATE_PER_SEC", 50, 0.1, 100_000, issues, true),
      burst: bounded(env, "ZENITH_OPS_API_BURST", 200, 1, 100_000, issues),
      maxConcurrentPerTenant: bounded(env, "ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT", 16, 1, 10_000, issues),
      maxInFlight: bounded(env, "ZENITH_OPS_API_MAX_IN_FLIGHT", 256, 1, 100_000, issues),
      maxTenants: bounded(env, "ZENITH_OPS_API_MAX_TENANTS", 10_000, 100, 1_000_000, issues),
    },
    dispatch: {
      ratePerSec: bounded(env, "ZENITH_OPS_DISPATCH_RATE_PER_SEC", 1, 0.01, 1000, issues, true),
      burst: bounded(env, "ZENITH_OPS_DISPATCH_BURST", 10, 1, 10_000, issues),
      maxActiveOperations: bounded(env, "ZENITH_OPS_MAX_ACTIVE_OPERATIONS", 25, 1, 100_000, issues),
    },
    runnerQueue: {
      maxPerTenant: bounded(env, "ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", 200, 1, 1_000_000, issues),
      maxGlobal: bounded(env, "ZENITH_OPS_RUNNER_QUEUE_MAX_GLOBAL", 5_000, 1, 10_000_000, issues),
    },
    retryAfterSec: bounded(env, "ZENITH_OPS_RETRY_AFTER_SEC", 5, 1, 3600, issues),
    maintenanceCacheMs: bounded(env, "ZENITH_OPS_MAINTENANCE_CACHE_MS", 2_000, 0, 60_000, issues),
    ...(maintenanceOverride ? { maintenanceOverride } : {}),
    worker: {
      ...(fairCapacityRaw ? { fairCapacity: bounded(env, "ZENITH_WORKER_FAIR_CAPACITY", 1, 1, 1000, issues) } : {}),
      fairMaxWaitMs: bounded(env, "ZENITH_WORKER_FAIR_MAX_WAIT_MS", 15_000, 0, 45_000, issues),
    },
    issues,
  };
}

/** Platform operators: explicit user ids, never a workspace role. */
export function opsAdminIds(env: Env = process.env): ReadonlySet<string> {
  return new Set((env.ZENITH_OPS_ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-fA-F-]{36}$/.test(s)));
}
