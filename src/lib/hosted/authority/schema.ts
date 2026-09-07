/**
 * The control authority's schema, as an ordered list of migrations.
 *
 * Rules this file lives by:
 *
 *  - **An applied migration is frozen.** Editing the SQL of a version that has
 *    shipped gives a fresh install a different schema from an existing one,
 *    with nothing to notice the difference. Add a version; never edit one.
 *  - **Every enum is a CHECK constraint, every relationship a FOREIGN KEY.**
 *    The types in `@/lib/hosted/contracts` say what is legal; the database
 *    refuses everything else, so a bug in one repository cannot leave a grant
 *    in a state the admission code has no branch for.
 *  - **Two columns are deliberately unconstrained.** `hosted_events.event`
 *    holds a vocabulary that PLAN-R3 R3-13 records as provisional pending the
 *    page-36 list, and `hosted_jobs.phase` is owned by W7's job runner. A CHECK
 *    on either would turn a documented open question into a migration.
 *    TypeScript still narrows both (`HostedEventName`, W7's phase union), so
 *    the looseness stops at the database boundary.
 *  - **Timestamps are ISO-8601 UTC TEXT** so range predicates are plain string
 *    comparisons — see `sql.ts`.
 *
 * Workstream W1 (hosted R3).
 */
import type { DatabaseSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";
import { nowIso, readNumber, readText, type SqlRow } from "./sql";
import { transact } from "./tx";

/** One schema version: applied whole, inside one transaction, recorded on success. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** A row of `schema_migrations`. */
export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
}

const V1 = `
CREATE TABLE apps (
  id                TEXT    NOT NULL PRIMARY KEY,
  workspace_id      TEXT    NOT NULL,
  slug              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  contract_version  INTEGER NOT NULL CHECK (contract_version = 1),
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  state             TEXT    NOT NULL CHECK (state IN ('active','suspended','recovering','deleted')),
  state_reason      TEXT,
  created_by        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  active_release_id TEXT             REFERENCES releases(id),
  active_fence      INTEGER NOT NULL DEFAULT 0 CHECK (active_fence >= 0),
  runtime           TEXT    NOT NULL CHECK (runtime IN ('local','cloudflare'))
);
CREATE INDEX apps_workspace ON apps(workspace_id);

CREATE TABLE app_grants (
  id             TEXT NOT NULL PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES apps(id),
  subject        TEXT NOT NULL,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  state          TEXT NOT NULL CHECK (state IN ('active','revoked','needs_reapproval')),
  granted_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  revoked_at     TEXT,
  revoked_by     TEXT,
  revoked_reason TEXT,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
-- One live grant per (app, subject). Revoked and needs_reapproval rows stay as
-- history, which is why the uniqueness is partial rather than on the pair.
CREATE UNIQUE INDEX app_grants_active ON app_grants(app_id, subject) WHERE state = 'active';
CREATE INDEX app_grants_app ON app_grants(app_id);
CREATE INDEX app_grants_subject ON app_grants(subject);

CREATE TABLE app_invites (
  id          TEXT NOT NULL PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  state       TEXT NOT NULL CHECK (state IN ('pending','accepted','expired','revoked','superseded')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  supersedes  TEXT REFERENCES app_invites(id),
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE INDEX app_invites_app ON app_invites(app_id);
CREATE INDEX app_invites_email ON app_invites(email);

CREATE TABLE invite_deliveries (
  id                  TEXT    NOT NULL PRIMARY KEY,
  invite_id           TEXT    NOT NULL REFERENCES app_invites(id),
  state               TEXT    NOT NULL CHECK (state IN ('pending','sending','sent','failed')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at          TEXT    NOT NULL,
  claimed_at          TEXT,
  settled_at          TEXT,
  transport           TEXT    CHECK (transport IS NULL OR transport IN ('smtp','log')),
  provider_message_id TEXT,
  error               TEXT,
  -- The AES-GCM sealed invitation token W5 needs to rebuild the email on a
  -- retry. Opaque bytes here: this module never holds the key and never looks
  -- inside. Erased by clearSealedPayload() once the row settles.
  sealed_payload      BLOB
);
CREATE INDEX invite_deliveries_invite ON invite_deliveries(invite_id);
CREATE INDEX invite_deliveries_state ON invite_deliveries(state, created_at);

CREATE TABLE app_sessions (
  id                TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 64),
  app_id            TEXT NOT NULL REFERENCES apps(id),
  subject           TEXT NOT NULL,
  grant_id          TEXT NOT NULL REFERENCES app_grants(id),
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  terminated_at     TEXT,
  terminated_reason TEXT CHECK (terminated_reason IS NULL OR terminated_reason IN ('signed_out','revoked','expired','restored','operator')),
  CHECK ((terminated_at IS NULL) = (terminated_reason IS NULL))
);
CREATE INDEX app_sessions_subject ON app_sessions(subject);
CREATE INDEX app_sessions_app ON app_sessions(app_id);
CREATE INDEX app_sessions_grant ON app_sessions(grant_id);

CREATE TABLE app_exchanges (
  code_hash   TEXT NOT NULL PRIMARY KEY CHECK (length(code_hash) = 64),
  app_id      TEXT NOT NULL REFERENCES apps(id),
  subject     TEXT NOT NULL,
  grant_id    TEXT NOT NULL REFERENCES app_grants(id),
  -- The opaque browser state echoed back on redemption (AppExchange.state).
  -- Round-tripped, never interpreted, and never overwritten: the lifecycle
  -- lives in the status column so redemption can still answer with it.
  state       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','consumed','expired')),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  session_id  TEXT REFERENCES app_sessions(id) ON DELETE SET NULL,
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX app_exchanges_expiry ON app_exchanges(expires_at);

CREATE TABLE hosted_jobs (
  id           TEXT    NOT NULL PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('publish','rollback','suspend','resume','export','restore')),
  workspace_id TEXT    NOT NULL,
  app_id       TEXT    NOT NULL REFERENCES apps(id),
  actor        TEXT    NOT NULL,
  intent_hash  TEXT    NOT NULL CHECK (length(intent_hash) = 64),
  status       TEXT    NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  phase        TEXT    NOT NULL,
  phase_data   TEXT    NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner  TEXT,
  lease_until  TEXT,
  fence_token  INTEGER NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  result       TEXT,
  error        TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  finished_at  TEXT
);
-- Single flight: the database, not a code path, is what makes two publishes
-- for one app impossible. A second claim fails on this index.
CREATE UNIQUE INDEX hosted_jobs_single_flight ON hosted_jobs(app_id) WHERE status = 'running';
CREATE INDEX hosted_jobs_app ON hosted_jobs(app_id, created_at);
CREATE INDEX hosted_jobs_status ON hosted_jobs(status, lease_until);

CREATE TABLE hosted_outbox (
  id              TEXT    NOT NULL PRIMARY KEY,
  idempotency_key TEXT    NOT NULL UNIQUE,
  kind            TEXT    NOT NULL CHECK (kind IN ('invite_email','revocation_ledger','provider_cleanup','spend_alert','webhook')),
  payload         TEXT    NOT NULL,
  state           TEXT    NOT NULL CHECK (state IN ('pending','sending','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at      TEXT    NOT NULL,
  claimed_at      TEXT,
  settled_at      TEXT,
  error           TEXT
);
CREATE INDEX hosted_outbox_state ON hosted_outbox(state, created_at);

CREATE TABLE artifacts (
  digest      TEXT    NOT NULL PRIMARY KEY CHECK (length(digest) = 64),
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  file_count  INTEGER NOT NULL CHECK (file_count >= 0),
  provenance  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  verified_at TEXT
);

CREATE TABLE releases (
  id              TEXT    NOT NULL PRIMARY KEY,
  app_id          TEXT    NOT NULL REFERENCES apps(id),
  number          INTEGER NOT NULL CHECK (number >= 1),
  artifact_digest TEXT    NOT NULL REFERENCES artifacts(digest),
  schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
  job_id          TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('candidate','verified','active','superseded','failed','rolled_back')),
  runtime         TEXT    NOT NULL CHECK (runtime IN ('local','cloudflare')),
  runtime_ref     TEXT    NOT NULL DEFAULT '{}',
  probe           TEXT,
  created_at      TEXT    NOT NULL,
  verified_at     TEXT,
  activated_at    TEXT,
  superseded_at   TEXT,
  error           TEXT,
  UNIQUE (app_id, number)
);
CREATE INDEX releases_app ON releases(app_id, number);
CREATE INDEX releases_artifact ON releases(artifact_digest);

CREATE TABLE quota_counters (
  app_id   TEXT    NOT NULL REFERENCES apps(id),
  day      TEXT    NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  denied   INTEGER NOT NULL DEFAULT 0 CHECK (denied >= 0),
  PRIMARY KEY (app_id, day)
);

CREATE TABLE usage_ledger (
  id           TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id       TEXT REFERENCES apps(id),
  kind         TEXT NOT NULL CHECK (kind IN ('build_ms','requests','storage_bytes','emails','provider_usd')),
  amount       REAL NOT NULL,
  at           TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX usage_ledger_workspace ON usage_ledger(workspace_id, at);
CREATE INDEX usage_ledger_app ON usage_ledger(app_id, at);

-- No foreign key on app_id, and that is the point: this ledger is copied
-- off-host and reconciled against a *restored older snapshot*, in which the
-- app row may not exist yet. A reference to a table it has to outlive would
-- make the reconciliation G23 asks for impossible.
CREATE TABLE revocation_ledger (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  app_id   TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  subject  TEXT NOT NULL,
  by       TEXT NOT NULL,
  reason   TEXT NOT NULL
);
CREATE INDEX revocation_ledger_subject ON revocation_ledger(subject);

CREATE TABLE backup_manifests (
  id             TEXT    NOT NULL PRIMARY KEY,
  created_at     TEXT    NOT NULL,
  digest         TEXT    NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size >= 0),
  files          TEXT    NOT NULL,
  revocation_seq INTEGER NOT NULL CHECK (revocation_seq >= 0),
  key_id         TEXT    NOT NULL
);
CREATE INDEX backup_manifests_created ON backup_manifests(created_at);

CREATE TABLE hosted_events (
  id           TEXT    NOT NULL PRIMARY KEY,
  event        TEXT    NOT NULL CHECK (length(event) > 0),
  ts           TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,
  app_id       TEXT,
  subject_hash TEXT,
  release_id   TEXT,
  outcome      TEXT    NOT NULL CHECK (outcome IN ('ok','error','denied')),
  logical_id   TEXT,
  assisted     INTEGER NOT NULL CHECK (assisted IN (0,1)),
  actor_class  TEXT    NOT NULL CHECK (actor_class IN ('founder','test','external','system')),
  props        TEXT
);
-- One row per logical operation. Rows without a logical id are not deduped:
-- SQL NULL is never equal to itself, so they simply do not enter this index.
CREATE UNIQUE INDEX hosted_events_logical ON hosted_events(event, logical_id) WHERE logical_id IS NOT NULL;
CREATE INDEX hosted_events_ts ON hosted_events(ts);
CREATE INDEX hosted_events_app ON hosted_events(app_id, ts);
`;

/**
 * Every schema version, in order. Append only.
 *
 * ponytail: migrations are forward-only — there is no `down`. Rolling a hosted
 * install back a version means restoring the backup taken before the upgrade
 * (`backupAuthority`). Reversible migrations become worth writing when a
 * second operator runs upgrades on a host this project does not have yet;
 * until then a down-migration is untested code that would be trusted in
 * exactly the worst moment.
 */
/**
 * v2: an invitation delivery may settle with `transport = 'none'` — no email
 * transport is configured and the owner shares the link by hand. Visible on
 * the row, not a NULL that could mean anything. SQLite cannot alter a CHECK,
 * so the table is rebuilt; the copy keeps every row and both indexes.
 */
const V2 = `
CREATE TABLE invite_deliveries_v2 (
  id                  TEXT    NOT NULL PRIMARY KEY,
  invite_id           TEXT    NOT NULL REFERENCES app_invites(id),
  state               TEXT    NOT NULL CHECK (state IN ('pending','sending','sent','failed')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at          TEXT    NOT NULL,
  claimed_at          TEXT,
  settled_at          TEXT,
  transport           TEXT    CHECK (transport IS NULL OR transport IN ('smtp','log','none')),
  provider_message_id TEXT,
  error               TEXT,
  sealed_payload      BLOB
);
INSERT INTO invite_deliveries_v2
  SELECT id, invite_id, state, attempts, created_at, claimed_at, settled_at, transport,
         provider_message_id, error, sealed_payload
  FROM invite_deliveries;
DROP TABLE invite_deliveries;
ALTER TABLE invite_deliveries_v2 RENAME TO invite_deliveries;
CREATE INDEX invite_deliveries_invite ON invite_deliveries(invite_id);
CREATE INDEX invite_deliveries_state ON invite_deliveries(state, created_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "control-authority-v1", sql: V1 },
  { version: 2, name: "invite-delivery-transport-none", sql: V2 },
];

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
)`;

/** What `schema_migrations` records, oldest first. */
export function appliedMigrations(db: DatabaseSync): AppliedMigration[] {
  db.exec(MIGRATIONS_TABLE);
  return db
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .all()
    .map((row: SqlRow) => ({
      version: readNumber(row, "version"),
      name: readText(row, "name"),
      appliedAt: readText(row, "applied_at"),
    }));
}

/**
 * Bring `db` up to the newest version and answer with the versions this call
 * applied — empty when the database was already current, which is what makes
 * reopening an existing file a no-op.
 *
 * Each migration is one transaction: its statements and its `schema_migrations`
 * row commit together, so a crash half way through leaves the previous version
 * intact rather than a schema no version number describes.
 */
export function migrate(db: DatabaseSync): number[] {
  assertMigrationsWellFormed();
  const already = new Set(appliedMigrations(db).map((m) => m.version));
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (already.has(migration.version)) continue;
    transact(db, (conn) => {
      conn.exec(migration.sql);
      conn
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, nowIso());
    });
    applied.push(migration.version);
  }
  return applied;
}

function assertMigrationsWellFormed(): void {
  let previous = 0;
  for (const migration of MIGRATIONS) {
    if (!Number.isInteger(migration.version) || migration.version <= previous)
      throw new HostedError(
        "internal",
        `Hosted migration "${migration.name}" has version ${migration.version}, which does not follow ${previous}.`,
        {
          fix: "Give every migration in src/lib/hosted/authority/schema.ts a whole number strictly greater than the one before it, starting at 1.",
        }
      );
    previous = migration.version;
  }
}
