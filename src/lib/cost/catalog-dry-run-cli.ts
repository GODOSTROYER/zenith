import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import { dryRunCatalogRefresh } from "./catalog-dry-run";

// npx tsx src/lib/cost/catalog-dry-run-cli.ts <snapshot-directory> <candidate-version>
const [directory, version] = process.argv.slice(2);
if (!directory || !version || process.argv.length !== 4) {
  console.error("Usage: catalog-dry-run-cli.ts <snapshot-directory> <candidate-version>");
  process.exitCode = 64;
} else {
  try {
    const result = dryRunCatalogRefresh(loadDefaultCatalog(), directory, version);
    console.log(result.summary);
    console.log(`Dry run only. ${result.skipped.length} unmatched targets; no catalog adopted or written.`);
    if (result.report.flagged.some(f => !f.applied)) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Catalog dry run failed.");
    process.exitCode = 1;
  }
}
