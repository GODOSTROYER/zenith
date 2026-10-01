/** Type declarations for the dependency-free ESM fixture used by Vitest. */
import type { Server } from "node:http";
export function parseDatabaseUrl(raw: unknown): { host: string; port: number } | { error: string };
export function tcpCheck(host: string, port: number, timeoutMs: number): Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }>;
export function checkDatabase(env?: Readonly<Record<string, string | undefined>>, options?: { quiet?: boolean }): Promise<{ status: number; body: Record<string, unknown> }>;
export function createApp(env?: Readonly<Record<string, string | undefined>>): Server;
