/** Admission to an owned, local default-stack rehearsal. Reads the published epoch; never repairs it. */
import assert from "node:assert/strict";
import type { Sql } from "@/lib/controlplane/types";

export const CORE_JOBS = ["engine", "alerts", "outbox", "housekeeping", "runner-reaper", "runbooks", "reconcile"] as const;
export function localUrl(raw: string, protocols: readonly string[]): URL {
  const url = new URL(raw);
  assert(protocols.includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Acceptance endpoints must be loopback.");
  return url;
}
export async function seededEpoch(db: Sql): Promise<string> {
  const rows = await db.query<{ singleton: boolean; installed_at: string; admitted: boolean }>("select singleton, installed_at::text, installed_at <= clock_timestamp() as admitted from platform.cleanup_writer_epoch");
  assert(rows.length === 1 && rows[0].singleton === true && rows[0].admitted && Number.isFinite(Date.parse(rows[0].installed_at)), "Migration-seeded cleanup epoch is missing or invalid; refuse without changing it.");
  return rows[0].installed_at;
}
export async function assertMaintenancePreconditions(db: Sql, env: NodeJS.ProcessEnv): Promise<string> {
  assert(env.ZENITH_TEST_MAINTENANCE === "1", "Requires ZENITH_TEST_MAINTENANCE=1.");
  localUrl(env.ZENITH_PLATFORM_DB_URL ?? "", ["postgres:", "postgresql:"]);
  localUrl(env.ZENITH_J4_API_ORIGIN ?? "", ["http:", "https:"]);
  assert(/^j4-[a-z0-9-]{1,50}$/.test(env.ZENITH_TEMPORAL_NAMESPACE ?? ""), "Requires an isolated j4-* Temporal namespace.");
  assert(/^(127\.0\.0\.1|localhost):\d+$/.test(env.ZENITH_TEMPORAL_ADDRESS ?? ""), "Temporal must be loopback.");
  assert(env.ZENITH_STORE === "postgres" && env.ZENITH_PLATFORM_DB === "postgres", "Requires the actual product/control PostgreSQL stores.");
  assert(env.ZENITH_BILLING === "managed" && !env.ZENITH_BILLING_STRIPE_SECRET_KEY, "Rehearsal uses real billing records without a Stripe account.");
  assert(env.ZENITH_SERVERLESS === "1", "Use the explicit serverless profile so only durable timers and requested fallback routes run.");
  assert(!env.ZENITH_CONTROL_KMS_KEY_ID, "Rehearsal needs the local ephemeral signer.");
  // Fresh dedicated database, not a production installation or another verifier's fixture.
  const existing = await db.query<{ count: number }>("select count(*)::int as count from platform.scheduled_job_runs");
  assert(existing[0].count === 0, "Requires a fresh dedicated maintenance database.");
  const connections = await db.query<{ count: number }>("select count(*)::int as count from platform.provider_connections");
  assert(connections[0].count === 0, "Default maintenance rehearsal must contain no provider connections.");
  return seededEpoch(db);
}
