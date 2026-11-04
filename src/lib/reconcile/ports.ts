/**
 * Where the pass gets its ports.
 *
 * Production ports (the platform control store, the capability broker, the
 * credential broker, the Temporal client) are assembled by the orchestrator at
 * integration and registered once with `wireReconcilePorts()`. Until then the
 * factory refuses: a reconciliation pass that silently ran against nothing
 * would report "0 drift" for a fleet it never looked at, which is the one lie
 * this controller must not tell. The explicit exception is
 * `ZENITH_RECONCILE_MEMORY=1` (local development and route smoke tests), which
 * runs against the in-memory backend — empty unless something seeded it.
 *
 * The registration lives on `globalThis` (like the driver registry): a Next
 * build can evaluate this module more than once, and the wiring must be seen
 * by every copy.
 */
import { ReconcileError } from "./errors";
import { MemoryReconcileBackend } from "./memory";
import type { ReconcilePassPorts } from "./pass-types";

export type ReconcilePortsFactory = () => ReconcilePassPorts | Promise<ReconcilePassPorts>;

type G = typeof globalThis & { __zenithReconcilePorts?: ReconcilePortsFactory; __zenithReconcileMemory?: MemoryReconcileBackend };

/** Register (or, with `null`, clear) the production ports. The orchestrator calls this at boot. */
export function wireReconcilePorts(factory: ReconcilePortsFactory | null): void {
  const g = globalThis as G;
  if (factory) g.__zenithReconcilePorts = factory;
  else delete g.__zenithReconcilePorts;
}

export const reconcileWired = (): boolean => (globalThis as G).__zenithReconcilePorts !== undefined;

export const RECONCILE_MEMORY_ENV = "ZENITH_RECONCILE_MEMORY";

/** The process-wide in-memory backend (created on first use). Seed it from dev tooling or tests. */
export function memoryReconcileBackend(): MemoryReconcileBackend {
  const g = globalThis as G;
  if (!g.__zenithReconcileMemory) g.__zenithReconcileMemory = new MemoryReconcileBackend();
  return g.__zenithReconcileMemory;
}

/** Drop the in-memory backend (tests). */
export function resetMemoryReconcileBackend(): void {
  delete (globalThis as G).__zenithReconcileMemory;
}

/**
 * The ports for this process: the wired production ports, else the in-memory
 * backend when `ZENITH_RECONCILE_MEMORY=1`, else `platform_store_unavailable`.
 */
export async function reconcilePassPorts(): Promise<ReconcilePassPorts> {
  const wired = (globalThis as G).__zenithReconcilePorts;
  if (wired) return wired();
  if (process.env[RECONCILE_MEMORY_ENV] === "1") return memoryReconcileBackend().passPorts();
  throw new ReconcileError(
    "platform_store_unavailable",
    `The reconciliation controller has no platform store: no ports were wired into this process. Wire them with wireReconcilePorts() at boot, or set ${RECONCILE_MEMORY_ENV}=1 for local development (in-memory, nothing durable).`
  );
}
