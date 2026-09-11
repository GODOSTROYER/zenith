/**
 * Move a file-store data directory into Supabase Postgres.
 *
 *     npm run migrate:postgres              # import
 *     npm run migrate:postgres -- --verify  # per-table row counts, no writes
 *     ZENITH_DATA=/path/to/.data npm run migrate:postgres
 *
 * ## What it moves
 *
 * **Every registered collection**, and it learns them from the registry rather
 * than listing them. `src/lib/db/pg/all.ts` imports one module per package —
 * `core.ts` (workspaces, members, invites, connections, projects,
 * environments, settings), `history.ts`, `audit.ts`, `alerts.ts` — and each
 * calls `registerCollection()` as an import side effect. So this script
 * iterates `rowAdapters()` in registration order, which **is** foreign-key
 * order, and a collection a package adds tomorrow migrates with no edit here.
 * `toRow()` from the store encodes each row, so the bulk import and the request
 * path cannot encode one two different ways.
 *
 * Plus the four things that are not collections at all, because they live in
 * the data directory as logs and side files rather than in `state.json`:
 *
 *   `events.jsonl`         → `deployment_events`  (seq and ts preserved)
 *   `audit.jsonl`          → `audit_events`       (ts preserved; `id` unique)
 *   `revisions/<id>.json`  → `revision_manifests` (cold storage, one per revision)
 *   `secrets.json`         → `secrets`            (split, never decrypted)
 *
 * The secret import is a **move of ciphertext**: the stored string is
 * `base64(iv).base64(authTag).base64(ciphertext)` and the table has a column
 * for each of the three, so the split is a string split. `ZENITH_SECRET_KEY` is
 * never read, nothing is decrypted, and no value is ever printed.
 *
 * ## Idempotent
 *
 * Every insert is an upsert with `ignoreDuplicates`, so a row that is already
 * there is left exactly as it is. Re-running after a partial failure finishes
 * the job rather than doubling it, and re-running after a successful run
 * changes nothing. It never deletes.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { INSTALL_SETTINGS_ID, pgClient, toRow } from "@/lib/db/postgres-store";
import type { PgCollection } from "@/lib/db/postgres-store";
// Importing the store above already pulls in `./pg/all`; naming it here as well
// is the documented way to say "every package's collections must be registered
// before this script reads the registry", and it survives a refactor of the
// store's own imports.
import "@/lib/db/pg/all";
import { adapterFor, rowAdapters } from "@/lib/db/pg/registry";
import { FileStore } from "@/lib/db/file-store";
import type { AuditEvent, DeploymentEvent } from "@/lib/domain/types";
import type { Database } from "@/lib/db/types";
import { env } from "@/lib/env";

/** PostgREST is happy with far more, but a small batch keeps a failure legible. */
const BATCH = 200;

const args = new Set(process.argv.slice(2));
const VERIFY = args.has("--verify");

/** Tables that are not collections: the four log/side-file imports below. */
const LOG_TABLES = ["deployment_events", "audit_events", "revision_manifests", "secrets"] as const;

const row = (n: number): string => String(n).padStart(6);
const report = (table: string, n: number, what = "row(s) offered"): void =>
  console.log(`  ${table.padEnd(20)} ${row(n)} ${what}`);

/* ------------------------------- collections ------------------------------- */

/**
 * The primary key PostgREST resolves a conflict on. Only the collections whose
 * adapter says `scopedByWorkspace` are keyed by the pair; the registry knows,
 * so this script does not have to name `members`.
 */
const conflictTarget = (collection: PgCollection): string =>
  adapterFor(collection).scopedByWorkspace ? "workspace_id,id" : "id";

async function upsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await pgClient()
      .from(table)
      .upsert(rows.slice(i, i + BATCH), { onConflict, ignoreDuplicates: true });
    if (error)
      throw new Error(
        `Importing ${table} failed at row ${i}: ${error.message}. ` +
          `Fix: apply supabase/migrations/0001_system_of_record.sql to the project named by ` +
          `NEXT_PUBLIC_SUPABASE_URL, then run this again — it is idempotent and will resume.`
      );
  }
}

/**
 * One registered collection, encoded by its own adapter.
 *
 * A row whose adapter cannot name a workspace is skipped and said out loud: an
 * environment whose project is not in this data directory is a broken row, and
 * importing it under a guessed tenant would be worse than leaving it behind.
 */
export async function importCollection(collection: PgCollection): Promise<number> {
  const adapter = adapterFor(collection);
  const data = FileStore.db();
  const rows: Record<string, unknown>[] = [];
  for (const item of adapter.rows!(data)) {
    const workspaceId = adapter.tenant(item as never, { db: data });
    if (!workspaceId) {
      console.warn(`  ! skipped ${collection} ${item.id}: no workspace owns it in this data directory.`);
      continue;
    }
    rows.push(toRow(collection, item, workspaceId));
  }
  await upsert(adapter.table, rows, conflictTarget(collection));
  report(adapter.table, rows.length);
  return rows.length;
}

/**
 * The settings bag, minus invites (which have their own table and their own
 * adapter). One row, the reserved install-global id — `Database.settings` is
 * install-wide, not per-workspace, whatever the column is called.
 */
async function importSettings(): Promise<void> {
  const { invites: _invites, ...settings } = FileStore.db().settings;
  const { error } = await pgClient()
    .from("settings")
    .upsert(
      { workspace_id: INSTALL_SETTINGS_ID, data: settings, version: 1, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id", ignoreDuplicates: true }
    );
  if (error) throw new Error(`Importing settings failed: ${error.message}`);
  report("settings", 1);
}

/** Seed the change feed so the first poll has a number to compare against. */
async function seedFeed(): Promise<void> {
  const rows = FileStore.db().workspaces.map((w) => ({
    workspace_id: w.id,
    version: 1,
    touched_projects: [],
    updated_at: new Date().toISOString(),
  }));
  if (rows.length === 0) return;
  const { error } = await pgClient()
    .from("workspace_versions")
    .upsert(rows, { onConflict: "workspace_id", ignoreDuplicates: true });
  if (error) throw new Error(`Seeding workspace_versions failed: ${error.message}`);
}

/* ------------------------------ tenant lookups ----------------------------- */

/**
 * Which workspace owns a project / a deployment / a revision.
 *
 * The logs carry no tenant — nothing in the file store needed one, because the
 * file store has exactly one tenant per directory. Every Postgres table has a
 * `workspace_id`, so the import has to derive it, and the only honest route is
 * the graph in `state.json`: deployment → project → workspace.
 */
export interface Tenants {
  byProject: Map<string, string>;
  byDeployment: Map<string, string>;
  byRevision: Map<string, string>;
}

export function tenants(d: Database): Tenants {
  const byProject = new Map(d.projects.map((p) => [p.id, p.workspaceId]));
  const byDeployment = new Map<string, string>();
  for (const dep of d.deployments) {
    const ws = byProject.get(dep.projectId);
    if (ws) byDeployment.set(dep.id, ws);
  }
  const byRevision = new Map<string, string>();
  for (const r of d.revisions) {
    const ws = byProject.get(r.projectId);
    if (ws) byRevision.set(r.id, ws);
  }
  return { byProject, byDeployment, byRevision };
}

/* --------------------------------- JSONL ---------------------------------- */

/**
 * Read a `.jsonl` log a line at a time.
 *
 * Streamed rather than slurped: `events.jsonl` in a long-lived install is the
 * largest file in the data directory by a wide margin, and a migration that
 * needs the whole log in memory is a migration that fails on the install that
 * most needs it. A line that will not parse is counted and skipped — a torn
 * final line from a crash must not stop the other 200,000.
 */
async function eachLine(
  file: string,
  onRow: (value: unknown) => void
): Promise<{ read: number; bad: number }> {
  if (!fs.existsSync(file)) return { read: 0, bad: 0 };
  let read = 0;
  let bad = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      onRow(JSON.parse(line));
      read++;
    } catch {
      bad++;
    }
  }
  return { read, bad };
}

/**
 * `events.jsonl` → `deployment_events`.
 *
 * `(deployment_id, seq)` is the primary key and `seq` is the domain's own dense
 * per-deployment counter, so it is preserved exactly: the SSE tail replays from
 * `?after=<seq>` and a renumbered log would replay the wrong events. `ts` is
 * preserved for the same reason — these rows are a record of when something
 * happened, not of when it was copied. `body` holds the event minus the four
 * promoted columns, which is the same "promoted out of `data`" convention every
 * collection adapter follows.
 */
export function deploymentEventRow(
  event: DeploymentEvent,
  workspaceId: string
): Record<string, unknown> {
  const { deploymentId: _id, seq: _seq, ts: _ts, ...body } = event;
  return {
    deployment_id: event.deploymentId,
    seq: event.seq,
    workspace_id: workspaceId,
    ts: event.ts,
    body,
  };
}

export async function importEvents(t: Tenants): Promise<number> {
  const file = path.join(env().ZENITH_DATA, "events.jsonl");
  const rows: Record<string, unknown>[] = [];
  let orphans = 0;
  const { bad } = await eachLine(file, (value) => {
    const event = value as DeploymentEvent;
    const workspaceId = t.byDeployment.get(event.deploymentId);
    if (!workspaceId) {
      orphans++;
      return;
    }
    rows.push(deploymentEventRow(event, workspaceId));
  });
  await upsert("deployment_events", rows, "deployment_id,seq");
  report("deployment_events", rows.length);
  if (orphans)
    console.warn(
      `  ! skipped ${orphans} event(s) whose deployment is no longer in state.json — ` +
        `there is no workspace to file them under.`
    );
  if (bad) console.warn(`  ! skipped ${bad} unparseable line(s) in events.jsonl.`);
  return rows.length;
}

/**
 * `audit.jsonl` → `audit_events`.
 *
 * `seq` is deliberately **not** carried across: the column is a `bigserial` and
 * the file store has no sequence at all, only a timestamp. `id` is the identity
 * that makes the import idempotent, and the migration relies on the unique
 * index on it — re-running offers the same ids and changes nothing. `ts` is
 * preserved; the audit log is evidence and its timestamps are the evidence.
 */
export function auditEventRow(event: AuditEvent): Record<string, unknown> {
  const { id, workspaceId, ts, projectId, environmentId, actor, actionId, result, ...rest } = event;
  return {
    id,
    workspace_id: workspaceId,
    ts,
    project_id: projectId ?? null,
    environment_id: environmentId ?? null,
    actor_type: actor?.type ?? null,
    action_id: actionId,
    result,
    // The actor itself stays in `data`: only its `type` is promoted, because
    // only the type is filtered on (`AuditFilter.actorType`).
    data: { actor, ...rest },
  };
}

export async function importAudit(): Promise<number> {
  const file = path.join(env().ZENITH_DATA, "audit.jsonl");
  const rows: Record<string, unknown>[] = [];
  let untenanted = 0;
  const { bad } = await eachLine(file, (value) => {
    const event = value as AuditEvent;
    if (!event.workspaceId) {
      untenanted++;
      return;
    }
    rows.push(auditEventRow(event));
  });
  await upsert("audit_events", rows, "id");
  report("audit_events", rows.length);
  if (untenanted)
    console.warn(`  ! skipped ${untenanted} audit row(s) with no workspaceId.`);
  if (bad) console.warn(`  ! skipped ${bad} unparseable line(s) in audit.jsonl.`);
  return rows.length;
}

/**
 * `revisions/<id>.json` → `revision_manifests`.
 *
 * Driven by the revisions in `state.json`, not by a `readdir`: the table's
 * primary key references `revisions.id`, so a side file whose revision is gone
 * has nowhere to land. `Revision.manifest` is the file store's own lazy
 * accessor, so reading it here reads exactly that file.
 *
 * Skipped entirely — with a sentence, not silently — when no `revisions`
 * collection is registered yet, because the parent rows would not be there.
 */
export async function importRevisionManifests(t: Tenants): Promise<number> {
  const registered = rowAdapters().some((a) => a.collection === "revisions");
  if (!registered) {
    console.log(
      "  revision_manifests   skipped: no `revisions` collection is registered, so the rows " +
        "they reference are not in Postgres yet."
    );
    return 0;
  }
  const rows: Record<string, unknown>[] = [];
  for (const revision of FileStore.db().revisions) {
    const workspaceId = t.byRevision.get(revision.id);
    if (!workspaceId) continue;
    let manifest;
    try {
      manifest = revision.manifest;
    } catch {
      console.warn(`  ! skipped revision ${revision.id}: its manifest file is missing or unreadable.`);
      continue;
    }
    if (!manifest) continue;
    rows.push({
      revision_id: revision.id,
      workspace_id: workspaceId,
      manifest,
      version: 1,
      updated_at: new Date().toISOString(),
    });
  }
  await upsert("revision_manifests", rows, "revision_id");
  report("revision_manifests", rows.length);
  return rows.length;
}

/**
 * `secrets.json` → `secrets`.
 *
 * The file holds one `cipher` string per reference —
 * `base64(iv).base64(authTag).base64(ciphertext)` — and the table holds the
 * three parts in their own columns. So this is a `split(".")` and nothing else:
 * no key is read, nothing is decrypted, and no value reaches a log line. A row
 * whose cipher is not three parts is skipped by reference name, because a
 * half-imported ciphertext is an unrecoverable value.
 */
export function secretRows(file: {
  workspaces?: Record<string, Record<string, { cipher?: string } & Record<string, unknown>>>;
}): { rows: Record<string, unknown>[]; malformed: string[] } {
  const rows: Record<string, unknown>[] = [];
  const malformed: string[] = [];
  for (const [workspaceId, refs] of Object.entries(file.workspaces ?? {})) {
    for (const [ref, stored] of Object.entries(refs ?? {})) {
      const parts = String(stored?.cipher ?? "").split(".");
      if (parts.length !== 3 || parts.some((p) => !p)) {
        malformed.push(`${workspaceId}/${ref}`);
        continue;
      }
      const { cipher: _cipher, ...meta } = stored;
      rows.push({
        workspace_id: workspaceId,
        ref,
        iv: parts[0],
        auth_tag: parts[1],
        ciphertext: parts[2],
        // The key this was sealed with is still ZENITH_SECRET_KEY; the column
        // exists for a future rotation and every migrated row is generation 1.
        key_version: 1,
        // `meta.version` is the secret's own rotation count and stays inside
        // the bag; the row's `version` column is the store's concurrency guard
        // and is a different number with the same name.
        meta,
        version: 1,
        updated_at: new Date().toISOString(),
      });
    }
  }
  return { rows, malformed };
}

export async function importSecrets(): Promise<number> {
  const file = path.join(env().ZENITH_DATA, "secrets.json");
  if (!fs.existsSync(file)) {
    report("secrets", 0);
    return 0;
  }
  let parsed: Parameters<typeof secretRows>[0];
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `${file} is not readable JSON, so this migration cannot tell whether it holds your secrets. ` +
        `Nothing was imported from it. Restore it from a backup and run again.`
    );
  }
  const { rows, malformed } = secretRows(parsed);
  await upsert("secrets", rows, "workspace_id,ref");
  report("secrets", rows.length);
  for (const ref of malformed)
    console.warn(`  ! skipped secret ${ref}: its stored cipher is not iv.tag.ciphertext.`);
  return rows.length;
}

/* --------------------------------- verify --------------------------------- */

/** What is actually in the database now, per table — the answer `--verify` prints. */
async function verify(): Promise<void> {
  const tables = [
    ...rowAdapters().map((a) => a.table),
    "settings",
    "workspace_versions",
    ...LOG_TABLES,
  ];
  console.log("Rows in Postgres:");
  for (const table of [...new Set(tables)]) {
    const { count, error } = await pgClient().from(table).select("*", { count: "exact", head: true });
    console.log(
      `  ${table.padEnd(20)} ${error ? `error: ${error.message}` : row(count ?? 0)}`
    );
  }
}

async function main(): Promise<void> {
  if (VERIFY) {
    await verify();
    return;
  }
  const collections = rowAdapters().map((a) => a.collection);
  console.log(
    `Importing ${env().ZENITH_DATA} into Postgres.\n` +
      `Collections registered: ${collections.join(", ")}\n`
  );
  // Registration order is foreign-key order, so this loop is the FK order too.
  for (const collection of collections) await importCollection(collection);
  await importSettings();
  await seedFeed();

  console.log("\nLogs and side files:");
  const t = tenants(FileStore.db());
  await importEvents(t);
  await importAudit();
  await importRevisionManifests(t);
  await importSecrets();

  console.log("\nDone. Re-run with --verify to see what landed.");
  await verify();
}

// `--verify`/import only when run as a script; the row builders above are
// imported directly by tests/scripts/migrate.test.ts.
const invoked = process.argv[1] ?? "";
if (/migrate-to-postgres\.ts$/.test(invoked))
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
