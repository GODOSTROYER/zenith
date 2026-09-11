/**
 * Move a file-store data directory into Supabase Postgres.
 *
 *     npm run migrate:postgres              # import
 *     npm run migrate:postgres -- --verify  # per-table row counts, no writes
 *     ZENITH_DATA=/path/to/.data npm run migrate:postgres
 *
 * Phase 2 only: workspaces, members, invites, connections, projects,
 * environments and the install-global settings bag. Revisions, deployments,
 * events, audit rows, findings, navigator runs, alerts and secrets stay in the
 * data directory — the Postgres store still reads them from there (see the
 * hybrid note at the top of src/lib/db/postgres-store.ts), so importing them
 * now would create a second copy nothing reads.
 *
 * Idempotent: every insert is an upsert with `ignoreDuplicates`, so a row that
 * is already there is left exactly as it is. Re-running after a partial failure
 * finishes the job rather than doubling it, and re-running after a successful
 * run changes nothing. It never deletes.
 *
 * Order is foreign-key order — workspaces before members, projects before
 * environments — because `environments.project_id` really does reference
 * `projects.id`.
 */
import { INSTALL_SETTINGS_ID, pgClient, tableOf, toRow } from "@/lib/db/postgres-store";
import type { PgCollection } from "@/lib/db/postgres-store";
import { FileStore } from "@/lib/db/file-store";
import type { Invite } from "@/lib/domain/types";
import { env } from "@/lib/env";

/** PostgREST is happy with far more, but a small batch keeps a failure legible. */
const BATCH = 200;

const args = new Set(process.argv.slice(2));
const VERIFY = args.has("--verify");

/** Every Phase-2 table, in the order rows may legally arrive. */
const ORDER: PgCollection[] = [
  "workspaces",
  "members",
  "invites",
  "connections",
  "projects",
  "environments",
];

const client = pgClient();

function rowsFor(collection: PgCollection): Record<string, unknown>[] {
  const d = FileStore.db();
  switch (collection) {
    case "workspaces":
      return d.workspaces.map((w) => toRow("workspaces", w, w.id));
    case "members":
      return d.members.map((m) => toRow("members", m, m.workspaceId));
    case "invites": {
      const raw = d.settings.invites;
      const invites = Array.isArray(raw) ? (raw as Invite[]) : [];
      return invites.map((i) => toRow("invites", i, i.workspaceId));
    }
    case "connections":
      return d.connections.map((c) => toRow("connections", c, c.workspaceId));
    case "projects":
      return d.projects.map((p) => toRow("projects", p, p.workspaceId));
    case "environments": {
      // An environment reaches its tenant through its project; an orphan is a
      // broken row, and importing it under a guessed workspace would be worse
      // than leaving it behind and saying so.
      const byProject = new Map(d.projects.map((p) => [p.id, p.workspaceId]));
      return d.environments.flatMap((e) => {
        const workspaceId = byProject.get(e.projectId);
        if (!workspaceId) {
          console.warn(
            `  ! skipped environment ${e.id}: its project ${e.projectId} is not in this data directory.`
          );
          return [];
        }
        return [toRow("environments", e, workspaceId)];
      });
    }
    // The registry is open (src/lib/db/pg/registry.ts), so `PgCollection` is no
    // longer a closed union; this script still imports exactly `ORDER` above.
    default:
      return [];
  }
}

/** The primary key PostgREST resolves a conflict on. Members are composite. */
const conflictTarget = (collection: PgCollection): string =>
  collection === "members" ? "workspace_id,id" : "id";

async function importCollection(collection: PgCollection): Promise<number> {
  const rows = rowsFor(collection);
  const table = tableOf(collection);
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await client
      .from(table)
      .upsert(slice, { onConflict: conflictTarget(collection), ignoreDuplicates: true });
    if (error)
      throw new Error(
        `Importing ${table} failed at row ${i}: ${error.message}. ` +
          `Fix: apply supabase/migrations/0001_system_of_record.sql to the project named by ` +
          `NEXT_PUBLIC_SUPABASE_URL, then run this again — it is idempotent and will resume.`
      );
  }
  console.log(`  ${table.padEnd(14)} ${String(rows.length).padStart(6)} row(s) offered`);
  return rows.length;
}

/**
 * The settings bag, minus invites (which have their own table). One row, the
 * reserved install-global id — `Database.settings` is install-wide, not
 * per-workspace, whatever the column is called.
 */
async function importSettings(): Promise<void> {
  const { invites: _invites, ...settings } = FileStore.db().settings;
  const { error } = await client
    .from("settings")
    .upsert(
      { workspace_id: INSTALL_SETTINGS_ID, data: settings, version: 1, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id", ignoreDuplicates: true }
    );
  if (error) throw new Error(`Importing settings failed: ${error.message}`);
  console.log(`  settings       ${String(1).padStart(6)} row(s) offered`);
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
  const { error } = await client
    .from("workspace_versions")
    .upsert(rows, { onConflict: "workspace_id", ignoreDuplicates: true });
  if (error) throw new Error(`Seeding workspace_versions failed: ${error.message}`);
}

/** What is actually in the database now, per table — the answer `--verify` prints. */
async function verify(): Promise<void> {
  const tables = [...ORDER.map(tableOf), "settings", "workspace_versions"];
  console.log("Rows in Postgres:");
  for (const table of tables) {
    const { count, error } = await client.from(table).select("*", { count: "exact", head: true });
    console.log(
      `  ${table.padEnd(20)} ${error ? `error: ${error.message}` : String(count ?? 0).padStart(6)}`
    );
  }
}

async function main(): Promise<void> {
  if (VERIFY) {
    await verify();
    return;
  }
  console.log(`Importing ${env().ZENITH_DATA} into Postgres (Phase 2 collections only).`);
  for (const collection of ORDER) await importCollection(collection);
  await importSettings();
  await seedFeed();
  console.log("\nDone. Re-run with --verify to see what landed.");
  await verify();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
