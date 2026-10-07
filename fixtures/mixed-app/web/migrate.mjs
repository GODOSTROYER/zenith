/**
 * Release hook: applies db/schema.sql (idempotent, `create ... if not exists`) to the database named by DATABASE_URL_FILE.
 * Runs once per release as a one-off task of the web service (see zenith.app.json `release.migrate`).
 */
import { readFileSync } from "node:fs";

const urlFile = process.env.DATABASE_URL_FILE;
if (!urlFile) { console.error(JSON.stringify({ event: "migrate_failed", reason: "DATABASE_URL_FILE is not set" })); process.exit(2); }
const { default: postgres } = await import("postgres");
const sql = postgres(readFileSync(urlFile, "utf8").trim(), { ssl: "require", max: 1, connect_timeout: 15 });
try {
  await sql.unsafe(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  console.log(JSON.stringify({ event: "migrated" }));
} catch (error) {
  console.error(JSON.stringify({ event: "migrate_failed", reason: error instanceof Error ? error.name : "error" }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
