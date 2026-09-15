/**
 * Explicit alert-channel credential migration.
 *
 * This is intentionally not part of boot or a request. Run it first as a
 * rehearsal (`--dry-run`), then repeat with `--apply` during a maintenance
 * window after checking the report and backing up the store.
 *
 * Exit codes, because this is a thing an operator wires into a runbook:
 *
 *   0  nothing to do, or the apply succeeded
 *   1  one or more channels are **blocked** — a PostgreSQL install cannot move
 *      a legacy row in place, because the secret row and the channel row have
 *      no shared transaction. The per-channel report names every held channel;
 *      the runbook is docs/hosted/PROVIDERS.md → "Alert channel secrets".
 *   2  a rehearsal was printed and nothing was written (no flag was given)
 *   3  the apply itself failed; the store is unchanged for the failing channel
 *      and the journal says which one.
 */
import { db, flushPendingAsync, isPostgres, save } from "@/lib/db/store";
import { primeProcessSnapshot } from "@/lib/db/postgres-store";
import {
  migrateLegacyChannelSecretsAsync,
  planAlertSecretMigration,
  POSTGRES_MIGRATION_BLOCKED,
  type StoredAlertChannel,
} from "@/lib/alerts/channels";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;

async function main(): Promise<void> {
  // `db()` is synchronous for the legacy Store contract. Prime the process
  // snapshot first or a Postgres-backed invocation would inspect an empty
  // placeholder and falsely report zero migration candidates.
  if (isPostgres()) await primeProcessSnapshot();
  const channels = ((db().settings as { alertChannels?: StoredAlertChannel[] }).alertChannels ?? []);
  const plan = planAlertSecretMigration(channels);
  const blocked = plan.filter((entry) => entry.status === "blocked");
  const candidates = plan.filter((entry) => entry.status === "candidate");
  const counts = {
    inspected: channels.length,
    candidates: candidates.length,
    blocked: blocked.length,
    unchanged: plan.filter((entry) => entry.status === "unchanged").length,
  };

  // A blocked row is reported the same way whether this is a rehearsal or an
  // apply: the operator's next step is identical, and the exit code has to say
  // "this install is not migrated" either way. Reported *before* attempting
  // anything, so the refusal is never mistaken for a partial run.
  if (blocked.length > 0) {
    console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "apply", ...counts, channels: plan }, null, 2));
    console.error(
      `${blocked.length} alert channel(s) ${POSTGRES_MIGRATION_BLOCKED}. Nothing was written. ` +
        `Each one is named above; until the coordinated migration is applied their delivery stays blocked and their ` +
        `credentials stay in the settings row (and in every backup taken since). ` +
        `Runbook: docs/hosted/PROVIDERS.md → "Alert channel secrets".`
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", ...counts, channels: plan }, null, 2));
    if (!process.argv.includes("--dry-run")) {
      console.error("No changes made. Re-run with --apply after reviewing this report.");
      process.exitCode = 2;
    }
    return;
  }

  try {
    const report = await migrateLegacyChannelSecretsAsync(channels);
    save();
    await flushPendingAsync();
    console.log(JSON.stringify({ mode: "apply", ...report }, null, 2));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `Nothing was left half-written: the failing channel was rolled back and its entry stays in ` +
        `settings.pendingAlertSecretMigrations, so re-running this command retries exactly that channel. ` +
        `Runbook: docs/hosted/PROVIDERS.md → "Alert channel secrets".`
    );
    process.exitCode = 3;
  }
}

void main();
