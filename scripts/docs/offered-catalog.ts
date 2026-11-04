/**
 * Generate and drift-check the versioned offered capability catalog
 * (`src/lib/offered-catalog/offered-catalog.json`, PROD-LIFE-02).
 *
 *     npx tsx scripts/docs/offered-catalog.ts            # rewrite the file
 *     npx tsx scripts/docs/offered-catalog.ts --check    # exit 1 if the committed file differs from the code
 *     npx tsx scripts/docs/offered-catalog.ts --strict   # --check, and exit 1 on any driver inconsistency
 *
 * The catalog is derived from the compiler vocabulary (`NATIVE_TYPE_TABLE`)
 * and the real resource drivers' declarations, loaded exactly the way the
 * capability matrix generator loads them (`collectMatrix`). `--check` fails
 * when a driver gains, loses or re-evidences an operation, a kind is added to
 * the compiler, or the committed file is hand-edited: the file must equal the
 * derivation byte for byte. Output is deterministic (no clock, sorted).
 *
 * Exit codes: 0 ok / written, 1 drift (or `--strict` problems), 2 usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { CAPABILITIES, type CapabilityDef } from "@/lib/capabilities/catalog";
import { deriveOfferedCatalog, type CapabilityFact } from "@/lib/offered-catalog/derive";
import { OfferedCatalogSchema, checkCatalogInvariants, type OfferedCatalog } from "@/lib/offered-catalog/schema";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import { collectMatrix, type MatrixData } from "./capability-matrix";

export const OFFERED_CATALOG_RELATIVE_PATH = "src/lib/offered-catalog/offered-catalog.json";

const repoRootDefault = (): string => path.resolve(__dirname, "..", "..");

/** Derive the catalog from the live code. Throws on a catalog or schema inconsistency. */
export async function deriveCurrentCatalog(options: { repoRoot?: string } = {}): Promise<{ catalog: OfferedCatalog; matrix: MatrixData }> {
  const matrix = await collectMatrix({ repoRoot: options.repoRoot ?? repoRootDefault() });
  const capabilities: Record<string, CapabilityFact> = {};
  for (const [name, def] of Object.entries(CAPABILITIES as Record<string, CapabilityDef>)) {
    capabilities[name] = { name, title: def.title, mutates: def.mutates, risk: def.risk, defaultAutonomy: def.defaultAutonomy };
  }
  const catalog = deriveOfferedCatalog({ nativeTypes: NATIVE_TYPE_TABLE, drivers: matrix.rows, capabilities });
  const parsed = OfferedCatalogSchema.parse(catalog);
  const problems = checkCatalogInvariants(parsed);
  if (problems.length > 0) throw new Error(`The derived catalog is inconsistent: ${problems.join("; ")}`);
  return { catalog: parsed, matrix };
}

export const renderCatalog = (catalog: OfferedCatalog): string => `${JSON.stringify(catalog, null, 1)}\n`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--check" && a !== "--strict");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown argument(s): ${unknown.join(" ")}\nUsage: npx tsx scripts/docs/offered-catalog.ts [--check | --strict]\n`);
    return 2;
  }
  const repoRoot = repoRootDefault();
  const target = path.join(repoRoot, OFFERED_CATALOG_RELATIVE_PATH);
  const { catalog, matrix } = await deriveCurrentCatalog({ repoRoot });
  const text = renderCatalog(catalog);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : undefined;
  for (const p of matrix.problems) process.stderr.write(`problem: ${p.driver} ${p.message}\n`);

  if (args.includes("--check") || args.includes("--strict")) {
    if (current !== text) {
      process.stderr.write(`${OFFERED_CATALOG_RELATIVE_PATH} is out of date with the compiler and drivers. Run: npx tsx scripts/docs/offered-catalog.ts\n`);
      return 1;
    }
    if (args.includes("--strict") && matrix.problems.length > 0) return 1;
    process.stdout.write(`${OFFERED_CATALOG_RELATIVE_PATH} is up to date (${catalog.catalogVersion}).\n`);
    return 0;
  }
  if (current === text) {
    process.stdout.write(`${OFFERED_CATALOG_RELATIVE_PATH} already up to date (${catalog.catalogVersion}).\n`);
    return 0;
  }
  fs.writeFileSync(target, text, "utf8");
  process.stdout.write(`Wrote ${OFFERED_CATALOG_RELATIVE_PATH} (${catalog.entries.length} entries, ${catalog.catalogVersion}).\n`);
  return 0;
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string => path.resolve(p).replace(/\.(ts|js|cjs|mjs)$/, "").toLowerCase();
  return normalize(entry) === normalize(__filename);
};

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    }
  );
}
