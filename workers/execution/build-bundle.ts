/**
 * Build-time step: bundle the workflow definitions into one file so the
 * production worker does not run webpack at start-up.
 *
 *   npx tsx workers/execution/build-bundle.ts [outFile]     (default dist/execution/workflow-bundle.js)
 *
 * Point ZENITH_WORKER_WORKFLOW_BUNDLE at the output. Fails (non-zero exit) if a
 * definition imports something the workflow sandbox cannot run.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleDefinitions } from "./bundle";
import { defaultWorkflowsPath } from "./run";

async function main(): Promise<void> {
  const out = path.resolve(process.argv[2] ?? "dist/execution/workflow-bundle.js");
  const { code, bundler, fallbackReason } = await bundleDefinitions(defaultWorkflowsPath());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, code, "utf8");
  if (fallbackReason) process.stderr.write(`swc could not compile the workflows (${fallbackReason}); used the esbuild fallback\n`);
  process.stdout.write(`workflow bundle written: ${out} (${Math.round(code.length / 1024)} KiB, compiled with ${bundler})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`workflow bundle failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
