/**
 * Regenerate `supabase/migrations/0020_platform_core.sql` from the TypeScript
 * migrations of the platform control store (ADR-0002). That file is generated,
 * never hand-edited; `tests/controlplane/migrations.test.ts` fails when it
 * differs from what this script would write by even one byte.
 *
 *     npx tsx scripts/platform/emit-sql.ts           # rewrite the file
 *     npx tsx scripts/platform/emit-sql.ts --check   # exit 1 if it is out of date, write nothing
 *
 * Exit codes: 0 in sync / written, 1 --check found it out of date, 2 usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { EMITTED_RELATIVE_PATH, renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";

function main(): number {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(" ")}\nUsage: npx tsx scripts/platform/emit-sql.ts [--check]\n`);
    return 2;
  }
  const target = path.resolve(__dirname, "..", "..", EMITTED_RELATIVE_PATH);
  const next = renderSupabaseMigration();
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;

  if (args.includes("--check")) {
    if (current === next) {
      process.stdout.write(`${EMITTED_RELATIVE_PATH} is up to date.\n`);
      return 0;
    }
    process.stderr.write(`${EMITTED_RELATIVE_PATH} is out of date. Run: npx tsx scripts/platform/emit-sql.ts\n`);
    return 1;
  }
  if (current === next) {
    process.stdout.write(`${EMITTED_RELATIVE_PATH} already up to date.\n`);
    return 0;
  }
  fs.writeFileSync(target, next, "utf8");
  process.stdout.write(`Wrote ${EMITTED_RELATIVE_PATH} (${next.split("\n").length} lines).\n`);
  return 0;
}

process.exit(main());
