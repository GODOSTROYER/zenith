/**
 * Composition root for signed runbooks (PROD-MACH-03).
 *
 * Everything authoritative is an existing piece, nothing parallel:
 *  - store         the platform control store (`machine_runbook_*`)
 *  - signing       the control-plane EdDSA key (`getControlSigner` / pinned verification keys)
 *  - roles         the capability broker's role resolver, re-asked on every call
 *  - step grants   one capability-broker operation per step: `propose` (policy and autonomy),
 *                  `beginExecution` (single-use signed grant), `completeExecution` / `markUncertain`.
 *                  A step the broker does not allow outright (`require_approval`, `deny`) FAILS; the
 *                  run-level human approval never substitutes for the broker's per-step decision.
 *  - transport     `executeMachineOperation` with the signed zenithd queue and durable evidence
 *
 * Targets are limited to registered zenithd machines: cloud-transport sessions need the product
 * store's provider connection for the environment, which this composition does not resolve.
 */
import { randomUUID } from "node:crypto";
import type { Principal } from "@/lib/controlplane/types";
import { platformBroker } from "@/lib/capabilities/platform";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { platformDb, repos } from "@/lib/controlplane/db";
import { withLease, LeaseUnavailableError } from "@/lib/controlplane/leases";
import { createPlatformRunbookStore } from "@/lib/controlplane/db/repos/machine-runbooks";
import { getControlSigner, getControlVerificationKeys } from "@/lib/credentials/signing";
import { createDefaultMachinePort } from "@/lib/machines/composition";
import { createMachineDrivers, createMachineSessionProvider } from "@/lib/machines";
import {
  RunbookError,
  createMachineStepExecutor,
  createRunbookService,
  executeRunbookRun,
  type RunbookAction,
  type RunbookService,
  type RunbookStore,
} from "@/lib/machines/runbooks";
import type { MachineTransport } from "@/lib/machines/types";
import { createRunbookStepGrant } from "@/lib/runbooks/delivery";
import { platformCredentialBroker } from "./credentials";
import { ensurePlatformApp } from "./app";

export const RUNBOOK_TRANSPORTS: readonly MachineTransport[] = ["zenithd"];
export const RUNBOOK_TICK_LEASE = "system:runbook-tick";

const ROLE_FOR: Record<RunbookAction, "viewer" | "editor" | "admin"> = { read: "viewer", publish: "editor", request: "editor", schedule: "editor", cancel: "editor", approve: "admin" };

export interface PlatformRunbooks {
  service: RunbookService;
  store: RunbookStore;
  /** Execute approved (or lease-expired running) runs, oldest first, within a wall-clock budget. */
  executeDueRuns(opts?: { budgetMs?: number; maxRuns?: number; signal?: AbortSignal }): Promise<{ executed: number; statuses: string[] }>;
}

type G = typeof globalThis & { __zenithRunbooks?: Promise<PlatformRunbooks> };

export function platformRunbooks(): Promise<PlatformRunbooks> {
  const g = globalThis as G;
  g.__zenithRunbooks ??= build().catch((e) => {
    delete g.__zenithRunbooks; // do not cache a failed composition
    throw e;
  });
  return g.__zenithRunbooks;
}

/** Test isolation only. */
export function resetPlatformRunbooksForTests(): void {
  delete (globalThis as G).__zenithRunbooks;
}

async function build(): Promise<PlatformRunbooks> {
  if (!(await ensurePlatformApp())) throw new RunbookError("forbidden", "The platform store is not configured; runbooks are unavailable.");
  const db = await platformDb();
  const secretKey = process.env.ZENITH_SECRET_KEY;
  if (!secretKey) throw new RunbookError("forbidden", "Runbook execution needs ZENITH_SECRET_KEY for machine evidence.");
  const signer = await getControlSigner();
  if (!signer) throw new RunbookError("forbidden", "No control-plane signing key is configured; runbooks cannot be signed or verified.");
  const store = createPlatformRunbookStore(db);
  const broker = await platformBroker();
  const credentials = platformCredentialBroker(db);
  const plane = createDefaultMachinePort(db, secretKey);
  const verificationKeys = () => getControlVerificationKeys();

  const service = createRunbookService({
    store,
    signer,
    verificationKeys,
    allowedTransports: RUNBOOK_TRANSPORTS,
    authorize: async (principal: Principal, workspaceId: string, action: RunbookAction) => {
      const access = await broker.deps.roles.resolve(principal, workspaceId);
      if (ROLE_RANK[access.role] < ROLE_RANK[ROLE_FOR[action]]) return false;
      // an agent credential needs the write scope for anything but a read
      if (principal.kind === "integration" && !access.integrationScopes?.includes(action === "read" ? "read" : "write")) return false;
      return true;
    },
  });

  const grantFor = createRunbookStepGrant({
    store, broker, verificationKeys,
    machine: (ws, id) => repos.machines.getMachine(db, ws, id),
    resource: (ws, id) => repos.resources.get(db, ws, id),
  });
  const executeStep = createMachineStepExecutor({
    drivers: createMachineDrivers({ dispatcher: plane.dispatcher }),
    evidence: plane.evidence,
    grantFor,
    sessionsFor: (grantJws, _req, ctx) => createMachineSessionProvider({ credentials, grantJws, signal: ctx.signal }),
  });

  async function executeDueRuns(opts: { budgetMs?: number; maxRuns?: number; signal?: AbortSignal } = {}): Promise<{ executed: number; statuses: string[] }> {
    const started = Date.now();
    const budget = Math.max(1_000, Math.min(opts.budgetMs ?? 45_000, 6 * 3600_000));
    const statuses: string[] = [];
    for (const candidate of await store.listClaimableRuns(new Date(), Math.max(1, Math.min(opts.maxRuns ?? 5, 25)))) {
      const remaining = budget - (Date.now() - started);
      if (remaining < 1_000 || opts.signal?.aborted) break;
      const signal = AbortSignal.any([AbortSignal.timeout(remaining), ...(opts.signal ? [opts.signal] : [])]);
      const done = await executeRunbookRun(
        { store, verificationKeys, executeStep, releaseOnAbort: true, actor: `system:runbook-runner:${randomUUID().slice(0, 8)}` },
        { workspaceId: candidate.workspaceId, runId: candidate.id, signal }
      );
      statuses.push(done.status);
    }
    return { executed: statuses.length, statuses };
  }

  return { service, store, executeDueRuns };
}

export interface RunbookTickResult {
  ran: boolean;
  created: number;
  missed: number;
  blocked: number;
  executed: number;
}

/**
 * One scheduler pass: decide due schedule slots, then execute claimable runs. Holds a short
 * control-store lease so overlapping instances take turns; correctness never depends on it
 * (slots are unique per schedule and the cursor and run claims are compare-and-set). Driven by
 * `/api/internal/tick/runbooks` and the in-process scheduler; all state is in PostgreSQL, so a
 * restart loses nothing and an expired run lease is reclaimed by the next pass.
 */
export async function runbookTickPass(opts: { budgetMs?: number; maxRuns?: number } = {}): Promise<RunbookTickResult> {
  if (!(await ensurePlatformApp())) return { ran: false, created: 0, missed: 0, blocked: 0, executed: 0 };
  const rb = await platformRunbooks();
  const db = await platformDb();
  const budget = Math.max(1_000, Math.min(opts.budgetMs ?? 45_000, 6 * 3600_000));
  try {
    return await withLease(
      db,
      { scope: RUNBOOK_TICK_LEASE, holder: `runbooks:${randomUUID()}`, ttlMs: Math.min(budget + 30_000, 300_000) },
      async (_lease, signal) => {
        const ticked = await rb.service.tickSchedules();
        const executed = await rb.executeDueRuns({ budgetMs: budget, maxRuns: opts.maxRuns, signal });
        return { ran: true, ...ticked, executed: executed.executed };
      }
    );
  } catch (e) {
    if (e instanceof LeaseUnavailableError) return { ran: false, created: 0, missed: 0, blocked: 0, executed: 0 };
    throw e;
  }
}
