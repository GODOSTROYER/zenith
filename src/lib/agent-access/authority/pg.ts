/**
 * The Postgres credential authority — `agent.*` on Supabase, over postgres.js.
 *
 * Direct Postgres, not PostgREST, for one reason that decides it: approving a
 * link has to move the code from `pending` to `approved` *and* insert the
 * credential as one unit, or a crash between the two leaves either a credential
 * nobody asked for or an approved code that exchanges for nothing. PostgREST
 * runs each request as its own transaction and cannot express the guarded
 * `UPDATE … WHERE state='pending' RETURNING` that makes a double-click issue one
 * credential instead of two.
 *
 * The connection is `pgAuthorityClient()` (`src/lib/hosted/authority/pg/client.ts`)
 * — the same singleton the hosted authority uses, unmodified. One client per
 * instance is what keeps the free tier's pooler budget at one slot per
 * instance; a second client here would double it for no gain.
 *
 * `agent` is its own schema, and deliberately not `hosted`: an agent-link outage
 * must not be coupled to a hosted-apps migration, and `public` is PostgREST's.
 * Nothing exposes `agent` to the Data API, so no credential row is reachable
 * over HTTP at all.
 *
 * Timestamps are `text` holding `Date#toISOString()`, fixed width, so
 * `expires_at > $1` is a plain string predicate that means the same thing on
 * both stores. `0002_hosted_authority.sql`'s header states the rule; do not
 * "improve" these columns to `timestamptz`.
 */
import { pgAuthorityClient, type Sql } from "@/lib/hosted/authority/pg/client";
import { transactPg } from "@/lib/hosted/authority/pg/tx";
import { randomUUID } from "node:crypto";
import { AgentError, type Credential } from "../security";
import {
  LINK_CREDENTIAL_QUOTA,
  LINK_MAX_DAYS,
  LINK_MAX_FAILED_LOOKUPS,
  hashToken,
  mintToken,
  openLinkSecret,
  paceInterval,
  sealLinkSecret,
} from "../link/protocol";
import type {
  ApproveLinkInput,
  CredentialAuthority,
  ExchangeResult,
  LinkRow,
  LinkStart,
  LinkedCredential,
} from "./types";

/** The migration `supabase/migrations/0006_agent_link.sql` records. */
export const AGENT_SCHEMA_VERSION = 1;
export const AGENT_SCHEMA_NAME = "agent-link-v1";

/** How long a consumed or expired row is kept before housekeeping deletes it. */
const LINK_RETENTION_MS = 86_400_000;

/** Nothing in this module ever reads or writes more rows than this at once. */
const PAGE = 200;

/**
 * A jsonb string-array column. Rows written before the binding fix hold the
 * array JSON-encoded *inside* a jsonb string (`"[\"read\"]"`), because the value
 * was bound as text and cast; accept both shapes so those rows keep working.
 */
const stringArray = (value: unknown): string[] => {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** Bind a string array as a real jsonb array, never as a jsonb-encoded string. */
const jsonArray = (values: readonly string[]): string => JSON.stringify([...new Set(values)]);

const unavailable = (message: string): AgentError =>
  new AgentError("policy_unavailable", message, 503);

interface CredentialRow {
  id: string;
  token_hash: string;
  subject: string;
  workspace_id: string;
  project_ids: string[];
  environment_ids: string[] | null;
  app_ids: string[] | null;
  scopes: string[];
  label: string | null;
  client_name: string;
  client_version: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

const toCredential = (row: CredentialRow): LinkedCredential => ({
  id: row.id,
  tokenHash: row.token_hash,
  subject: row.subject,
  workspaceId: row.workspace_id,
  projectIds: stringArray(row.project_ids),
  ...(row.environment_ids ? { environmentIds: stringArray(row.environment_ids) } : {}),
  ...(row.app_ids ? { appIds: stringArray(row.app_ids) } : {}),
  scopes: stringArray(row.scopes) as Credential["scopes"],
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  ...(row.label ? { label: row.label } : {}),
  clientName: row.client_name,
  ...(row.client_version ? { clientVersion: row.client_version } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
});

interface LinkCodeRow {
  user_code_hash: string;
  device_code_hash: string;
  state: LinkRow["state"];
  client_name: string;
  client_version: string | null;
  label: string | null;
  requested_scopes: string[];
  created_at: string;
  expires_at: string;
  credential_id: string | null;
  secret_ct: Uint8Array | null;
  poll_count: number;
  last_polled_at: string | null;
  failed_lookups: number;
}

const toLinkRow = (row: LinkCodeRow, now: number): LinkRow => ({
  // The store holds only the hash; the caller echoes the code it looked up with.
  userCode: "",
  state:
    (row.state === "pending" || row.state === "approved") && Date.parse(row.expires_at) <= now
      ? "expired"
      : row.state,
  clientName: row.client_name,
  ...(row.client_version ? { clientVersion: row.client_version } : {}),
  ...(row.label ? { label: row.label } : {}),
  requestedScopes: stringArray(row.requested_scopes),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  ...(row.credential_id ? { credentialId: row.credential_id } : {}),
});

export class PgCredentialAuthority implements CredentialAuthority {
  readonly kind = "postgres" as const;
  /**
   * The schema check, resolved once and then remembered — including its
   * failure. A database that is behind must not be re-probed on every request
   * until the connection budget is gone; it must say the same thing every time
   * until somebody applies the migration and the process restarts.
   */
  private checked?: Promise<void>;

  constructor(private readonly sql: () => Sql) {}

  private async schema(): Promise<Sql> {
    const client = this.sql();
    this.checked ??= (async () => {
      const rows = (await client`
        select version from agent.schema_migrations order by version
      `.catch(() => {
        throw unavailable(
          `The agent control database has no \`agent\` schema, so credentials cannot be issued or checked. Fix: apply supabase/migrations/0006_agent_link.sql (Supabase SQL editor, or psql against SUPABASE_DB_URL) and start again.`
        );
      })) as unknown as { version: number }[];
      const found = rows.map((row) => row.version);
      if (!found.includes(AGENT_SCHEMA_VERSION))
        throw unavailable(
          `The agent control database records schema versions ${found.join(", ") || "none"}, and this build needs version ${AGENT_SCHEMA_VERSION} ("${AGENT_SCHEMA_NAME}"). Fix: apply supabase/migrations/0006_agent_link.sql and start again. Re-applying it is safe; nothing was read or written in the meantime.`
        );
    })();
    await this.checked;
    return client;
  }

  async ready(): Promise<void> {
    await this.schema();
  }

  async verify(authorizationHeader: string | null, now = Date.now()): Promise<Credential> {
    // The same pre-check `authenticate()` makes, before any connection is used:
    // an unparseable bearer never reaches the database.
    if (!authorizationHeader || !/^Bearer za_[A-Za-z0-9_-]{43}$/.test(authorizationHeader))
      throw new AgentError("unauthorized", "Supply an unexpired scoped Zenith agent credential.", 401);
    const sql = await this.schema();
    const hash = hashToken(authorizationHeader.slice(7));
    const rows = (await sql`
      select * from agent.agent_credentials where token_hash = ${hash} limit 1
    `) as unknown as CredentialRow[];
    const row = rows[0];
    // A miss and a hit take the same path: both return before any scope logic,
    // and the value compared is a digest of an unguessable 256-bit token.
    if (
      !row ||
      row.revoked_at ||
      Date.parse(row.expires_at) <= now ||
      Date.parse(row.issued_at) > now
    )
      throw new AgentError(
        "unauthorized",
        "Credential invalid, expired, or revoked. Link this agent again with `zenith login`.",
        401
      );
    return toCredential(row);
  }

  async touch(credentialId: string, at: string): Promise<void> {
    const sql = this.sql();
    await sql`
      update agent.agent_credentials set last_used_at = ${at} where id = ${credentialId}
    `;
  }

  async startLink(start: LinkStart): Promise<void> {
    const sql = await this.schema();
    await sql`
      insert into agent.agent_link_codes
        (user_code_hash, device_code_hash, state, client_name, client_version, label,
         requested_scopes, created_at, expires_at, poll_count, failed_lookups)
      values (${start.userCodeHash}, ${start.deviceCodeHash}, 'pending', ${start.clientName},
              ${start.clientVersion ?? null}, ${start.label ?? null},
              ${jsonArray(start.requestedScopes)}::text::jsonb, ${start.createdAt}, ${start.expiresAt},
              0, 0)
    `;
  }

  async linkByUserCode(userCodeHash: string, now = Date.now()): Promise<LinkRow | undefined> {
    const sql = await this.schema();
    const rows = (await sql`
      select * from agent.agent_link_codes where user_code_hash = ${userCodeHash} limit 1
    `) as unknown as LinkCodeRow[];
    const row = rows[0];
    if (!row) return undefined;
    if (row.state === "pending" && Date.parse(row.expires_at) > now) {
      // A code that keeps being looked up and never approved is being guessed
      // at. The counter is the row's own, so the ceiling holds across instances.
      const bumped = (await sql`
        update agent.agent_link_codes
           set failed_lookups = failed_lookups + 1,
               state = case when failed_lookups + 1 > ${LINK_MAX_FAILED_LOOKUPS} then 'expired' else state end,
               secret_ct = case when failed_lookups + 1 > ${LINK_MAX_FAILED_LOOKUPS} then null else secret_ct end
         where user_code_hash = ${userCodeHash} and state = 'pending'
        returning *
      `) as unknown as LinkCodeRow[];
      if (bumped[0]) return toLinkRow(bumped[0], now);
    }
    return toLinkRow(row, now);
  }

  async approveLink(input: ApproveLinkInput): Promise<{ credentialId: string; expiresAt: string }> {
    const now = input.now ?? Date.now();
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > LINK_MAX_DAYS)
      throw new AgentError("invalid_request", `Choose a lifetime between 1 and ${LINK_MAX_DAYS} days.`, 400);
    const sql = await this.schema();
    const nowIso = new Date(now).toISOString();
    const token = mintToken();
    const credentialId = `cred_${randomUUID()}`;
    const expiresAt = new Date(now + input.days * 86_400_000).toISOString();
    const secretCt = sealLinkSecret(input.userCodeHash, token);

    return transactPg(sql, async (tx) => {
      const codes = (await tx`
        select * from agent.agent_link_codes where user_code_hash = ${input.userCodeHash} for update
      `) as unknown as LinkCodeRow[];
      const code = codes[0];
      if (!code || Date.parse(code.expires_at) <= now)
        throw new AgentError(
          "link_code_not_found",
          "This link request is no longer waiting. Run `zenith login` again.",
          404
        );
      if (code.state !== "pending")
        throw new AgentError("link_code_consumed", "This link request was already answered.", 409);

      const live = (await tx`
        select count(*)::int as n from agent.agent_credentials
         where subject = ${input.subject} and workspace_id = ${input.workspaceId}
           and revoked_at is null and expires_at > ${nowIso}
      `) as unknown as { n: number }[];
      if ((live[0]?.n ?? 0) >= LINK_CREDENTIAL_QUOTA)
        throw new AgentError(
          "credential_quota",
          `This account already has ${LINK_CREDENTIAL_QUOTA} linked agents in this workspace. Revoke one under Integrations → Linked agents and link again.`,
          429
        );

      await tx`
        insert into agent.agent_credentials
          (id, token_hash, subject, workspace_id, project_ids, environment_ids, app_ids, scopes,
           label, client_name, client_version, issued_at, expires_at, created_by)
        values (${credentialId}, ${hashToken(token)}, ${input.subject}, ${input.workspaceId},
                ${jsonArray(input.projectIds)}::text::jsonb,
                ${input.environmentIds ? jsonArray(input.environmentIds) : null}::text::jsonb,
                null,
                ${jsonArray(input.scopes)}::text::jsonb,
                ${input.label ?? code.label ?? null}, ${code.client_name}, ${code.client_version ?? null},
                ${nowIso}, ${expiresAt}, ${input.subject})
      `;

      // One row moves pending -> approved, atomically, or nobody does: a
      // double-click issues one credential because the second UPDATE matches
      // zero rows and the whole frame rolls back.
      const moved = await tx`
        update agent.agent_link_codes
           set state = 'approved', approved_at = ${nowIso}, approved_by = ${input.subject},
               credential_id = ${credentialId}, secret_ct = ${secretCt}
         where user_code_hash = ${input.userCodeHash} and state = 'pending' and expires_at > ${nowIso}
        returning user_code_hash
      `;
      if (moved.count !== 1)
        throw new AgentError("link_code_consumed", "This link request was already answered.", 409);
      return { credentialId, expiresAt };
    });
  }

  async denyLink(userCodeHash: string, subject: string): Promise<boolean> {
    const sql = await this.schema();
    const nowIso = new Date().toISOString();
    const denied = await sql`
      update agent.agent_link_codes
         set state = 'denied', approved_at = ${nowIso}, approved_by = ${subject}, secret_ct = null
       where user_code_hash = ${userCodeHash} and state = 'pending' and expires_at > ${nowIso}
      returning user_code_hash
    `;
    return denied.count === 1;
  }

  async exchange(deviceCodeHash: string, now = Date.now()): Promise<ExchangeResult> {
    const sql = await this.schema();
    const nowIso = new Date(now).toISOString();
    const rows = (await sql`
      select * from agent.agent_link_codes where device_code_hash = ${deviceCodeHash} limit 1
    `) as unknown as LinkCodeRow[];
    const row = rows[0];
    if (!row) return { status: "unknown" };
    if (row.state === "consumed" || row.state === "expired" || Date.parse(row.expires_at) <= now)
      return { status: "expired" };
    if (row.state === "denied") return { status: "denied" };

    const since = row.last_polled_at ? now - Date.parse(row.last_polled_at) : Number.POSITIVE_INFINITY;
    const paced = paceInterval(row.poll_count, Date.parse(row.created_at), now);
    const early = since < paced * 1000;
    await sql`
      update agent.agent_link_codes
         set poll_count = poll_count + 1, last_polled_at = ${nowIso}
       where device_code_hash = ${deviceCodeHash}
    `;
    if (row.state === "pending")
      return early ? { status: "slow_down", interval: paced } : { status: "authorization_pending", interval: paced };

    // Approved. Single use, and the secret is destroyed by the same statement
    // that consumes the row — a concurrent second poller updates zero rows and
    // is told the code expired, never handed a second copy.
    //
    // `RETURNING` reports the row **after** the update, so a plain
    // `UPDATE … SET secret_ct = null … RETURNING secret_ct` hands back `null`
    // and there is no token to give the agent. (LINK-PROTOCOL §3.3's comment
    // claims otherwise; it is wrong about Postgres, and the CI `postgres` lane
    // is where that was finally observed.) The pre-update value has to be read
    // by something that is not the UPDATE's own target list, so it is read by a
    // sub-select in `FROM` — and that sub-select takes `FOR UPDATE`, which is
    // what keeps the single-use property: a second poller blocks on the row
    // lock, re-evaluates its `state = 'approved'` predicate against the
    // committed row, finds `consumed`, matches nothing and returns no rows.
    // `t.state = 'approved'` repeats the guard on the target so the same
    // re-check also happens for the UPDATE itself.
    const consumed = (await sql`
      update agent.agent_link_codes as t
         set state = 'consumed', secret_ct = null
        from (
          select device_code_hash, credential_id, secret_ct
            from agent.agent_link_codes
           where device_code_hash = ${deviceCodeHash} and state = 'approved' and expires_at > ${nowIso}
           for update
        ) prev
       where t.device_code_hash = prev.device_code_hash and t.state = 'approved'
      returning prev.credential_id as credential_id, prev.secret_ct as secret_ct
    `) as unknown as { credential_id: string | null; secret_ct: Uint8Array | null }[];
    const claimed = consumed[0];
    if (!claimed?.secret_ct || !claimed.credential_id) return { status: "expired" };

    const token = openLinkSecret(row.user_code_hash, claimed.secret_ct);
    const credentials = (await sql`
      select * from agent.agent_credentials where id = ${claimed.credential_id} limit 1
    `) as unknown as CredentialRow[];
    const credential = credentials[0];
    if (!credential || credential.revoked_at) return { status: "expired" };
    return { status: "issued", credential: toCredential(credential), token };
  }

  async listCredentials(subject: string, workspaceId: string): Promise<LinkedCredential[]> {
    const sql = await this.schema();
    const rows = (await sql`
      select * from agent.agent_credentials
       where subject = ${subject} and workspace_id = ${workspaceId}
       order by issued_at desc limit ${PAGE}
    `) as unknown as CredentialRow[];
    return rows.map((row) => ({ ...toCredential(row), tokenHash: "" }));
  }

  async revokeCredential(
    subject: string | null,
    workspaceId: string,
    credentialId: string
  ): Promise<boolean> {
    const sql = await this.schema();
    const nowIso = new Date().toISOString();
    // A workspace admin may withdraw another member's credential; everyone else
    // is held to their own. The predicate differs, the statement does not.
    const revoked =
      subject === null
        ? await sql`
            update agent.agent_credentials set revoked_at = ${nowIso}
             where id = ${credentialId} and workspace_id = ${workspaceId} and revoked_at is null
            returning id
          `
        : await sql`
            update agent.agent_credentials set revoked_at = ${nowIso}
             where id = ${credentialId} and workspace_id = ${workspaceId}
               and subject = ${subject} and revoked_at is null
            returning id
          `;
    return revoked.count === 1;
  }

  async expireLinks(now = Date.now()): Promise<number> {
    const sql = await this.schema();
    const nowIso = new Date(now).toISOString();
    const cutoff = new Date(now - LINK_RETENTION_MS).toISOString();
    const expired = await sql`
      update agent.agent_link_codes set state = 'expired', secret_ct = null
       where user_code_hash in (
         select user_code_hash from agent.agent_link_codes
          where state in ('pending','approved') and expires_at <= ${nowIso}
          limit ${PAGE})
      returning user_code_hash
    `;
    await sql`
      delete from agent.agent_link_codes
       where user_code_hash in (
         select user_code_hash from agent.agent_link_codes where expires_at <= ${cutoff} limit ${PAGE})
    `;
    return expired.count;
  }
}

type PgAuthorityGlobal = typeof globalThis & { __zenithPgCredentialAuthority?: PgCredentialAuthority };

/** The process-wide authority, on the process-wide client. */
export function pgCredentialAuthority(): CredentialAuthority {
  const global = globalThis as PgAuthorityGlobal;
  return (global.__zenithPgCredentialAuthority ??= new PgCredentialAuthority(pgAuthorityClient));
}

/** Build one on a supplied client. Exported for tests and tooling. */
export const createPgCredentialAuthority = (sql: () => Sql): PgCredentialAuthority =>
  new PgCredentialAuthority(sql);

/**
 * The link surface's rate limiter on this store: one fixed window per
 * `(scope, key)`, the same shape `DurableRateLimiter` keeps on the file store,
 * and stale buckets deleted on every check exactly as `rate-limit.ts:57` does.
 */
export async function pgRateLimit(
  scope: string,
  key: string,
  options: { limit: number; windowMs: number }
): Promise<void> {
  const sql = pgAuthorityClient();
  const bucket = Math.floor(Date.now() / options.windowMs);
  await sql`delete from agent.agent_rate_limits where bucket < ${bucket - 1}`;
  const rows = (await sql`
    insert into agent.agent_rate_limits (scope, key, bucket, count)
    values (${scope}, ${key}, ${bucket}, 1)
    on conflict (scope, key, bucket) do update set count = agent.agent_rate_limits.count + 1
    returning count
  `) as unknown as { count: number }[];
  if ((rows[0]?.count ?? 0) > options.limit)
    throw new AgentError("rate_limited", "Request limit reached; retry later.", 429);
}
