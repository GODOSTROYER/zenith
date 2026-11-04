/**
 * Shared harness for the platform control store suites.
 *
 * Every suite runs on PGlite (always) and on real PostgreSQL when
 * `ZENITH_TEST_PLATFORM_PG_URL` is set, via `describe.each(LANES)`. The
 * Postgres lane migrates the shared `platform` schema in place (idempotently,
 * concurrently-safe) and never drops anything: tests isolate themselves with
 * fresh random workspace/environment ids instead of cleaning up.
 *
 * Two "handles" for race tests: on Postgres they are two independent pools
 * (two real backends, exactly as two serverless instances would be); on PGlite
 * there is one connection, so both are the same handle and the race is between
 * promises (correct, but serialised by PGlite's mutex).
 */
import { randomUUID } from "node:crypto";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import type { OperationProposal, OperationRecord, PolicyDecisionRecord, Principal, Sql } from "@/lib/controlplane/types";
import { proposeOperation, recordPolicyOutcome } from "@/lib/controlplane/operations";

export const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;

export interface Lane {
  name: "pglite" | "postgres";
  open(): Promise<PlatformDbHandle>;
  /** a second, independent handle when the engine has real connections; else the same one */
  independent: boolean;
}

export const LANES: Lane[] = [
  { name: "pglite", independent: false, open: () => openPlatformDb({ kind: "pglite" }) },
  ...(PG_URL
    ? [{ name: "postgres" as const, independent: true, open: () => openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 5 }) }]
    : []),
];

/** Open a lane and return the handle(s) plus a closer. */
export async function openLane(lane: Lane): Promise<{ db: PlatformDbHandle; db2: PlatformDbHandle; close(): Promise<void> }> {
  const db = await lane.open();
  const db2 = lane.independent ? await lane.open() : db;
  return {
    db,
    db2,
    close: async () => {
      if (db2 !== db) await db2.close();
      await db.close();
    },
  };
}

/* -------------------------------- fixtures --------------------------------- */

export const uid = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const newWorkspace = (): string => uid("ws");

export function user(id: string = uid("user"), name = "Alice Admin"): Principal {
  return { kind: "user", id, name };
}

export function agent(onBehalfOf: string = uid("user")): Principal {
  return { kind: "integration", id: uid("int"), name: "Codex", onBehalfOf, integrationId: uid("link") };
}

export function proposalFor(workspaceId: string, over: Partial<OperationProposal> = {}): OperationProposal {
  return {
    capability: "infrastructure.apply",
    scope: { workspaceId, projectId: "proj_1", environmentId: uid("env") },
    input: { service: "web", replicas: 3 },
    summary: "Scale web to 3 replicas",
    details: ["desired 2 -> 3"],
    risk: "medium",
    ...over,
  };
}

export interface SeededOperation {
  workspaceId: string;
  operation: OperationRecord;
  requester: Principal;
}

/** An `approved` operation that needs no approval (policy allow). */
export async function seedApprovedOperation(
  sql: Sql,
  workspaceId: string = newWorkspace(),
  over: { proposal?: Partial<OperationProposal>; ttlMs?: number; requester?: Principal } = {}
): Promise<SeededOperation> {
  const requester = over.requester ?? user();
  const { operation } = await proposeOperation(sql, {
    workspaceId,
    principal: requester,
    proposal: proposalFor(workspaceId, over.proposal),
    status: "approved",
    ttlMs: over.ttlMs,
  });
  return { workspaceId, operation, requester };
}

export interface SeededApproval extends SeededOperation {
  decision: PolicyDecisionRecord;
}

/** An operation awaiting approval, with a policy decision requiring `count` approvers. */
export async function seedAwaitingApproval(
  sql: Sql,
  opts: {
    workspaceId?: string;
    count?: number;
    minRole?: "editor" | "admin";
    separationOfDuties?: boolean;
    requester?: Principal;
    policyVersion?: string;
    proposal?: Partial<OperationProposal>;
  } = {}
): Promise<SeededApproval> {
  const workspaceId = opts.workspaceId ?? newWorkspace();
  const requester = opts.requester ?? user();
  const { operation } = await proposeOperation(sql, { workspaceId, principal: requester, proposal: proposalFor(workspaceId, opts.proposal) });
  const outcome = await recordPolicyOutcome(sql, {
    workspaceId,
    operationId: operation.id,
    decision: {
      policyVersion: opts.policyVersion ?? "a".repeat(64),
      inputDigest: "b".repeat(64),
      outcome: "require_approval",
      reasons: [{ code: "prod_change", message: "Production changes need approval." }],
      approval: { count: opts.count ?? 1, minRole: opts.minRole ?? "editor", separationOfDuties: opts.separationOfDuties ?? false },
    },
  });
  if (!outcome) throw new Error("seed: policy outcome was not applied");
  return { workspaceId, operation: outcome.operation, requester, decision: outcome.decision };
}

/** Approve an awaiting operation as `approver` (an editor by default). */
export async function approve(
  sql: Sql,
  seeded: SeededOperation,
  approver: Principal = user(),
  over: { role?: "viewer" | "editor" | "admin"; digest?: string; policyVersion?: string } = {}
) {
  return repos.approvals.record(sql, {
    workspaceId: seeded.workspaceId,
    operationId: seeded.operation.id,
    approver,
    approverRole: over.role ?? "editor",
    decision: "approve",
    proposalDigest: over.digest ?? seeded.operation.proposalDigest,
    policyVersion: over.policyVersion ?? "a".repeat(64),
  });
}

/** Backdate a column on one operation row (tests only), to exercise expiry deterministically. */
export async function backdate(sql: Sql, table: "operations" | "approvals" | "leases" | "runner_jobs", column: string, id: string, idColumn = "id"): Promise<void> {
  await sql.query(`update platform.${table} set ${column} = clock_timestamp() - interval '1 second' where ${idColumn} = $1`, [id]);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Assert a promise rejects with a ControlStoreError of `code`. */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<Record<string, unknown> | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; details?: Record<string, unknown> };
    if (e.code !== code) throw new Error(`expected error code "${code}" but got "${e.code}": ${(err as Error).message}`);
    return e.details;
  }
  throw new Error(`expected a rejection with code "${code}" but the promise resolved`);
}

/* ------------------------- scratch databases (Postgres) ---------------------- */

/**
 * Run `fn` against a brand-new, empty PostgreSQL database on the same server as
 * `ZENITH_TEST_PLATFORM_PG_URL`, and drop it afterwards. Used by the schema-level
 * tests (fresh migration, concurrent migrators, fail-closed open) so they never
 * touch the shared `platform` schema the other suites run in. Needs CREATEDB.
 */
export async function withScratchDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  if (!PG_URL) throw new Error("withScratchDatabase requires ZENITH_TEST_PLATFORM_PG_URL");
  const postgres = (await import("postgres")).default;
  const name = `zt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
    const target = new URL(PG_URL);
    target.pathname = `/${name}`;
    return await fn(target.toString());
  } finally {
    try {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}
