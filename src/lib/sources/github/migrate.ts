/** Explicit operator entrypoint for the additive source schema; no runtime DDL. */
import { platformDb } from "@/lib/controlplane/db/open";
import { installGithubSourceSchema } from "./schema";

async function main(): Promise<void> {
  const db = await platformDb();
  try {
    await installGithubSourceSchema(db);
    process.stdout.write("GitHub source schema applied.\n");
  } finally { await db.close(); }
}
void main().catch(() => {
  process.stderr.write("GitHub source schema setup failed; check platform database configuration.\n");
  process.exitCode = 1;
});
