/**
 * Take an encrypted backup of this install and write it to the configured
 * target.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/backup.ts
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/backup.ts --include-artifacts
 *
 * Needs `ZENITH_BACKUP_KEY` and a `ZENITH_BACKUP_TARGET` other than `none`.
 * Prints the manifest as JSON on success — that JSON is the evidence a backup
 * happened, and its `digest` is the SHA-256 of the sealed object as stored.
 *
 * TODO(ceiling): nothing schedules this. It is a command an operator or a cron
 * entry runs; RUNBOOK-DEPLOY proposes every six hours plus one before every
 * activation, and neither is implemented as a job.
 */
import { closeAuthority, openAuthority } from "@/lib/hosted/authority";
import { createBackup } from "@/lib/hosted/backup";
import { fail, finish } from "./_cli";

async function main(): Promise<void> {
  const includeArtifacts = process.argv.includes("--include-artifacts");
  openAuthority();
  try {
    const manifest = await createBackup({ includeArtifacts });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    finish(
      `Backup ${manifest.id} written: ${manifest.files.length} files, ${manifest.byteSize} bytes, sealed under key ${manifest.keyId}, revocation sequence ${manifest.revocationSeq}.`
    );
  } finally {
    closeAuthority();
  }
}

main().catch(fail);
