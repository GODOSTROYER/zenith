/**
 * Runners and agent registration tokens (RUNNER-PROTOCOL.md sections 2 and 6).
 *
 * Registration: an admin creates a single-use token (at most one hour) that
 * names the workspace and the agent kind; only its SHA-256 is stored. The agent
 * presents the raw token once; `registerRunner` consumes the token and creates
 * the runner row in ONE transaction, taking the workspace from the token — never
 * from the caller — so an agent cannot register itself into a tenant it was not
 * invited to. A token that is unknown, expired, already used or of the wrong
 * kind yields the same `invalid_registration_token` (no oracle).
 *
 * Lookup for request authentication (`findRunnerForAuth`) is the ONE unscoped
 * read in this file: a signed request names only the agent id, and the agent's
 * own row is what says which workspace it belongs to. Every other function takes
 * a workspace id and filters on it in SQL.
 *
 * Staleness is derived, not stored: an active runner with no heartbeat for 90 s
 * (three missed 30 s beats) is `stale` and must not be dispatched to.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretKeys } from "../secrets";
import { boundedMs, json, newId, opt } from "../sql";

export const STALE_AFTER_SECONDS = 90;
export const MAX_REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/; // base64url of a raw 32-byte Ed25519 key

/* ----------------------------- registration tokens ---------------------------- */

export type AgentKind = "runner" | "machine";

/** `zrt_…` / `zmt_…` plus its hash. The raw token is shown to the admin once and never stored. */
export function generateRegistrationToken(kind: AgentKind): { token: string; tokenHash: string } {
  const token = `${kind === "runner" ? "zrt" : "zmt"}_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashRegistrationToken(token) };
}

export function hashRegistrationToken(token: string): string {
  return sha256Hex(requireText("token", token, 512));
}

export interface CreateRegistrationTokenInput {
  workspaceId: string;
  kind: AgentKind;
  /** for machines: optional `{ environmentId, address }` binding; must hold no secrets */
  binding?: Record<string, unknown>;
  createdBy: string;
  /** SHA-256 hex of the raw token (`generateRegistrationToken`) */
  tokenHash: string;
  /** default and maximum one hour */
  ttlMs?: number;
}

export async function createRegistrationToken(sql: Sql, input: CreateRegistrationTokenInput): Promise<{ tokenHash: string; expiresAt: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new ControlStoreError("invalid_input", "tokenHash must be the SHA-256 hex of the token (never the token itself).");
  if (input.kind !== "runner" && input.kind !== "machine") throw new ControlStoreError("invalid_input", "kind must be runner or machine.");
  assertNoSecretKeys(input.binding, "binding");
  const ttl = boundedMs("ttlMs", input.ttlMs ?? MAX_REGISTRATION_TOKEN_TTL_MS, 1000, MAX_REGISTRATION_TOKEN_TTL_MS);
  const rows = await sql.query<{ token_hash: string; expires_at: string }>(
    `insert into platform.runner_registration_tokens (token_hash, workspace_id, kind, binding, created_by, expires_at)
     values ($1, $2, $3, $4::text::jsonb, $5, clock_timestamp() + ($6::bigint * interval '1 millisecond'))
     returning token_hash, expires_at`,
    [input.tokenHash, requireText("workspaceId", input.workspaceId), input.kind, json(input.binding ?? {}), requireText("createdBy", input.createdBy), ttl]
  );
  return { tokenHash: rows[0].token_hash, expiresAt: rows[0].expires_at };
}

export interface ConsumedRegistrationToken {
  workspaceId: string;
  binding: Record<string, unknown>;
}

/**
 * Consume a token: succeeds exactly once, only while unexpired and of `kind`.
 * Returns the workspace and binding the token was issued for, or null.
 * Call inside the transaction that creates the agent row (`registerRunner` and
 * `registerMachine` do).
 */
export async function consumeRegistrationToken(
  sql: Sql,
  input: { tokenHash: string; kind: AgentKind; usedBy: string }
): Promise<ConsumedRegistrationToken | null> {
  const rows = await sql.query<{ workspace_id: string; binding: Record<string, unknown> }>(
    `update platform.runner_registration_tokens set used_at = clock_timestamp(), used_by = $3
      where token_hash = $1 and kind = $2 and used_at is null and expires_at > clock_timestamp()
      returning workspace_id, binding`,
    [input.tokenHash, input.kind, requireText("usedBy", input.usedBy)]
  );
  return rows.length ? { workspaceId: rows[0].workspace_id, binding: rows[0].binding } : null;
}

/* --------------------------------- runners ---------------------------------- */

export interface PlatformRunner {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "revoked";
  protocol: string;
  publicKey: string;
  version?: string;
  capabilities: string[];
  labels: Record<string, string>;
  host: Record<string, unknown>;
  registeredAt: string;
  lastHeartbeatAt?: string;
  revokedAt?: string;
  /** derived on the database clock: active and silent for 90 s */
  stale: boolean;
  /** the agent's own last heartbeat report (validated upstream, informational) */
  lifecycle: Record<string, unknown>;
  lifecycleReportedAt?: string;
}

interface RunnerRow {
  id: string;
  workspace_id: string;
  name: string;
  status: "active" | "revoked";
  protocol: string;
  public_key: string;
  version: string | null;
  capabilities: string[];
  labels: Record<string, string>;
  host: Record<string, unknown>;
  registered_at: string;
  last_heartbeat_at: string | null;
  revoked_at: string | null;
  stale: boolean;
  lifecycle: Record<string, unknown>;
  lifecycle_reported_at: string | null;
}

const RUNNER_COLUMNS = `id, workspace_id, name, status, protocol, public_key, version, capabilities, labels, host, registered_at, last_heartbeat_at, revoked_at, lifecycle, lifecycle_reported_at,
  (status = 'active' and coalesce(last_heartbeat_at, registered_at) < clock_timestamp() - interval '${STALE_AFTER_SECONDS} seconds') as stale`;

const toRunner = (row: RunnerRow): PlatformRunner => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  status: row.status,
  protocol: row.protocol,
  publicKey: row.public_key,
  version: opt(row.version),
  capabilities: row.capabilities,
  labels: row.labels,
  host: row.host,
  registeredAt: row.registered_at,
  lastHeartbeatAt: opt(row.last_heartbeat_at),
  revokedAt: opt(row.revoked_at),
  stale: row.stale,
  lifecycle: row.lifecycle ?? {},
  lifecycleReportedAt: opt(row.lifecycle_reported_at),
});

export interface RegisterRunnerInput {
  /** SHA-256 hex of the raw registration token the agent presented */
  tokenHash: string;
  /** default `run_<uuid>` */
  id?: string;
  name: string;
  /** base64url of the raw 32-byte Ed25519 public key */
  publicKey: string;
  version?: string;
  capabilities?: string[];
  labels?: Record<string, string>;
  host?: Record<string, unknown>;
}

/** Consume the token and create the runner, atomically. The workspace comes from the token. */
export async function registerRunner(sql: Sql, input: RegisterRunnerInput): Promise<PlatformRunner> {
  if (!PUBLIC_KEY.test(input.publicKey)) throw new ControlStoreError("invalid_input", "publicKey must be the base64url of a raw 32-byte Ed25519 key.", { field: "publicKey" });
  const id = input.id ?? newId("run");
  return sql.tx(async (tx) => {
    const token = await consumeRegistrationToken(tx, { tokenHash: input.tokenHash, kind: "runner", usedBy: id });
    if (!token) throw new ControlStoreError("invalid_registration_token", "The registration token is invalid, expired or already used.");
    const rows = await tx.query<RunnerRow>(
      `insert into platform.runners (id, workspace_id, name, public_key, version, capabilities, labels, host)
       values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8::text::jsonb)
       returning ${RUNNER_COLUMNS}`,
      [id, token.workspaceId, requireText("name", input.name, 200), input.publicKey, input.version ?? null, json(input.capabilities ?? []), json(input.labels ?? {}), json(input.host ?? {})]
    );
    return toRunner(rows[0]);
  });
}

export async function getRunner(sql: Sql, workspaceId: string, id: string): Promise<PlatformRunner | null> {
  const rows = await sql.query<RunnerRow>(
    `select ${RUNNER_COLUMNS} from platform.runners where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toRunner(rows[0]) : null;
}

export async function listRunners(sql: Sql, workspaceId: string): Promise<PlatformRunner[]> {
  const rows = await sql.query<RunnerRow>(
    `select ${RUNNER_COLUMNS} from platform.runners where workspace_id = $1 order by registered_at desc, id`,
    [requireText("workspaceId", workspaceId)]
  );
  return rows.map(toRunner);
}

/**
 * Authentication lookup by agent id ALONE — the only unscoped read here. The
 * returned row says which workspace the agent belongs to; the caller then
 * verifies the request signature against `publicKey` and refuses a revoked one.
 */
export async function findRunnerForAuth(sql: Sql, id: string): Promise<PlatformRunner | null> {
  const rows = await sql.query<RunnerRow>(`select ${RUNNER_COLUMNS} from platform.runners where id = $1`, [requireText("id", id)]);
  return rows.length ? toRunner(rows[0]) : null;
}

/** Record a heartbeat. `{ revoked: true }` tells the agent to stop; null when the runner is not in this workspace. */
export async function heartbeat(
  sql: Sql,
  input: { workspaceId: string; id: string; version?: string; capabilities?: string[]; host?: Record<string, unknown>; lifecycle?: Record<string, unknown> }
): Promise<{ revoked: boolean } | null> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  const updated = await sql.query<{ id: string }>(
    `update platform.runners
        set last_heartbeat_at = clock_timestamp(),
            version = coalesce($3::text, version),
            capabilities = coalesce($4::text::jsonb, capabilities),
            host = coalesce($5::text::jsonb, host),
            lifecycle = coalesce($6::text::jsonb, lifecycle),
            lifecycle_reported_at = case when $6::text is null then lifecycle_reported_at else clock_timestamp() end
      where workspace_id = $1 and id = $2 and status = 'active'
      returning id`,
    [workspaceId, id, input.version ?? null, input.capabilities ? json(input.capabilities) : null, input.host ? json(input.host) : null, input.lifecycle ? json(input.lifecycle) : null]
  );
  if (updated.length) return { revoked: false };
  const row = await sql.query<{ status: string }>("select status from platform.runners where workspace_id = $1 and id = $2", [workspaceId, id]);
  return row.length ? { revoked: row[0].status === "revoked" } : null;
}

/**
 * Revoke a runner (terminal) and cancel the jobs it has not started: queued and
 * claimed jobs become `cancelled`. A job already `running` is left for the
 * reaper — the runner may still be executing it, so its outcome is unknown, and
 * the operation it belongs to is reconciled to `uncertain`, never re-dispatched.
 */
export async function revokeRunner(sql: Sql, workspaceId: string, id: string): Promise<{ runner: PlatformRunner; cancelledJobs: number } | null> {
  const ws = requireText("workspaceId", workspaceId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<RunnerRow>(
      `update platform.runners set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp())
        where workspace_id = $1 and id = $2 returning ${RUNNER_COLUMNS}`,
      [ws, requireText("id", id)]
    );
    if (rows.length === 0) return null;
    const cancelled = await tx.query<{ id: string }>(
      `update platform.runner_jobs set status = 'cancelled', settled_at = clock_timestamp(), error = coalesce(error, 'runner revoked')
        where workspace_id = $1 and runner_id = $2 and status in ('queued','claimed') returning id`,
      [ws, id]
    );
    return { runner: toRunner(rows[0]), cancelledJobs: cancelled.length };
  });
}
