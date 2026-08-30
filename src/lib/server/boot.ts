/**
 * Per-process boot. Every API route calls `ensureBoot()` first.
 *
 * Registers actions + providers and resumes any deployment that was in flight
 * when the server restarted (durable operations: a restart never strands a
 * deployment). All workstream modules have landed, so imports are literal and
 * verified at build time.
 */
import type { SecurityFinding } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { engine, ensureEngine } from "@/lib/engine/engine";
import { registerAllActions } from "@/lib/actions/defs";
import * as security from "@/lib/security/rules";
import * as logsim from "@/lib/logsim";

type G = typeof globalThis & { __orreryBoot?: Promise<void> };

/* ------------------------- module accessors (typed) ------------------------ */

interface EngineModule {
  engine: typeof engine;
  ensureEngine: typeof ensureEngine;
}

export const engineModule = async (): Promise<EngineModule> => ({ engine, ensureEngine });

export interface SecurityModule {
  syncFindings?: (projectId: string) => SecurityFinding[] | void;
}

export const securityModule = async (): Promise<SecurityModule> => security;

export interface LogLine {
  seq: number;
  ts: string;
  line: string;
  stream?: string;
}

export interface LogsimModule {
  getServiceLogs?: (environmentId: string, serviceId: string, afterSeq: number) => LogLine[];
  /** health for every managed service in an environment, keyed by service id */
  environmentHealth?: (environmentId: string) => Record<string, unknown>;
}

export const logsimModule = async (): Promise<LogsimModule> =>
  logsim as unknown as LogsimModule;

/* ---------------------------------- boot ---------------------------------- */

async function boot(): Promise<void> {
  ensureEngine(); // also registers every provider adapter
  engine.resumeInFlight();
  registerAllActions();
  if (providerRegistry().size === 0)
    console.warn("[orrery/boot] no providers registered — provider pickers will be empty.");
}

/** Idempotent per process (and across Next HMR reloads). */
export function ensureBoot(): Promise<void> {
  const g = globalThis as G;
  g.__orreryBoot ??= boot().catch((err) => {
    console.error("[orrery/boot] failed", err);
  });
  return g.__orreryBoot;
}
