/**
 * The process that actually compiles a submission.
 *
 * Plain ESM JavaScript so `node` can run it directly: on the control host it is
 * spawned as a child with an empty environment, in a container it is the image
 * entrypoint, in an E2B sandbox it is uploaded and run there. Same file, same
 * behaviour, wherever the boundary is drawn.
 *
 *   node recipe-worker.mjs <job.json> <result.json>
 *
 * It reads the job, resolves the pinned toolchain from the platform's own
 * `node_modules`, runs `build()` with `recipeInlineConfig`, checks that every
 * module the bundle drew from came from the source root or that toolchain, and
 * writes a small JSON result. Exit 0 when the build succeeded, 1 otherwise.
 *
 * It never loads a submitted `vite.config`, never runs a submitted script,
 * never installs anything, and reads no environment variable of its own.
 *
 * Workstream W2 (hosted R3).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { foreignModules, recipeAliases, recipeInlineConfig } from "./recipe-config.mjs";

const [jobFile, resultFile] = process.argv.slice(2);

function finish(result, code) {
  const body = JSON.stringify(result);
  if (resultFile) {
    try {
      fs.writeFileSync(resultFile, body);
    } catch (err) {
      process.stderr.write(`recipe: could not write the result file: ${err && err.message}\n`);
    }
  } else {
    process.stdout.write(`${body}\n`);
  }
  process.exit(code);
}

if (!jobFile || !resultFile) {
  process.stderr.write("recipe: usage: node recipe-worker.mjs <job.json> <result.json>\n");
  process.exit(1);
}

let job;
try {
  job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
} catch (err) {
  finish({ ok: false, error: `The build job file could not be read: ${err && err.message}` }, 1);
}

try {
  const platform = job.platformRoot;
  const resolver = createRequire(path.join(platform, "noop.js"));

  const viteUrl = pathToFileURL(resolver.resolve("vite")).href;
  const { build } = await import(viteUrl);
  const pluginUrl = pathToFileURL(resolver.resolve("@vitejs/plugin-react")).href;
  const pluginModule = await import(pluginUrl);
  const react = typeof pluginModule.default === "function" ? pluginModule.default : pluginModule;
  if (typeof react !== "function") throw new Error("@vitejs/plugin-react did not export a plugin factory.");

  const allow = [path.join(platform, "node_modules")];
  const config = recipeInlineConfig({
    root: job.root,
    outDir: job.outDir,
    cacheDir: job.cacheDir,
    reactPlugin: react(),
    aliases: recipeAliases((specifier) => resolver.resolve(specifier)),
    allow,
  });

  const output = await build(config);
  const bundles = Array.isArray(output) ? output : [output];
  const moduleIds = new Set();
  for (const bundle of bundles) {
    for (const chunk of bundle && bundle.output ? bundle.output : []) {
      if (chunk.type !== "chunk") continue;
      for (const id of Object.keys(chunk.modules || {})) moduleIds.add(id);
    }
  }

  // `server.fs.allow` only guards a dev server, so the claim that the build read
  // nothing outside the source root is checked here, against what was bundled.
  const foreign = foreignModules([...moduleIds], { root: job.root, allow });
  if (foreign.length > 0)
    finish(
      {
        ok: false,
        modules: moduleIds.size,
        foreign,
        error: `The build pulled ${foreign.length} module(s) from outside the source root and the platform toolchain. The artifact was discarded.`,
      },
      1
    );

  if (!fs.existsSync(path.join(job.outDir, "index.html")))
    finish(
      { ok: false, modules: moduleIds.size, error: "The build finished without producing index.html in the output." },
      1
    );

  finish({ ok: true, outDir: job.outDir, modules: moduleIds.size, foreign: [] }, 0);
} catch (err) {
  finish({ ok: false, error: err && err.message ? String(err.message) : String(err) }, 1);
}
