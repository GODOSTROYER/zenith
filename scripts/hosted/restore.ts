/**
 * Restore a backup into a clean data directory and reconcile revocations.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/restore.ts <bundle> <into>
 *
 * `<bundle>` is either a path to a `.zbk` file on this machine or a key in the
 * configured backup target (`backups/<id>.zbk`). `<into>` must not exist, or
 * must be empty — a restore never writes over a data directory, and there is
 * no flag that makes it.
 *
 * What it does, in the order RUNBOOK-DEPLOY §6 asks for: verify the bundle
 * before touching the disk, write it, read the off-host revocation ledger and
 * re-apply everything recorded after the snapshot, close every session, and
 * write `RESTORE-REPORT.json` with the counts to check. It reopens nothing:
 * apps whose access could not be vouched for stay `recovering`, and
 * `scripts/hosted/reopen.ts` is the deliberate next step.
 *
 * This script does **not** open this process's control authority — the restore
 * works on its own connection to the restored file, so running it on a machine
 * that also serves an install cannot disturb that install.
 */
import fs from "node:fs";
import path from "node:path";
import { restoreBackup, RESTORE_REPORT_FILE } from "@/lib/hosted/backup";
import { fail, finish } from "./_cli";

async function main(): Promise<void> {
  const [source, into] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!source || !into) {
    process.stderr.write(
      "Usage: tsx scripts/hosted/restore.ts <bundle.zbk | backups/<id>.zbk> <empty-directory>\n" +
        "  <bundle>  a file on this machine, or a key in the configured backup target\n" +
        "  <into>    the data directory to create; it must not exist or must be empty\n"
    );
    process.exit(2);
  }

  const asFile = path.resolve(source);
  const bundle = fs.existsSync(asFile) && fs.statSync(asFile).isFile() ? fs.readFileSync(asFile) : source;
  if (typeof bundle === "string")
    finish(`No file at ${asFile}; reading "${source}" from the configured backup target.`);

  const report = await restoreBackup({ bundle, into });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    `Restored backup ${report.backup.id} (taken ${report.backup.createdAt}) into ${report.into}.`,
    `Apps ${report.counts.apps}; grants active ${report.counts.grantsByState.active}, held ${report.counts.grantsByState.needs_reapproval}, revoked ${report.counts.grantsByState.revoked}.`,
    `Sessions terminated: ${report.sessionsTerminated}.`,
    report.reconciliation.detail,
    report.counts.artifacts.missing.length > 0
      ? `WARNING: ${report.counts.artifacts.missing.length} referenced artifact(s) are not present. Restore the artifact store before reopening those apps.`
      : `All ${report.counts.artifacts.referenced} referenced artifact(s) are present.`,
    `Full report: ${path.join(report.into, RESTORE_REPORT_FILE)}`,
    report.reconciliation.evidenceComplete
      ? "Next: start the control service with ZENITH_DATA=<this directory>, then reopen each app with scripts/hosted/reopen.ts."
      : "Next: re-approve the held grants, then reopen each app with scripts/hosted/reopen.ts --acknowledge-reapproval.",
  ];
  finish(`\n${lines.join("\n")}\n`);
}

main().catch(fail);
