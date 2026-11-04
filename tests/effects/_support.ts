/** Shared fixtures for the external-effect ledger suites. PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set. */
import { randomUUID } from "node:crypto";
import * as store from "@/lib/controlplane/db/repos/external-effects";
import * as leases from "@/lib/controlplane/db/repos/leases";
import type { Lease, Sql } from "@/lib/controlplane/types";
import { buildReadback } from "@/lib/effects/binding";
import type { EffectFamily, EffectRecord, EffectState, ProviderReceipt, Readback } from "@/lib/effects/types";
import { seedApprovedOperation } from "../controlplane/_support/harness";

export const HEX = (c: string): string => c.repeat(64);

export interface Seed {
  workspaceId: string;
  operationId: string;
  environmentId: string;
}

export async function seed(db: Sql, workspaceId?: string): Promise<Seed> {
  const s = await seedApprovedOperation(db, workspaceId);
  return { workspaceId: s.workspaceId, operationId: s.operation.id, environmentId: s.operation.environmentId! };
}

export const uniqueKey = (prefix = "build"): string => `${prefix}:${randomUUID()}`;

export async function begin(db: Sql, s: Seed, over: Partial<store.BeginEffectInput> = {}): Promise<{ created: boolean; effect: EffectRecord }> {
  return store.begin(db, {
    workspaceId: s.workspaceId, family: "build_launch", operationId: s.operationId, environmentId: s.environmentId, provider: "aws",
    dedupKey: uniqueKey(), requestDigest: HEX("a"), target: { region: "us-east-1" }, idempotencyToken: "zn-test-token", idempotencySupported: true,
    actor: "test", ...over,
  });
}

export async function lease(db: Sql, s: Seed, ttlMs = 60_000): Promise<Lease> {
  const l = await leases.acquire(db, { scope: `env:${s.environmentId}`, holder: `holder:${randomUUID()}`, ttlMs, workspaceId: s.workspaceId });
  if (!l) throw new Error("lease not acquired");
  return l;
}

export const receipt = (id = "proj:11111111-1111-1111-1111-111111111111", req = "req-1"): ProviderReceipt => ({ resourceId: id, requestIds: [req] });

export function readback(over: Partial<Omit<Readback, "digest">> = {}): Readback {
  return buildReadback({ outcome: "present", source: "test.readback", observedAt: new Date().toISOString(), resourceId: "proj:11111111-1111-1111-1111-111111111111", requestIds: ["rb-1"], facts: { matches: 1 }, ...over });
}

/**
 * An already-unresolved effect whose history is in the past. The trigger makes identity (including created_at)
 * immutable, so aged evidence can only be created by inserting the row directly.
 */
export async function insertAged(db: Sql, s: Seed, o: {
  state: Extract<EffectState, "uncertain" | "conflict" | "pending">;
  ageMs?: number;
  family?: EffectFamily;
  fence?: { scope: string; token: number };
  receipt?: ProviderReceipt;
  dedupKey?: string;
}): Promise<EffectRecord> {
  const effectId = `fx_${randomUUID()}`;
  const age = `${Math.trunc((o.ageMs ?? 3_600_000) / 1000)} seconds`;
  await db.query(
    `insert into platform.external_effects
       (workspace_id, effect_id, family, operation_id, environment_id, provider, dedup_key, request_digest, target, idempotency_supported,
        fence_scope, fence_epoch, state, provider_receipt, uncertain_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'aws', $6, $7, '{}'::jsonb, false, $8, $9::bigint, $10, $11::text::jsonb,
        case when $10 = 'pending' then null else clock_timestamp() - ($12::text)::interval end,
        clock_timestamp() - ($12::text)::interval, clock_timestamp() - ($12::text)::interval)`,
    [s.workspaceId, effectId, o.family ?? "build_launch", s.operationId, s.environmentId, o.dedupKey ?? uniqueKey(), HEX("b"),
      o.fence?.scope ?? null, o.fence?.token ?? null, o.state, o.receipt ? JSON.stringify(o.receipt) : null, age]
  );
  const got = await store.get(db, s.workspaceId, effectId);
  if (!got) throw new Error("aged effect missing");
  return got;
}
