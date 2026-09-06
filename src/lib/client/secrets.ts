"use client";
/**
 * What `GET /api/secrets` answers, for the browser.
 *
 * The shape is declared here rather than imported from `@/lib/secrets`: that
 * module opens files and does AES, and nothing in a client bundle should be one
 * careless `import type` → `import` away from pulling it in.
 *
 * There is no value in any of this, and no route that returns one.
 */
import { useJson } from "@/lib/client/api";

/** Everything the store knows about one reference. Never the value. */
export interface SecretRow {
  /** e.g. "vault:STRIPE_API_KEY" */
  ref: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  /** 1 on first write, +1 per rotation */
  version: number;
  exists: true;
}

export interface SecretsView {
  configured: boolean;
  /** why the store cannot be written to, and the fix — only when unconfigured */
  reason?: string;
  fix?: string;
  secrets: SecretRow[];
}

/** References Zenith.ai itself holds, as opposed to a value in your own manager. */
export const OURS_PREFIX = "vault:";
export const isOurs = (ref: string): boolean => ref.startsWith(OURS_PREFIX);

/**
 * One fetch answers a whole surface. `workspaceId` is the server's own id, and
 * the server answers only for the caller's current workspace — passing it is how
 * a caller says which one it believed it was reading, and gets a 404 rather than
 * someone else's list if it was wrong.
 */
export function useSecrets(workspaceId?: string) {
  const { data, error, loading, refresh } = useJson<SecretsView>(
    workspaceId ? `/api/secrets?workspace=${encodeURIComponent(workspaceId)}` : "/api/secrets"
  );
  return { store: data, error, loading, refresh };
}
