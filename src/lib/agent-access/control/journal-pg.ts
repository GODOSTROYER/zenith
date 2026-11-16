/**
 * The reviewed-operation journal on Supabase Postgres.
 *
 * The SQLite journal next door is correct for the host it was written for: one
 * process, one file, one writer, and a `BEGIN IMMEDIATE` around anything that
 * matters. None of that survives Vercel, where an instance is created for a
 * request and frozen after it and a hundred copies of this code can be holding
 * the same operation id at the same moment. So the coordination moves into the
 * database:
 *
 *  - **The claim is one conditional `UPDATE … RETURNING`.** Not a read, a
 *    decision and a write — one statement, whose `WHERE` carries every
 *    precondition (`phase = 'approved'`, an approver, an unexpired plan, the
 *    exact reviewed digest and the fingerprint recomputed this request). Two
 *    instances racing it produce exactly one row.
 *  - **`fence_token` is the fence.** It is incremented by the claim and named
 *    by every later write, so a frozen instance that thaws and tries to
 *    finalize an operation someone else reclaimed changes zero rows and lands
 *    in the uncertain path, which is the honest answer.
 *  - **`lease_until` is what a crash leaves behind.** `agentTickPass()`
 *    (reconcile.ts) turns a `running` row past its lease into `uncertain`. It
 *    is never re-dispatched: the side effect may have happened and nothing here
 *    can know.
 *
 * ## Why direct Postgres and not PostgREST
 *
 * The product store speaks PostgREST, and PostgREST runs every request as its
 * own implicit transaction. `prepare()` needs read-idempotency-row → count →
 * insert → insert as one unit, and the claim needs `fence_token = fence_token
 * + 1` as an expression assignment, which PostgREST cannot write at all — the
 * fence would have to be read, incremented in JS and written back, which is
 * precisely the race a fence exists to close.
 *
 * So this uses `pgAuthorityClient()` — the **same** `globalThis` singleton the
 * hosted control authority already holds, with `max: 1`. The connection budget
 * against the pooler is therefore unchanged by this file existing.
 *
 * ## No cross-authority transaction is implied, anywhere
 *
 * The journal commits here; the product state commits over PostgREST. They are
 * two commits in two authorities and nothing makes them one. What binds them is
 * the *order* — intent first, effect second, outcome last — and the fact that
 * the only states a reader can observe are `running` (intent recorded, effect
 * unknown), `succeeded`/`failed` (effect observed and authority still valid),
 * and `uncertain` (everything else). See ADR D-8a.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SCOPE_NAMES } from './contracts';
import { pgAuthorityClient, isDefaultPgAuthorityClient, isDefaultPgAuthorityClientFor, type Sql, type TransactionSql } from '@/lib/hosted/authority/pg/client';
import type { Sql as NativeSql, Principal as NativePrincipal } from '@/lib/controlplane/types';
import { transactPg } from '@/lib/hosted/authority/pg/tx';
import { readNumber } from '@/lib/hosted/authority/pg/rows';
import {
  ControlError, checkTarget, digest, notWithdrawable,
  type AgentJournal, type Grant, type JournalEvent, type Operation, type Principal,
  type Proposal, type Target, type UploadReceipt,
} from './journal';

/** Either the pooled client or an open transaction's tag. Statements take both. */
export type AnySql = Sql | TransactionSql;

/**
 * A value bound as `jsonb`.
 *
 * postgres.js needs to be told, or a plain object is inferred as a record type
 * the column will not accept. One helper so no call site forgets and no call
 * site repeats the cast the driver's own typings require.
 */
const asJson = (sql: AnySql, value: unknown): ReturnType<Sql['json']> => sql.json(value as never);

/**
 * How long a claim holds an operation before the reconciliation pass may call
 * it uncertain.
 *
 * Deliberately longer than any route's `maxDuration` (60 s), so a request that
 * is still running never has its row reclaimed under it; short enough that a
 * frozen instance's row resolves within one five-minute tick.
 */
export const LEASE_MS = 60_000;

/** Every bounded scan and sweep in this file. One number, so none of them drifts. */
export const SCAN_LIMIT = 200;

/** The migration ledger rows this build requires before it reads or writes anything. */
export const AGENT_CONTROL_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'agent-link-v1', file: '0006_agent_link.sql', scope: 'journal' as const }),
  Object.freeze({ version: 2, name: 'agent-control-v1', file: '0007_agent_control.sql', scope: 'journal' as const }),
  Object.freeze({ version: 3, name: 'agent-oauth-grants-v1', file: '0015_agent_oauth_grants.sql', scope: 'oauth' as const }),
]);
// Ordinary journal operations remain compatible with the existing two migrations.
export const REQUIRED_MIGRATIONS = Object.freeze(AGENT_CONTROL_MIGRATIONS.filter(migration => migration.scope === 'journal'));

/** Columns read by the OAuth journal and checked by the canonical CI verifier. */
export const OAUTH_GRANT_COLUMNS = Object.freeze([
  { name: 'integration_id', type: 'text', nullable: false },
  { name: 'subject', type: 'text', nullable: false },
  { name: 'client_id', type: 'text', nullable: false },
  { name: 'workspace_id', type: 'text', nullable: false },
  { name: 'oauth_issuer', type: 'text', nullable: false },
  { name: 'expires_at', type: 'text', nullable: false },
  { name: 'revoked', type: 'boolean', nullable: false },
  { name: 'project_ids', type: 'jsonb', nullable: false },
  { name: 'environment_ids', type: 'jsonb', nullable: true },
  { name: 'app_ids', type: 'jsonb', nullable: true },
  { name: 'scopes', type: 'jsonb', nullable: false },
].map(column => Object.freeze(column)));

/** Native deparsed definitions under pg_catalog; no name-only constraint admission. */
export const OAUTH_GRANT_CONSTRAINTS = Object.freeze([
  { name: 'agent_oauth_grants_apps', type: 'c', columns: '{10}', definition: 'CHECK (((app_ids IS NULL) OR agent.oauth_grant_ids_valid(app_ids, 0, 100)))' },
  { name: 'agent_oauth_grants_binding', type: 'u', columns: '{2,3,4}', definition: 'UNIQUE (subject, client_id, workspace_id)' },
  { name: 'agent_oauth_grants_client', type: 'c', columns: '{3}', definition: 'CHECK (((length(client_id) >= 1) AND (length(client_id) <= 200)))' },
  { name: 'agent_oauth_grants_environments', type: 'c', columns: '{9}', definition: 'CHECK (((environment_ids IS NULL) OR agent.oauth_grant_ids_valid(environment_ids, 0, 100)))' },
  { name: 'agent_oauth_grants_expiry', type: 'c', columns: '{6}', definition: String.raw`CHECK ((expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'::text))` },
  { name: 'agent_oauth_grants_integration', type: 'c', columns: '{1}', definition: "CHECK ((integration_id ~ '^[A-Za-z0-9_-]{1,100}$'::text))" },
  { name: 'agent_oauth_grants_issuer', type: 'c', columns: '{5}', definition: "CHECK ((((length(oauth_issuer) >= 1) AND (length(oauth_issuer) <= 2048)) AND (oauth_issuer ~* '^https://'::text)))" },
  { name: 'agent_oauth_grants_pkey', type: 'p', columns: '{1}', definition: 'PRIMARY KEY (integration_id)' },
  { name: 'agent_oauth_grants_projects', type: 'c', columns: '{8}', definition: 'CHECK (agent.oauth_grant_ids_valid(project_ids, 1, 100))' },
  { name: 'agent_oauth_grants_scopes', type: 'c', columns: '{11}', definition: `CHECK ((agent.oauth_grant_ids_valid(scopes, 1, 6) AND (scopes ? 'read'::text) AND (scopes <@ '["read", "plan", "export", "write", "publish", "logs"]'::jsonb)))` },
  { name: 'agent_oauth_grants_subject', type: 'c', columns: '{2}', definition: "CHECK ((subject ~ '^[A-Za-z0-9_-]{1,100}$'::text))" },
  { name: 'agent_oauth_grants_workspace', type: 'c', columns: '{4}', definition: "CHECK ((workspace_id ~ '^[A-Za-z0-9_-]{1,100}$'::text))" },
].map(constraint => Object.freeze(constraint)));

/** Exact enforcing trigger shape from migration 0015; 19 = BEFORE | UPDATE | ROW in PostgreSQL. */
export const OAUTH_GRANT_IDENTITY_TRIGGER = Object.freeze({
  name: 'agent_oauth_grants_identity', type: 19, enabled: 'O', columns: '', condition: null,
  argumentCount: 0, argumentBytes: 0, parent: 0, constraint: 0, constraintRelation: 0, constraintIndex: 0,
  deferrable: false, initiallyDeferred: false, oldTable: null, newTable: null,
});

/** Native function semantics, including the helpers referenced by canonical CHECK definitions. */
export const OAUTH_GRANT_FUNCTIONS = Object.freeze([
  Object.freeze({ name: 'guard_oauth_grant_identity', schema: 'agent', language: 'plpgsql', kind: 'f',
    resultType: 'trigger', argumentCount: 0, argumentTypes: '', argumentNames: null,
    allArgumentTypes: null, argumentModes: null, defaultCount: 0, argumentDefaults: null, variadic: 0,
    securityDefiner: false, strict: false, leakproof: false, returnsSet: false, volatility: 'v', parallel: 'u',
    config: Object.freeze(['search_path=pg_catalog']), binary: null, sqlBody: null, transforms: null, support: 0,
    body: "\nbegin\n  if row(new.integration_id, new.subject, new.client_id, new.workspace_id)\n    is distinct from row(old.integration_id, old.subject, old.client_id, old.workspace_id) then\n    raise exception 'The OAuth resource grant binding is immutable.' using errcode = '23514';\n  end if;\n  return new;\nend " }),
  Object.freeze({ name: 'oauth_grant_ids_valid', schema: 'agent', language: 'sql', kind: 'f',
    resultType: 'boolean', argumentCount: 3, argumentTypes: '3802 23 23',
    argumentNames: Object.freeze(['value', 'minimum', 'maximum']), allArgumentTypes: null, argumentModes: null,
    defaultCount: 0, argumentDefaults: null, variadic: 0,
    securityDefiner: false, strict: true, leakproof: false, returnsSet: false, volatility: 'i', parallel: 'u',
    config: Object.freeze(['search_path=pg_catalog']), binary: null, sqlBody: null, transforms: null, support: 0,
    body: "\n  select case when jsonb_typeof(value) = 'array' then\n    jsonb_array_length(value) between minimum and maximum\n    and not exists (select 1 from jsonb_array_elements(value) as items(element)\n      where jsonb_typeof(element) <> 'string' or (element #>> '{}') !~ '^[A-Za-z0-9_-]{1,100}$')\n    and (select count(distinct element) from jsonb_array_elements(value) as items(element)) = jsonb_array_length(value)\n    else false end\n" }),
]);

/** The browser's existing retained-grant quota, enforced across native writers. */
const GRANT_QUOTA = 50;

const grantId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const grantIds = z.array(grantId).max(100).refine(values => new Set(values).size === values.length);
const grantShape = z.object({
  subject: grantId, integrationId: grantId, workspaceId: grantId,
  clientId: z.string().min(1).max(200),
  projectIds: grantIds.refine(values => values.length > 0),
  environmentIds: grantIds.optional(), appIds: grantIds.optional(),
  scopes: z.array(z.enum(SCOPE_NAMES)).min(1).max(6)
    .refine(values => values.includes('read') && new Set(values).size === values.length),
  expiresAt: z.string().max(100).refine(value => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }),
  oauthIssuer: z.string().min(1).max(2048).refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
    } catch { return false; }
  }),
  revoked: z.boolean().optional(),
  // Browser consent's duration and a bound principal's derived digest are not persisted.
  days: z.number().int().min(1).max(30).optional(), grantDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
function invalidGrant(): never {
  throw new ControlError('grant_invalid', 'The OAuth resource grant is invalid.', 400);
}
function grantCopy(input: unknown): Grant & { oauthIssuer: string } {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return invalidGrant();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(value => !Object.hasOwn(value, 'value'))) return invalidGrant();
    const detached = structuredClone(Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value])));
    const parsed = grantShape.safeParse(detached);
    if (!parsed.success) return invalidGrant();
    const { days: _days, grantDigest: _grantDigest, ...grant } = parsed.data;
    return grant;
  } catch (error) { if (error instanceof ControlError) throw error; return invalidGrant(); }
}
interface GrantRow {
  integration_id: string; subject: string; client_id: string; workspace_id: string;
  oauth_issuer: string; expires_at: string; revoked: boolean;
  project_ids: string[]; environment_ids: string[] | null; app_ids: string[] | null; scopes: string[];
}
function grantFromRow(row: GrantRow, subject: string, workspaceId: string, clientId?: string): Grant {
  const grant = grantCopy({ integrationId: row.integration_id, subject: row.subject, clientId: row.client_id,
    workspaceId: row.workspace_id, oauthIssuer: row.oauth_issuer, expiresAt: row.expires_at, revoked: row.revoked,
    projectIds: row.project_ids, scopes: row.scopes,
    ...(row.environment_ids === null ? {} : { environmentIds: row.environment_ids }),
    ...(row.app_ids === null ? {} : { appIds: row.app_ids }),
  });
  if (grant.subject !== subject || grant.workspaceId !== workspaceId || clientId !== undefined && grant.clientId !== clientId)
    throw new ControlError('grant_unavailable', 'The OAuth resource grant could not be confirmed.', 503);
  return grant;
}


/** Non-secret native tuple. Nullable scope metadata is retained exactly. */
export const NativeOAuthGrant = z.object({
  integration_id: grantId.regex(/^integration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  subject: grantId, client_id: grantShape.shape.clientId, workspace_id: grantId,
  oauth_issuer: grantShape.shape.oauthIssuer, expires_at: grantShape.shape.expiresAt,
  revoked: z.boolean(), project_ids: grantShape.shape.projectIds,
  environment_ids: grantIds.nullable(), app_ids: grantIds.nullable(), scopes: grantShape.shape.scopes,
}).strict();
export type NativeOAuthGrantTuple = z.infer<typeof NativeOAuthGrant>;
interface JournalOrigin {
  journal: PgAgentJournal; client: Sql; prototype: object;
  own: Map<PropertyKey, PropertyDescriptor>; methods: Map<PropertyKey, PropertyDescriptor>;
  checked: Promise<void> | undefined; checkedDescriptor?: PropertyDescriptor;
}
const journalOrigins = new WeakMap<object, JournalOrigin>();
function sameJournalDescriptor(current: PropertyDescriptor | undefined, before: PropertyDescriptor): boolean {
  return !!current && "value" in before && "value" in current
    && current.enumerable === before.enumerable && current.configurable === before.configurable
    && current.value === before.value && current.writable === before.writable;
}
function journalOrigin(value: unknown): JournalOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const saved = journalOrigins.get(value), selected = Object.getOwnPropertyDescriptor(globalThis, '__zenithAgentPgJournal');
  if (!saved || !selected || !('value' in selected) || selected.value !== value || !canonicalJournalMethodsMatch()
    || saved.prototype !== canonicalJournalPrototype || Object.getPrototypeOf(value) !== saved.prototype
    || Reflect.ownKeys(value).filter(key => key !== 'checked').length !== saved.own.size
    || Reflect.ownKeys(saved.prototype).length !== saved.methods.size) return undefined;
  const checked = Object.getOwnPropertyDescriptor(value, 'checked');
  if ((saved.checkedDescriptor ? !sameJournalDescriptor(checked, { ...saved.checkedDescriptor, value: saved.checked }) : checked !== undefined || saved.checked !== undefined)
    || ![...saved.own].every(([key, before]) => sameJournalDescriptor(Object.getOwnPropertyDescriptor(value, key), before))
    || ![...saved.methods].every(([key, before]) => sameJournalDescriptor(Object.getOwnPropertyDescriptor(saved.prototype, key), before))
    || !isDefaultPgAuthorityClient(saved.client)) return undefined;
  return saved;
}
/** Known default identity includes a tampered journal that must never fall back. */
export function wasDefaultPgAgentJournal(value: unknown): boolean { return !!value && typeof value === 'object' && journalOrigins.has(value); }
/** Fixed private factory membership. Tooling constructors and copied journals cannot register. */
export function isDefaultPgAgentJournal(value: unknown): boolean {
  try { return !!journalOrigin(value); } catch { return false; }
}
/** Boolean-only actual owning target check. No caller target or proof is accepted. */
export function isDefaultPgAgentJournalFor(value: unknown, owner: NativeSql): boolean {
  try { const saved = journalOrigin(value); return !!saved && isDefaultPgAuthorityClientFor(saved.client, owner); } catch { return false; }
}
/** Dedicated native read excludes tokens, documents, diagnostics and secret material. */
export async function readDefaultNativeOAuthGrant(value: unknown, principal: NativePrincipal, workspaceId: string): Promise<Readonly<NativeOAuthGrantTuple> | undefined> {
  const unavailable = (): never => { throw new ControlError('grant_unavailable', 'Current native OAuth grant authority is unavailable.', 503); };
  try {
    const saved = journalOrigin(value);
    if (!saved || principal.kind !== 'integration' || principal.id !== principal.integrationId || !principal.onBehalfOf
      || !grantId.safeParse(workspaceId).success || !grantId.safeParse(principal.onBehalfOf).success
      || !NativeOAuthGrant.shape.integration_id.safeParse(principal.id).success) return unavailable();
    await saved.journal.ready();
    if (journalOrigin(value) !== saved) return unavailable();
    const migrations = await selectMigrations(saved.client);
    if (AGENT_CONTROL_MIGRATIONS.some(required => !migrations.some(row => Number(row.version) === required.version && row.name === required.name))
      || journalOrigin(value) !== saved) return unavailable();
    const rows = await saved.client<{ linked: boolean; tuple: unknown }[]>`select
      exists(select 1 from agent.agent_credentials where id=${principal.id}) as linked,
      (select jsonb_build_object('integration_id',integration_id,'subject',subject,'client_id',client_id,'workspace_id',workspace_id,
        'oauth_issuer',oauth_issuer,'expires_at',expires_at,'revoked',revoked,'project_ids',project_ids,
        'environment_ids',environment_ids,'app_ids',app_ids,'scopes',scopes)
        from agent.agent_oauth_grants where integration_id=${principal.id}) as tuple`;
    if (journalOrigin(value) !== saved || rows.length !== 1 || typeof rows[0].linked !== 'boolean' || rows[0].linked) return unavailable();
    if (rows[0].tuple === null) return undefined;
    if (Buffer.byteLength(JSON.stringify(rows[0].tuple)) > 131072) return unavailable();
    const parsed = NativeOAuthGrant.safeParse(rows[0].tuple);
    if (!parsed.success || parsed.data.integration_id !== principal.id || parsed.data.subject !== principal.onBehalfOf
      || parsed.data.workspace_id !== workspaceId) return unavailable();
    return parsed.data;
  } catch { return unavailable(); }
}

/** ISO-8601 UTC, fixed width — the only timestamp format these columns hold. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** A row of `agent.agent_operations`, as far as this file reads one. */
interface OperationRow { document: Operation; fence_token?: unknown; phase?: unknown; expires_at?: unknown }

/**
 * The refusal when the `agent` schema has not been brought up to this build.
 *
 * It names the files. "Schema out of date" with nothing to run is the error
 * that costs an afternoon.
 */
function schemaBehind(found: { version: number; name: string }[], missing: { version: number; name: string }): ControlError {
  const recorded = found.length
    ? `The ledger records ${found.map((m) => `${m.version} ("${m.name}")`).join(', ')}.`
    : 'The ledger has no rows, so the schema has never been applied.';
  return new ControlError(
    'journal_schema',
    `The agent control database is missing schema version ${missing.version} ("${missing.name}"). ${recorded} ` +
      'Fix: apply supabase/migrations/0006_agent_link.sql and supabase/migrations/0007_agent_control.sql in the Supabase SQL editor ' +
      '(or with psql against SUPABASE_DB_URL) and start again. Both are idempotent, so re-applying them is safe. ' +
      'Nothing was read or written in the meantime.',
    503
  );
}

/* ------------------------------- statements -------------------------------- */
/*
 * Each statement is its own exported function taking the tag it runs on. That
 * is not decoration: it is what lets the builders be exercised against a
 * recording tag in a unit test, so the file-store run of the suite still proves
 * the SQL is shaped the way this file's comments claim, on a machine with no
 * Postgres anywhere near it.
 */

/** The migration ledger, oldest first. */
export const selectMigrations = (sql: AnySql) =>
  sql`select version, name from agent.schema_migrations order by version`;

/**
 * The claim. One statement, and the whole of the single-use property.
 *
 * Zero rows is not an error to guess at — the caller reads the row once and
 * maps it to the same codes the SQLite journal raises.
 */
export const claimStatement = (
  sql: AnySql,
  p: { id: string; leaseOwner: string; leaseUntil: string; authorizationDigest: string | null;
       applicationAuthorizationDigest: string | null; document: Operation; now: string; digest: string; fingerprint: string }
) => sql`
  update agent.agent_operations
     set phase        = 'running',
         fence_token  = fence_token + 1,
         lease_owner  = ${p.leaseOwner},
         lease_until  = ${p.leaseUntil},
         attempts     = attempts + 1,
         authorization_digest             = ${p.authorizationDigest},
         application_authorization_digest = ${p.applicationAuthorizationDigest},
         document     = ${asJson(sql, p.document)}
   where id            = ${p.id}
     and phase         = 'approved'
     and approved_by  is not null
     and approval_role is not null
     and expires_at    > ${p.now}
     and digest        = ${p.digest}
     and (document ->> 'fingerprint') = ${p.fingerprint}
  returning id, fence_token, document`;

/**
 * Withdraw an approval. One statement, and every precondition is in its WHERE:
 * phase = 'approved' is what the claim also requires, so whichever of the two
 * takes the row lock first wins and the other changes zero rows - an approval
 * cannot be withdrawn out from under a dispatch, nor a dispatch start on an
 * approval that was withdrawn. The stored Operation loses the same three fields
 * the denormalised columns do, in the same statement, so the two cannot drift.
 */
export const unapproveStatement = (
  sql: AnySql,
  p: { id: string; workspaceId: string; digest: string; now: string }
) => sql`
  update agent.agent_operations
     set phase = 'prepared', approved_by = null, approval_role = null, approved_at = null,
         document = jsonb_set(document - 'approvedBy' - 'approvalRole' - 'approvedAt', '{phase}', '"prepared"')
   where id = ${p.id}
     and workspace_id = ${p.workspaceId}
     and phase = 'approved'
     and digest = ${p.digest}
     and expires_at > ${p.now}
  returning id, document`;

/**
 * Finalization, fenced. A stale fence changes zero rows and never a phase - and
 * neither does a lapsed lease. lease_until is compared with the finalize
 * instant itself: once it has passed, reconciliation is entitled to call the row
 * uncertain, and a frozen instance thawing late must not be able to race it to
 * succeeded. The row is then resolved as uncertain by the coordinator's
 * ordinary refusal path (or by the next reconciliation pass), never as a
 * success - the dispatch may well have happened, which is what uncertain says.
 */
export const finalizeStatement = (
  sql: AnySql,
  p: { id: string; fence: number; phase: 'succeeded' | 'failed'; finishedAt: string; document: Operation;
       authorizationDigest: string | null; applicationAuthorizationDigest: string | null }
) => sql`
  update agent.agent_operations
     set phase = ${p.phase}, finished_at = ${p.finishedAt}, document = ${asJson(sql, p.document)},
         lease_owner = null, lease_until = null
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
     and expires_at > ${p.finishedAt}
     and lease_until > ${p.finishedAt}
     and authorization_digest is not distinct from ${p.authorizationDigest}
     and application_authorization_digest is not distinct from ${p.applicationAuthorizationDigest}
  returning id, document`;

/**
 * Lease renewal for a dispatch that outlives the lease.
 *
 * Never called inside a serverless request: there, one request is one attempt,
 * and if the function is killed the lease expires and reconciliation resolves
 * it. This exists for the long-lived Postgres host.
 */
export const renewStatement = (sql: AnySql, p: { id: string; fence: number; leaseUntil: string }) => sql`
  update agent.agent_operations set lease_until = ${p.leaseUntil}
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
  returning id`;

/** The uncertainty write. Fenced, so only the holder of the claim may take it. */
export const uncertainStatement = (sql: AnySql, p: { id: string; fence: number }) => sql`
  update agent.agent_operations
     set phase = 'uncertain', lease_owner = null, lease_until = null,
         document = jsonb_set(document, '{phase}', '"uncertain"')
   where id = ${p.id} and fence_token = ${p.fence} and phase = 'running'
  returning id, document`;

/**
 * Reconciliation: a `running` row whose lease has passed becomes `uncertain`.
 *
 * Bounded and idempotent — a pass that runs twice reconciles nothing the first
 * one did, because the second pass finds no `running` rows past their lease.
 * **Nothing here re-dispatches.** The side effect may have happened.
 */
export const reconcileStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  update agent.agent_operations
     set phase = 'uncertain', lease_owner = null, lease_until = null,
         document = jsonb_set(document, '{phase}', '"uncertain"')
   where id in (
     select id from agent.agent_operations
      where phase = 'running' and lease_until is not null and lease_until <= ${p.now}
      order by lease_until limit ${p.limit})
  returning id`;

/** Proposals nobody reviewed in time. Bounded, idempotent. */
export const expireStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  update agent.agent_operations
     set phase = 'expired', document = jsonb_set(document, '{phase}', '"expired"')
   where id in (
     select id from agent.agent_operations
      where phase in ('prepared','approved') and expires_at <= ${p.now}
      order by expires_at limit ${p.limit})
  returning id`;

/** Uploaded source past its hour. Bounded, idempotent. */
export const sweepUploadsStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  delete from agent.agent_uploads
   where id in (
     select id from agent.agent_uploads where expires_at <= ${p.now} order by expires_at limit ${p.limit})
  returning id`;

/* --------------------------------- journal --------------------------------- */

/** The Postgres implementation of `AgentJournal`. */
export class PgAgentJournal implements AgentJournal {
  readonly kind = 'postgres' as const;
  /** This instance's identity. One per process, exactly as the SQLite journal's is. */
  readonly workerId = randomUUID();
  private readonly client: Sql;
  private readonly clock: () => number;
  private checked: Promise<void> | undefined;
  /**
   * The fence this process holds for an operation it claimed.
   *
   * Remembered in memory on purpose: a finalize from an instance that did not
   * make the claim has no fence to present, changes zero rows, and the
   * operation resolves as `uncertain`. That is the required behaviour, not a
   * limitation — the second instance genuinely does not know what the first
   * one's dispatch did.
   */
  private readonly fences = new Map<string, number>();

  constructor(opts: { client?: Sql; clock?: () => number } = {}) {
    this.client = opts.client ?? pgAuthorityClient();
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * The schema check: started once, awaited by every read and every write.
   *
   * A rejection is kept and re-thrown to every later caller rather than
   * retried. A hundred instances re-checking a schema that is still missing is
   * load the project does not need, and the answer cannot change without
   * somebody applying the file. Modelled on `createPostgresAuthority()`.
   */
  ready(): Promise<void> {
    const origin = journalOrigins.get(this);
    if (origin && journalOrigin(this) !== origin)
      return Promise.reject(new ControlError('grant_unavailable', 'Current native journal provenance is unavailable.', 503));
    if (!this.checked)
      this.checked = (async () => {
        const rows = (await selectMigrations(this.client)) as unknown as { version: unknown; name: unknown }[];
        const found = rows.map((r) => ({ version: Number(r.version), name: String(r.name) }));
        const missing = REQUIRED_MIGRATIONS.find(
          (required) => !found.some((f) => f.version === required.version && f.name === required.name)
        );
        if (missing) throw schemaBehind(found, missing);
      })();
    if (origin) {
      origin.checked = this.checked;
      origin.checkedDescriptor ??= Object.getOwnPropertyDescriptor(this, 'checked');
    }
    return this.checked;
  }

  private async sql<T>(fn: (sql: AnySql) => Promise<T>): Promise<T> {
    await this.ready();
    return fn(this.client);
  }
  private async tx<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
    await this.ready();
    return transactPg(this.client, fn);
  }

  /** Worker-only lookup for methods whose frozen contract carries no workspace. */
  private async row(sql: AnySql, id: string): Promise<Operation> {
    const rows = (await sql`select document from agent.agent_operations where id = ${id}`) as unknown as OperationRow[];
    if (!rows.length) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return rows[0].document;
  }

  /** Tenant-facing lookups never load another workspace or subject's document. */
  private async scopedRow(sql: AnySql, id: string, workspace: string, subject?: string): Promise<Operation> {
    const rows = (subject === undefined
      ? await sql`select document from agent.agent_operations where id = ${id} and workspace_id = ${workspace}`
      : await sql`select document from agent.agent_operations where id = ${id} and workspace_id = ${workspace} and subject = ${subject}`) as unknown as OperationRow[];
    if (!rows.length) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return rows[0].document;
  }

  /** The operation record plus the row's fence, for the guarded paths. */
  private async rowWithFence(sql: AnySql, id: string): Promise<{ op: Operation; fence: number } | undefined> {
    const rows = (await sql`select document, fence_token from agent.agent_operations where id = ${id}`) as unknown as OperationRow[];
    if (!rows.length) return undefined;
    return { op: rows[0].document, fence: readNumber(rows[0] as unknown as Record<string, unknown>, 'fence_token') };
  }

  private async event(sql: AnySql, op: Operation, kind: string, extra: Record<string, unknown> = {}): Promise<void> {
    await sql`insert into agent.agent_operation_events (operation_id, kind, at, document) values (
      ${op.id}, ${kind}, ${iso(this.clock())},
      ${asJson(sql, { operationId: op.id, phase: op.phase, digest: op.digest, integrationId: op.integrationId, ...extra })})`;
  }

  /** Write the document and its denormalised phase, then record the event. */
  private async write(sql: AnySql, op: Operation, kind: string): Promise<Operation> {
    await sql`update agent.agent_operations
                 set phase = ${op.phase}, document = ${asJson(sql, op)},
                     approved_by = ${op.approvedBy ?? null}, approval_role = ${op.approvalRole ?? null},
                     approved_at = ${op.approvedAt ?? null}, finished_at = ${op.finishedAt ?? null}
               where id = ${op.id}`;
    await this.event(sql, op, kind);
    return op;
  }

  /* ------------------------------- prepare -------------------------------- */

  async prepare(who: Principal, proposal: Proposal, ttlMs = 15 * 60_000): Promise<Operation> {
    checkTarget(who, proposal.target, 'plan', this.clock());
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(proposal.requestKey))
      throw new ControlError('invalid_request_key', 'Use a stable 8–100 character request key.', 400);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 15 * 60_000)
      throw new ControlError('invalid_ttl', 'Plan lifetime must be at most fifteen minutes.', 400);
    if (Buffer.byteLength(JSON.stringify(proposal)) > 512_000)
      throw new ControlError('proposal_too_large', 'Narrow the proposal.', 413);
    // Derived state is excluded from idempotency for the same reason it is on
    // the file store: a retry must return the original reviewed plan, not
    // rebase it onto state that moved.
    const intentHash = digest({ action: proposal.action, input: proposal.input, target: proposal.target, source: proposal.source });
    return this.tx(async (sql) => {
      const existing = (await sql`
        select document, intent_hash from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject} and request_key = ${proposal.requestKey}`) as unknown as
        { document: Operation; intent_hash: string }[];
      if (existing.length) {
        if (existing[0].intent_hash !== intentHash)
          throw new ControlError('idempotency_conflict', 'This request key belongs to different inputs.');
        return existing[0].document;
      }
      const now = iso(this.clock());
      await expireStatement(sql, { now, limit: SCAN_LIMIT });
      await sweepUploadsStatement(sql, { now, limit: SCAN_LIMIT });
      const counted = (await sql`
        select count(*)::int as n from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject}
           and phase in ('prepared','approved','running')`) as unknown as { n: number }[];
      if (readNumber(counted[0] as unknown as Record<string, unknown>, 'n') >= 100)
        throw new ControlError('operation_quota', 'Reject or finish existing operations before preparing more.', 429);
      const expiresAt = iso(Math.min(this.clock() + ttlMs, Date.parse(who.expiresAt)));
      const op: Operation = {
        ...structuredClone(proposal), id: `op_${randomUUID()}`, subject: who.subject, integrationId: who.integrationId,
        createdAt: now, expiresAt, phase: 'prepared',
        digest: digest({ ...proposal, subject: who.subject, integrationId: who.integrationId, expiresAt }),
      };
      await sql`insert into agent.agent_operations (
          id, workspace_id, subject, integration_id, request_key, intent_hash, digest, phase,
          action, project_id, environment_id, document, created_at, expires_at)
        values (${op.id}, ${who.workspaceId}, ${who.subject}, ${who.integrationId}, ${proposal.requestKey},
          ${intentHash}, ${op.digest}, ${op.phase}, ${op.action}, ${proposal.target.projectId},
          ${proposal.target.environmentId ?? null}, ${asJson(sql, op)}, ${now}, ${expiresAt})`;
      await this.event(sql, op, 'prepared');
      return op;
    });
  }

  async findRequest(who: Principal, requestKey: string): Promise<Operation | undefined> {
    return this.sql(async (sql) => {
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject} and request_key = ${requestKey}`) as unknown as OperationRow[];
      if (!rows.length) return undefined;
      return this.scoped(who, rows[0].document);
    });
  }

  private scoped(who: Principal, op: Operation): Operation {
    checkTarget(who, op.target, 'read', this.clock());
    if (op.subject !== who.subject) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
    return op;
  }

  async get(who: Principal, id: string): Promise<Operation> {
    return this.sql(async (sql) => this.scoped(who, await this.scopedRow(sql, id, who.workspaceId, who.subject)));
  }

  /* -------------------------------- review -------------------------------- */

  /** Browser-only caller resolves a fresh live user, scope and role before using this. */
  async review(id: string, subject: string, workspace: string, expectedDigest: string, approve: boolean,
    approver = subject, role: 'editor' | 'admin' = 'editor'): Promise<Operation> {
    return this.tx(async (sql) => {
      const locked = (await sql`select document from agent.agent_operations
        where id = ${id} and workspace_id = ${workspace} and subject = ${subject} for update`) as unknown as OperationRow[];
      if (!locked.length) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
      const op = locked[0].document;
      if (op.subject !== subject || op.target.workspaceId !== workspace)
        throw new ControlError('operation_not_found', 'Operation not found.', 404);
      if (op.digest !== expectedDigest) throw new ControlError('review_changed', 'Reload and review the exact proposal.');
      if (op.phase !== 'prepared') throw new ControlError('invalid_phase', 'This proposal is no longer awaiting review.');
      if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (approve && op.plan.blocked) throw new ControlError('plan_blocked', 'Resolve blockers and prepare a new plan.');
      op.phase = approve ? 'approved' : 'rejected';
      op.approvedBy = approver; op.approvalRole = role; op.approvedAt = iso(this.clock());
      return this.write(sql, op, op.phase);
    });
  }

  /**
   * Withdraw an approval that has not been claimed. The decision is the
   * database's: one conditional update carries every precondition
   * (`unapproveStatement`), so it races a claim on the row lock and exactly one
   * of the two wins. Zero rows is never guessed at - the row is read once and
   * the refusal names what stopped it, with the codes the file store raises.
   */
  async unapprove(id: string, expectedDigest: string, by: string, workspace: string): Promise<Operation> {
    return this.tx(async (sql) => {
      const rows = (await unapproveStatement(sql, {
        id, workspaceId: workspace, digest: expectedDigest, now: iso(this.clock()),
      })) as unknown as OperationRow[];
      if (!rows.length) {
        const op = await this.scopedRow(sql, id, workspace);
        if (op.target.workspaceId !== workspace) throw new ControlError('operation_not_found', 'Operation not found.', 404);
        if (op.digest !== expectedDigest) throw new ControlError('review_changed', 'Reload and review the exact proposal.');
        if (op.phase !== 'approved') throw notWithdrawable(op.phase);
        if (Date.parse(op.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
        // Every precondition read as true a moment after the update saw one
        // false: a claim landed in between. It is claimed; there is nothing to withdraw.
        throw notWithdrawable('running');
      }
      const operation = rows[0].document;
      await this.event(sql, operation, 'unapproved', { by });
      return operation;
    });
  }

  /* --------------------------------- claim -------------------------------- */

  async claim(who: Principal, id: string, fingerprint: string, applicationAuthorizationDigest?: string): Promise<{ operation: Operation; claimed: boolean }> {
    await this.ready();
    const sql = this.client;
    const current = this.scoped(who, await this.scopedRow(sql, id, who.workspaceId, who.subject));
    checkTarget(who, current.target, current.action.startsWith('app.') ? 'publish' : 'write', this.clock());
    // Already terminal, or already dispatched by somebody: the same branch the
    // SQLite journal takes, with the same answer — the row, unchanged.
    if (['running', 'succeeded', 'failed', 'uncertain'].includes(current.phase)) return { operation: current, claimed: false };

    const now = this.clock();
    const claimed: Operation = {
      ...current, phase: 'running', workerId: this.workerId, executedByIntegration: who.integrationId,
      authorizationDigest: who.grantDigest, applicationAuthorizationDigest,
    };
    const rows = (await claimStatement(sql, {
      id, leaseOwner: this.workerId, leaseUntil: iso(now + LEASE_MS),
      authorizationDigest: who.grantDigest ?? null,
      applicationAuthorizationDigest: applicationAuthorizationDigest ?? null,
      document: claimed, now: iso(now), digest: current.digest, fingerprint,
    })) as unknown as OperationRow[];

    if (!rows.length) {
      // Zero rows is never guessed at. Read the row once and say which
      // precondition failed, with the codes the file store already raises.
      const after = await this.scopedRow(sql, id, who.workspaceId, who.subject);
      if (['running', 'succeeded', 'failed', 'uncertain'].includes(after.phase)) return { operation: after, claimed: false };
      if (after.phase !== 'approved' || !after.approvedBy || !after.approvalRole)
        throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
      if (Date.parse(after.expiresAt) <= this.clock()) throw new ControlError('plan_expired', 'Prepare a fresh plan.');
      if (after.fingerprint !== fingerprint)
        throw new ControlError('stale_plan', 'State or permissions changed. Prepare and review a new plan.');
      throw new ControlError('approval_required', 'Review and approve this exact proposal in Zenith.');
    }

    const fence = readNumber(rows[0] as unknown as Record<string, unknown>, 'fence_token');
    this.remember(id, fence);
    const operation = rows[0].document;
    await this.event(sql, operation, 'claimed');
    return { operation, claimed: true };
  }

  /** Bounded so a long-lived host cannot grow this map without limit. */
  private remember(id: string, fence: number): void {
    if (this.fences.size >= 1000) this.fences.delete(this.fences.keys().next().value as string);
    this.fences.set(id, fence);
  }

  /** Extend this instance's lease. Long-lived hosts only; a serverless request is one attempt. */
  async renew(id: string, ms = LEASE_MS): Promise<boolean> {
    const fence = this.fences.get(id);
    if (fence === undefined) return false;
    const rows = (await this.sql((sql) => renewStatement(sql, { id, fence, leaseUntil: iso(this.clock() + ms) }))) as unknown as { id: string }[];
    return rows.length > 0;
  }

  /* ------------------------------- finalize ------------------------------- */

  async finishIfValid(who: Principal, id: string, result: unknown, success: boolean, applicationAuthorizationDigest?: string): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined)
      throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    const op = await this.scopedRow(sql, id, who.workspaceId);
    if (op.subject !== who.subject || op.target.workspaceId !== who.workspaceId || op.executedByIntegration !== who.integrationId)
      throw new ControlError('authorization_changed', 'The authorized integration changed during dispatch.', 403);
    checkTarget(who, op.target, op.action.startsWith('app.') ? 'publish' : 'write', this.clock());
    const finishedAt = iso(this.clock());
    const finished: Operation = { ...op, phase: success ? 'succeeded' : 'failed', result: structuredClone(result), finishedAt };
    const rows = (await finalizeStatement(sql, {
      id, fence, phase: finished.phase as 'succeeded' | 'failed', finishedAt, document: finished,
      authorizationDigest: who.grantDigest ?? null,
      applicationAuthorizationDigest: applicationAuthorizationDigest ?? null,
    })) as unknown as OperationRow[];
    if (!rows.length) {
      // The guards are in the WHERE, so zero rows means one of them moved. Read
      // once and name it; every one of these paths ends as `uncertain` upstream.
      const leased = (await sql`select document, lease_until from agent.agent_operations
        where id = ${id} and workspace_id = ${who.workspaceId}`) as unknown as
        { document: Operation; lease_until: string | null }[];
      if (!leased.length) throw new ControlError('operation_not_found', 'Operation not found in this scope.', 404);
      const after = leased[0].document;
      if (after.phase !== 'running') throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
      if (Date.parse(after.expiresAt) <= this.clock())
        throw new ControlError('plan_expired', 'The approved operation expired before it could be finalized.', 409);
      // The lease is what a crash or a freeze leaves behind, and it has run out:
      // reconciliation may already own this row. It is not finalized as a
      // success, whatever the dispatch did.
      const until = leased[0].lease_until;
      if (until === null || Date.parse(until) <= this.clock())
        throw new ControlError('lease_expired',
          'The lease this worker held on the operation ran out before it could be finalized, so the outcome is recorded as uncertain and is never retried automatically. Inspect the linked deployment or job.', 409);
      throw new ControlError('authorization_changed', 'The integration grant, membership or role changed during dispatch.', 403);
    }
    this.fences.delete(id);
    await this.event(sql, finished, finished.phase);
    return rows[0].document;
  }

  async finish(id: string, result: unknown, success: boolean): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined) throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    const op = await this.row(sql, id);
    const finishedAt = iso(this.clock());
    const finished: Operation = { ...op, phase: success ? 'succeeded' : 'failed', result: structuredClone(result), finishedAt };
    const rows = (await finalizeStatement(sql, {
      id, fence, phase: finished.phase as 'succeeded' | 'failed', finishedAt, document: finished,
      authorizationDigest: op.authorizationDigest ?? null,
      applicationAuthorizationDigest: op.applicationAuthorizationDigest ?? null,
    })) as unknown as OperationRow[];
    if (!rows.length) throw new ControlError('operation_not_owned', 'This worker does not own the operation.');
    this.fences.delete(id);
    await this.event(sql, finished, finished.phase);
    return rows[0].document;
  }

  async uncertain(id: string): Promise<Operation> {
    await this.ready();
    const sql = this.client;
    const fence = this.fences.get(id);
    if (fence === undefined) return this.row(sql, id);
    const rows = (await uncertainStatement(sql, { id, fence })) as unknown as OperationRow[];
    this.fences.delete(id);
    if (!rows.length) return this.row(sql, id);
    await this.event(sql, rows[0].document, 'uncertain');
    return rows[0].document;
  }

  /* --------------------------------- reads -------------------------------- */

  async list(who: Principal, limit = 50, offset = 0): Promise<Operation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000)
      throw new ControlError('invalid_page', 'Use a bounded page.', 400);
    return this.sql(async (sql) => {
      // Filter before paginating, so no out-of-scope row changes the page count.
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${who.workspaceId} and subject = ${who.subject}
         order by created_at desc limit 10000`) as unknown as OperationRow[];
      return rows.map((r) => r.document)
        .filter((op) => { try { checkTarget(who, op.target, 'read', this.clock()); return true; } catch { return false; } })
        .slice(offset, offset + limit);
    });
  }

  async events(who: Principal, id: string, after = 0, limit = 50): Promise<JournalEvent[]> {
    await this.get(who, id);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ControlError('invalid_page', 'Use a bounded event page.', 400);
    return this.sql(async (sql) => {
      const rows = (await sql`
        select e.seq, e.kind, e.at, e.document from agent.agent_operation_events e
          join agent.agent_operations o on o.id = e.operation_id
         where e.operation_id = ${id} and o.workspace_id = ${who.workspaceId} and o.subject = ${who.subject}
           and e.seq > ${after} order by e.seq limit ${limit}`) as unknown as
        { seq: unknown; kind: string; at: string; document: unknown }[];
      return rows.map((row) => ({
        sequence: readNumber(row as unknown as Record<string, unknown>, 'seq'),
        kind: row.kind, at: row.at, data: row.document,
      }));
    });
  }

  /** Trusted browser service only. Never expose this lookup without separate authorization. */
  async forReview(id: string, workspace: string): Promise<Operation> {
    return this.sql(async (sql) => {
      const op = await this.scopedRow(sql, id, workspace);
      if (op.target.workspaceId !== workspace) throw new ControlError('operation_not_found', 'Operation not found.', 404);
      return op;
    });
  }

  /**
   * The review screen's list. `uncertain` rows are included so somebody is shown
   * them; they are read-only, since review, claim and unapprove all refuse a row
   * that is not in the phase they act on. (The partial review index only covers
   * prepared/approved; the workspace index serves this at the LIMIT.)
   */
  async reviewQueue(workspace: string, subject: string, admin: boolean): Promise<Operation[]> {
    return this.sql(async (sql) => {
      const rows = (await sql`
        select document from agent.agent_operations
         where workspace_id = ${workspace} and phase in ('prepared','approved','uncertain')
         order by created_at desc limit 100`) as unknown as OperationRow[];
      return rows.map((r) => r.document).filter((op) => admin || op.subject === subject);
    });
  }

  /* -------------------------------- uploads ------------------------------- */

  async putUpload(who: Principal, target: Target, appId: string, bytes: Buffer): Promise<UploadReceipt> {
    checkTarget(who, target, 'publish', this.clock());
    if (!who.appIds?.includes(appId)) throw new ControlError('scope_denied', 'Select an explicitly authorized app.', 403);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024)
      throw new ControlError('source_too_large', 'Source archive exceeds its upload limit.', 413);
    return this.tx(async (sql) => {
      const now = iso(this.clock());
      await sweepUploadsStatement(sql, { now, limit: SCAN_LIMIT });
      const usage = (await sql`
        select count(*)::int as n, coalesce(sum(octet_length(bytes)), 0)::bigint as size
          from agent.agent_uploads where workspace_id = ${who.workspaceId}`) as unknown as Record<string, unknown>[];
      const n = readNumber(usage[0], 'n'), size = readNumber(usage[0], 'size');
      if (n >= 20 || size + bytes.length > 100 * 1024 * 1024)
        throw new ControlError('upload_quota', 'Wait for pending uploads to expire before uploading more.', 429);
      const id = `upload_${randomUUID()}`;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const expires = iso(Math.min(this.clock() + 3600000, Date.parse(who.expiresAt)));
      await sql`insert into agent.agent_uploads (id, subject, workspace_id, project_id, app_id, sha256, expires_at, bytes)
        values (${id}, ${who.subject}, ${who.workspaceId}, ${target.projectId}, ${appId}, ${sha256}, ${expires}, ${bytes})`;
      return { uploadId: id, sha256, bytes: bytes.length, expiresAt: expires };
    });
  }

  async upload(who: Principal, target: Target, appId: string, id: string, expectedHash: string): Promise<Buffer> {
    checkTarget(who, target, 'publish', this.clock());
    return this.sql(async (sql) => {
      const rows = (await sql`
        select sha256, expires_at, bytes from agent.agent_uploads
         where id = ${id} and subject = ${who.subject} and workspace_id = ${who.workspaceId}
           and project_id = ${target.projectId} and app_id = ${appId}`) as unknown as
        { sha256: string; expires_at: string; bytes: Uint8Array }[];
      const row = rows[0];
      if (!who.appIds?.includes(appId) || !row || Date.parse(row.expires_at) <= this.clock() || row.sha256 !== expectedHash)
        throw new ControlError('upload_unavailable', 'Upload missing, expired, out of scope or changed. Upload and prepare again.', 404);
      const bytes = Buffer.from(row.bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
        throw new ControlError('upload_corrupt', 'Stored source integrity check failed.', 503);
      return bytes;
    });
  }

  /* --------------------------------- grants -------------------------------- */
  /** OAuth readiness is separate: a new grant migration cannot disable old journal work. */
  private async grantSql<T>(fn: (sql: AnySql) => Promise<T>): Promise<T> {
    try {
      await this.ready();
      const rows = (await selectMigrations(this.client)) as unknown as { version: unknown; name: unknown }[];
      if (AGENT_CONTROL_MIGRATIONS.some(required => !rows.some(row => Number(row.version) === required.version && row.name === required.name)))
        throw new ControlError('journal_schema',
          'The OAuth grant schema is unavailable. Apply supabase/migrations/0015_agent_oauth_grants.sql before using OAuth client grants.', 503);
      return await fn(this.client);
    } catch (error) {
      if (error instanceof ControlError) {
        if (error.code === 'journal_schema') throw new ControlError('journal_schema',
          'The OAuth grant schema is unavailable. Apply the canonical agent migrations before using OAuth client grants.', 503);
        throw error;
      }
      // Driver details may contain bound values or connection credentials.
      throw new ControlError('grant_unavailable', 'The OAuth resource grant could not be confirmed.', 503);
    }
  }
  async grants(subject: string, workspace: string): Promise<Grant[]> {
    if (!grantId.safeParse(subject).success || !grantId.safeParse(workspace).success) return invalidGrant();
    return this.grantSql(async sql => {
      const rows = (await sql`select integration_id, subject, client_id, workspace_id, oauth_issuer, expires_at, revoked,
        project_ids, environment_ids, app_ids, scopes from agent.agent_oauth_grants
        where subject = ${subject} and workspace_id = ${workspace} order by client_id, integration_id limit 101`) as unknown as GrantRow[];
      if (rows.length > 100) throw new ControlError('grant_unavailable', 'The OAuth resource grants exceed the bounded read limit.', 503);
      return rows.map(row => grantFromRow(row, subject, workspace));
    });
  }
  async getGrant(subject: string, clientId: string, workspace: string): Promise<Grant | undefined> {
    if (!grantId.safeParse(subject).success || !grantId.safeParse(workspace).success
      || typeof clientId !== 'string' || !clientId.length || clientId.length > 200) return invalidGrant();
    return this.grantSql(async sql => {
      const rows = (await sql`select integration_id, subject, client_id, workspace_id, oauth_issuer, expires_at, revoked,
        project_ids, environment_ids, app_ids, scopes from agent.agent_oauth_grants
        where subject = ${subject} and client_id = ${clientId} and workspace_id = ${workspace}`) as unknown as GrantRow[];
      if (rows.length > 1) throw new ControlError('grant_unavailable', 'The OAuth resource grant could not be confirmed.', 503);
      return rows[0] ? grantFromRow(rows[0], subject, workspace, clientId) : undefined;
    });
  }
  async setGrant(input: Grant): Promise<void> {
    // Detach and validate before the first database await; persist no extra/token fields.
    const grant = grantCopy(input);
    return this.grantSql(async () => {
      // The transaction-scoped owner lock also covers an empty owner set. Hash
      // collisions only serialize unrelated owners; they cannot change scope.
      await this.client.begin('isolation level read committed', async sql => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent.oauth.grants', grant.subject, grant.workspaceId])}, 0))`;
        const previous = await sql`select integration_id from agent.agent_oauth_grants
          where subject = ${grant.subject} and client_id = ${grant.clientId} and workspace_id = ${grant.workspaceId}`;
        if (previous.length > 1 || previous[0] && previous[0].integration_id !== grant.integrationId)
          throw new ControlError('grant_conflict', 'The OAuth resource grant binding already exists. Reload the current grant before saving.', 409);
        if (!previous.length) {
          const retained = await sql`select integration_id from agent.agent_oauth_grants
            where subject = ${grant.subject} and workspace_id = ${grant.workspaceId} limit 51`;
          if (retained.length >= GRANT_QUOTA)
            throw new ControlError('grant_quota', 'Revoke or reuse an existing client grant.', 429);
        }
        let rows: { integration_id: string }[];
        try {
          rows = (await sql`insert into agent.agent_oauth_grants
            (integration_id, subject, client_id, workspace_id, oauth_issuer, expires_at, revoked,
             project_ids, environment_ids, app_ids, scopes)
            values (${grant.integrationId}, ${grant.subject}, ${grant.clientId}, ${grant.workspaceId},
              ${grant.oauthIssuer}, ${grant.expiresAt}, ${grant.revoked ?? false}, ${asJson(sql, grant.projectIds)},
              ${grant.environmentIds === undefined ? null : asJson(sql, grant.environmentIds)},
              ${grant.appIds === undefined ? null : asJson(sql, grant.appIds)}, ${asJson(sql, grant.scopes)})
            on conflict (subject, client_id, workspace_id) do update
              set oauth_issuer = excluded.oauth_issuer, expires_at = excluded.expires_at, revoked = excluded.revoked,
                  project_ids = excluded.project_ids, environment_ids = excluded.environment_ids,
                  app_ids = excluded.app_ids, scopes = excluded.scopes
              where agent.agent_oauth_grants.integration_id = excluded.integration_id
            returning integration_id`) as unknown as { integration_id: string }[];
        } catch (error) {
          if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505')
            throw new ControlError('grant_conflict', 'The OAuth resource grant binding already exists. Reload the current grant before saving.', 409);
          throw error;
        }
        if (rows.length !== 1 || rows[0].integration_id !== grant.integrationId)
          throw new ControlError('grant_conflict', 'The OAuth resource grant binding already exists. Reload the current grant before saving.', 409);
      });
    });
  }
}

// Capture the class's original descriptors during module initialization, before
// default creation can observe a substituted method or accessor. This baseline
// is private; a current mutable prototype can never register itself as genuine.
const canonicalJournalPrototypeDescriptor = Object.freeze({ ...Object.getOwnPropertyDescriptor(PgAgentJournal, 'prototype')! });
const canonicalJournalPrototype: object = canonicalJournalPrototypeDescriptor.value;
const canonicalJournalPrototypeParent = Object.getPrototypeOf(canonicalJournalPrototype);
const canonicalJournalMethods = new Map<PropertyKey, PropertyDescriptor>(Reflect.ownKeys(canonicalJournalPrototype)
  .map(key => [key, Object.freeze({ ...Object.getOwnPropertyDescriptor(canonicalJournalPrototype, key)! })]));
function canonicalJournalMethodsMatch(): boolean {
  return sameJournalDescriptor(Object.getOwnPropertyDescriptor(PgAgentJournal, 'prototype'), canonicalJournalPrototypeDescriptor)
    && Object.getPrototypeOf(canonicalJournalPrototype) === canonicalJournalPrototypeParent
    && Reflect.ownKeys(canonicalJournalPrototype).length === canonicalJournalMethods.size
    && [...canonicalJournalMethods].every(([key, before]) => "value" in before && typeof before.value === 'function'
      && sameJournalDescriptor(Object.getOwnPropertyDescriptor(canonicalJournalPrototype, key), before));
}

/** The process-wide Postgres journal, created on first use. */
export function pgAgentJournal(): PgAgentJournal {
  if (!canonicalJournalMethodsMatch()) throw new ControlError('grant_unavailable', 'Current native journal methods are unavailable.', 503);
  const selected = Object.getOwnPropertyDescriptor(globalThis, '__zenithAgentPgJournal');
  if (selected && !('value' in selected)) throw new ControlError('grant_unavailable', 'Current native journal selection is unavailable.', 503);
  if (selected?.value) return selected.value;
  const clientSelection = Object.getOwnPropertyDescriptor(globalThis, '__zenithHostedPg');
  if (clientSelection && !('value' in clientSelection)) throw new ControlError('grant_unavailable', 'Current native client selection is unavailable.', 503);
  const journal = new PgAgentJournal(), client = pgAuthorityClient();
  if (!canonicalJournalMethodsMatch() || Object.getPrototypeOf(journal) !== canonicalJournalPrototype)
    throw new ControlError('grant_unavailable', 'Current native journal methods are unavailable.', 503);
  journalOrigins.set(journal, { journal, client, prototype: canonicalJournalPrototype,
    own: new Map(Reflect.ownKeys(journal).filter(key => key !== 'checked').map(key => [key, Object.getOwnPropertyDescriptor(journal, key)!])),
    methods: canonicalJournalMethods,
    checked: undefined, checkedDescriptor: Object.getOwnPropertyDescriptor(journal, 'checked') });
  Object.defineProperty(globalThis, '__zenithAgentPgJournal', { configurable: true, enumerable: true, writable: true, value: journal });
  return journal;
}

/** Forget the singleton. Tests and scripts; a server exits. */
export function resetPgAgentJournal(): void {
  Reflect.deleteProperty(globalThis, '__zenithAgentPgJournal');
}
