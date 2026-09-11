/**
 * Shared fixtures for hosted tests. Integrator-owned; append, never rewrite.
 *
 * Call `isolatedDataDir()` at module top level BEFORE any `await import` of
 * application code: `@/lib/env` reads ZENITH_DATA on first use and the store
 * pins it on first import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isolatedDataDir(prefix = "zenith-hosted-"): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  process.env.ZENITH_DATA = dir;
  process.env.ZENITH_FAST = "1";
  return dir;
}

/** Best-effort cleanup; Windows keeps SQLite handles briefly, so retry. */
export function removeDir(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

export interface TestIdentity {
  subject: string;
  email: string;
  name: string;
}

/** Three grant holders and one stranger. Subjects are stable UUIDs. */
export const IDENTITIES = {
  owner: { subject: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", name: "Ona Owner" },
  editor: { subject: "22222222-2222-4222-8222-222222222222", email: "ed@example.test", name: "Ed Editor" },
  viewer: { subject: "33333333-3333-4333-8333-333333333333", email: "vi@example.test", name: "Vi Viewer" },
  stranger: { subject: "44444444-4444-4444-8444-444444444444", email: "st@example.test", name: "Stan Stranger" },
} as const satisfies Record<string, TestIdentity>;

export const WORKSPACES = {
  one: { id: "ws-one", name: "Workspace One", slug: "workspace-one" },
  two: { id: "ws-two", name: "Workspace Two", slug: "workspace-two" },
} as const;

export const APPS = {
  alpha: { slug: "alpha", name: "Alpha equipment tracker" },
  beta: { slug: "beta", name: "Beta equipment tracker" },
} as const;

export const uuid = (): string => crypto.randomUUID();
