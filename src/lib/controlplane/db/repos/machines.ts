/**
 * The machine registry (`MachineTransport`, `machines/types.ts`).
 *
 * Two kinds of row share one table:
 *  - `zenithd` machines register themselves with a single-use registration
 *    token (same rules as runners: the token is consumed in the same
 *    transaction that creates the row; the workspace and the optional
 *    environment/address binding come from the token, never from the agent).
 *  - Transport-addressed targets (`aws_ssm`, `kubernetes`, …) are upserted by
 *    the control plane from the resource graph; they have no agent identity.
 *
 * `findMachineForAuth` is, like its runner counterpart, the one unscoped read:
 * a signed request names only the machine id. Everything else is workspace
 * scoped in SQL. A revoked machine is terminal.
 */
import type { MachineTransport } from "@/lib/machines/types";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { json, newId, opt } from "../sql";
import { STALE_AFTER_SECONDS, consumeRegistrationToken } from "./runners";

export interface PlatformMachine {
  id: string;
  workspaceId: string;
  environmentId?: string;
  /** the resource address this machine realises, when it maps to one */
  address?: string;
  name: string;
  transport: MachineTransport;
  /** EC2 instance id, `namespace/pod[/container]`, or the zenithd machine id */
  targetId: string;
  status: "pending" | "active" | "revoked";
  publicKey?: string;
  version?: string;
  capabilities: string[];
  labels: Record<string, string>;
  host: Record<string, unknown>;
  registeredAt: string;
  lastHeartbeatAt?: string;
  revokedAt?: string;
  /** zenithd only: active and silent for 90 s. Always false for transport targets (they do not heartbeat). */
  stale: boolean;
  /** the agent's own last heartbeat report (validated upstream, informational) */
  lifecycle: Record<string, unknown>;
  lifecycleReportedAt?: string;
}

interface MachineRow {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  address: string | null;
  name: string;
  transport: MachineTransport;
  target_id: string;
  status: PlatformMachine["status"];
  public_key: string | null;
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

const COLUMNS = `id, workspace_id, environment_id, address, name, transport, target_id, status, public_key, version, capabilities, labels, host,
  registered_at, last_heartbeat_at, revoked_at, lifecycle, lifecycle_reported_at,
  (transport = 'zenithd' and status = 'active' and coalesce(last_heartbeat_at, registered_at) < clock_timestamp() - interval '${STALE_AFTER_SECONDS} seconds') as stale`;

const toMachine = (row: MachineRow): PlatformMachine => ({
  id: row.id,
  workspaceId: row.workspace_id,
  environmentId: opt(row.environment_id),
  address: opt(row.address),
  name: row.name,
  transport: row.transport,
  targetId: row.target_id,
  status: row.status,
  publicKey: opt(row.public_key),
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

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface RegisterMachineInput {
  tokenHash: string;
  id?: string;
  name: string;
  publicKey: string;
  version?: string;
  capabilities?: string[];
  labels?: Record<string, string>;
  host?: Record<string, unknown>;
}

/** Consume a `machine` registration token and create the zenithd machine, atomically. */
export async function registerMachine(sql: Sql, input: RegisterMachineInput): Promise<PlatformMachine> {
  if (!PUBLIC_KEY.test(input.publicKey)) throw new ControlStoreError("invalid_input", "publicKey must be the base64url of a raw 32-byte Ed25519 key.", { field: "publicKey" });
  const id = input.id ?? newId("mac");
  return sql.tx(async (tx) => {
    const token = await consumeRegistrationToken(tx, { tokenHash: input.tokenHash, kind: "machine", usedBy: id });
    if (!token) throw new ControlStoreError("invalid_registration_token", "The registration token is invalid, expired or already used.");
    const environmentId = typeof token.binding.environmentId === "string" ? token.binding.environmentId : null;
    const address = typeof token.binding.address === "string" ? token.binding.address : null;
    const rows = await tx.query<MachineRow>(
      `insert into platform.machines (id, workspace_id, environment_id, address, name, transport, target_id, public_key, version, capabilities, labels, host)
       values ($1, $2, $3, $4, $5, 'zenithd', $1, $6, $7, $8::text::jsonb, $9::text::jsonb, $10::text::jsonb)
       returning ${COLUMNS}`,
      [id, token.workspaceId, environmentId, address, requireText("name", input.name, 200), input.publicKey, input.version ?? null, json(input.capabilities ?? []), json(input.labels ?? {}), json(input.host ?? {})]
    );
    return toMachine(rows[0]);
  });
}

export interface UpsertTargetInput {
  workspaceId: string;
  environmentId?: string;
  address?: string;
  name: string;
  /** any transport except `zenithd` (those register with a token) */
  transport: Exclude<MachineTransport, "zenithd">;
  targetId: string;
  labels?: Record<string, string>;
}

/** Record a transport-addressed target (SSM instance, pod, …), keyed by `(workspace, transport, targetId)`. A revoked target stays revoked. */
export async function upsertTarget(sql: Sql, input: UpsertTargetInput): Promise<PlatformMachine> {
  if ((input.transport as string) === "zenithd") throw new ControlStoreError("invalid_input", "zenithd machines register with a registration token.");
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<MachineRow>(
    `insert into platform.machines as m (id, workspace_id, environment_id, address, name, transport, target_id, labels)
     values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
     on conflict (workspace_id, transport, target_id) do update
       set environment_id = coalesce(excluded.environment_id, m.environment_id),
           address = coalesce(excluded.address, m.address),
           name = excluded.name, labels = excluded.labels
     returning ${COLUMNS}`,
    [newId("mac"), workspaceId, input.environmentId ?? null, input.address ?? null, requireText("name", input.name, 200), input.transport, requireText("targetId", input.targetId, 512), json(input.labels ?? {})]
  );
  return toMachine(rows[0]);
}

export async function getMachine(sql: Sql, workspaceId: string, id: string): Promise<PlatformMachine | null> {
  const rows = await sql.query<MachineRow>(
    `select ${COLUMNS} from platform.machines where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toMachine(rows[0]) : null;
}

export async function listMachines(sql: Sql, workspaceId: string, filter: { environmentId?: string; transport?: MachineTransport } = {}): Promise<PlatformMachine[]> {
  const rows = await sql.query<MachineRow>(
    `select ${COLUMNS} from platform.machines
      where workspace_id = $1 and ($2::text is null or environment_id = $2::text) and ($3::text is null or transport = $3::text)
      order by registered_at desc, id`,
    [requireText("workspaceId", workspaceId), filter.environmentId ?? null, filter.transport ?? null]
  );
  return rows.map(toMachine);
}

/** Authentication lookup by machine id alone — the one unscoped read (see the module header). */
export async function findMachineForAuth(sql: Sql, id: string): Promise<PlatformMachine | null> {
  const rows = await sql.query<MachineRow>(`select ${COLUMNS} from platform.machines where id = $1`, [requireText("id", id)]);
  return rows.length ? toMachine(rows[0]) : null;
}

/** Record a zenithd heartbeat. `{ revoked: true }` tells the agent to stop; null when not in this workspace. */
export async function heartbeatMachine(
  sql: Sql,
  input: { workspaceId: string; id: string; version?: string; capabilities?: string[]; host?: Record<string, unknown>; lifecycle?: Record<string, unknown> }
): Promise<{ revoked: boolean } | null> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  const updated = await sql.query<{ id: string }>(
    `update platform.machines
        set last_heartbeat_at = clock_timestamp(),
            version = coalesce($3::text, version),
            capabilities = coalesce($4::text::jsonb, capabilities),
            host = coalesce($5::text::jsonb, host),
            lifecycle = coalesce($6::text::jsonb, lifecycle),
            lifecycle_reported_at = case when $6::text is null then lifecycle_reported_at else clock_timestamp() end
      where workspace_id = $1 and id = $2 and transport = 'zenithd' and status = 'active'
      returning id`,
    [workspaceId, id, input.version ?? null, input.capabilities ? json(input.capabilities) : null, input.host ? json(input.host) : null, input.lifecycle ? json(input.lifecycle) : null]
  );
  if (updated.length) return { revoked: false };
  const row = await sql.query<{ status: string }>("select status from platform.machines where workspace_id = $1 and id = $2", [workspaceId, id]);
  return row.length ? { revoked: row[0].status === "revoked" } : null;
}

/** Revoke a machine (terminal, idempotent). Null when it is not in this workspace. */
export async function revokeMachine(sql: Sql, workspaceId: string, id: string): Promise<PlatformMachine | null> {
  const rows = await sql.query<MachineRow>(
    `update platform.machines set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp())
      where workspace_id = $1 and id = $2 returning ${COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toMachine(rows[0]) : null;
}
