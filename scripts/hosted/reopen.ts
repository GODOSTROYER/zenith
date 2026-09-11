/**
 * Reopen one app after a restore, once its checks pass.
 *
 * Run:
 *   ORRERY_DATA=<restored directory> \
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/reopen.ts <appId> \
 *     [--acknowledge-reapproval] [--operator=<name>]
 *
 * Run it against the restored directory, because what it verifies has to be
 * what will actually be served: the control database's `quick_check`, the
 * app's own database `quick_check`, its schema version, and the active
 * release's artifact re-hashed from its stored bytes.
 *
 * `--acknowledge-reapproval` states that an operator has seen the grants that
 * the restore held. It does not re-approve them: those people still cannot
 * open the app until an owner grants each of them again.
 */
import { closeAuthority, openAuthority } from "@/lib/hosted/authority";
import { reopenApp } from "@/lib/hosted/backup";
import { closeAllAppData } from "@/lib/hosted/data";
import { fail, finish } from "./_cli";

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const option = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

async function main(): Promise<void> {
  const appId = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!appId) {
    process.stderr.write(
      "Usage: tsx scripts/hosted/reopen.ts <appId> [--acknowledge-reapproval] [--operator=<name>]\n" +
        "  Run with ORRERY_DATA pointing at the restored data directory.\n"
    );
    process.exit(2);
  }

  openAuthority();
  try {
    const result = await reopenApp(appId, {
      operator: option("operator") ?? process.env.USER ?? process.env.USERNAME ?? "unnamed operator",
      acknowledgeReapproval: flag("acknowledge-reapproval"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    finish(`\n${result.detail}\n${result.checks.map((check) => `  ${check.ok ? "ok  " : "FAIL"} ${check.id}: ${check.detail}`).join("\n")}\n`);
  } finally {
    closeAllAppData();
    closeAuthority();
  }
}

main().catch(fail);
