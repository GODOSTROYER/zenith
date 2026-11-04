/**
 * Print the sensitive persistence inventory (PROD-OPS-06) for operators and reviewers.
 *
 *   npx tsx scripts/sensitive-inventory.ts [--json] [--only sealed|guarded|unreviewed]
 *
 * Markdown by default: one table of every database table with its classification, protection and retention,
 * the sensitive-looking columns beneath it, then the non-table sinks (files, artifacts, logs, telemetry, workflow
 * history, model-visible results, env files). `--only` filters columns by how they are protected. Pure and
 * offline: it reads the in-repo inventory (src/lib/sensitivedata/inventory.ts), not a database.
 * Exit 0, or 2 on a usage error.
 */
import { pathToFileURL } from "node:url";
import { OTHER_SINKS, TABLES, type Protection } from "@/lib/sensitivedata/inventory";

const describe = (p: Protection): string => {
  switch (p.kind) {
    case "sealed": return `sealed (${p.scheme}, ${p.purpose})`;
    case "write-guarded": return `write-guarded: ${p.guard}`;
    case "digest-only": return "digest only";
    case "tenant-content": return `tenant content: ${p.note}`;
    case "host-protected": return `host protected: ${p.control}`;
    case "none-needed": return `none needed: ${p.reason}`;
  }
};

export function inventoryMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): number {
  let json = false;
  let only: "sealed" | "guarded" | "unreviewed" | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && !json) json = true;
    else if (args[i] === "--only" && only === undefined && ["sealed", "guarded", "unreviewed"].includes(args[i + 1] ?? "")) only = args[++i] as "sealed" | "guarded" | "unreviewed";
    else { error("Usage: npx tsx scripts/sensitive-inventory.ts [--json] [--only sealed|guarded|unreviewed]"); return 2; }
  }
  const keep = (p: Protection, assurance: string): boolean => only === undefined || (only === "sealed" && p.kind === "sealed") || (only === "guarded" && p.kind === "write-guarded") || (only === "unreviewed" && assurance === "unreviewed");
  if (json) {
    output(JSON.stringify({ tables: TABLES, sinks: OTHER_SINKS }));
    return 0;
  }
  output("# Sensitive persistence inventory");
  output("");
  output("| Table | Class | Retention | Owner |");
  output("| --- | --- | --- | --- |");
  for (const [name, t] of Object.entries(TABLES)) output(`| ${name} | ${t.classification} | ${t.retention.policy}: ${t.retention.note} | ${t.owner} |`);
  output("");
  output("## Columns");
  output("| Column | Protection | Assurance |");
  output("| --- | --- | --- |");
  for (const [name, t] of Object.entries(TABLES))
    for (const [column, c] of Object.entries(t.columns))
      if (keep(c.protection, c.assurance)) output(`| ${name}.${column} | ${describe(c.protection)}${c.note ? ` (${c.note})` : ""} | ${c.assurance} |`);
  output("");
  output("## Other sinks");
  output("| Sink | Where | Class | Protection | Retention | Assurance |");
  output("| --- | --- | --- | --- | --- | --- |");
  for (const s of OTHER_SINKS) if (keep(s.protection, s.assurance)) output(`| ${s.id} | ${s.where} | ${s.classification} | ${describe(s.protection)} | ${s.retention.policy}: ${s.retention.note} | ${s.assurance} |`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = inventoryMain(process.argv.slice(2));
}
