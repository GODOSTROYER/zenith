/* eslint-disable @typescript-eslint/no-explicit-any */
// Types for zenith-verify-audit-export.mjs (PROD-OPS-09).
export function canonical(value: unknown): string;
export function genesisHash(workspaceId: string, previousHead: string | null): string;
export function entryHash(previous: string, event: unknown): string;
export function verifyAuditExport(doc: unknown, options: { keys: unknown; workspace?: string; previousHead?: string; ledger?: unknown }): { ok: boolean; errors: string[]; claims: any };
export function main(argv: string[], stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): number;
