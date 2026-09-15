/**
 * Explicit alert-channel credential migration.
 *
 * This is intentionally not part of boot or a request. Run it first as a
 * rehearsal (`--dry-run`), then repeat with `--apply` during a maintenance
 * window after checking the report and backing up the store.
 */
import { db, flushPendingAsync, save } from "@/lib/db/store";
import {
  migrateLegacyChannelSecretsAsync,
  type StoredAlertChannel,
} from "@/lib/alerts/channels";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;
const channels = ((db().settings as { alertChannels?: StoredAlertChannel[] }).alertChannels ?? []);

const legacy = channels.filter((channel) =>
  channel.kind !== "email" &&
  (!channel.targetSecretRef || (channel.kind === "webhook" && channel.secret !== undefined))
);

async function main(): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", inspected: channels.length, candidates: legacy.map((c) => c.id) }, null, 2));
    if (!process.argv.includes("--dry-run")) {
      console.error("No changes made. Re-run with --apply after reviewing this report.");
      process.exitCode = 2;
    }
    return;
  }
  const report = await migrateLegacyChannelSecretsAsync(channels);
  save();
  await flushPendingAsync();
  console.log(JSON.stringify({ mode: "apply", ...report }, null, 2));
}

void main();
