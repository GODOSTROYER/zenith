/**
 * The platform recipe: the only build workflow that ever runs.
 *
 * `RECIPE_V1` pins the toolchain; `recipeConfig` produces the Vite
 * `InlineConfig` (through `recipe-config.mjs`, which the worker imports too, so
 * there is one definition rather than two that can drift); `recipeJob` produces
 * the serialisable job a runner hands to `recipe-worker.mjs` in another process
 * or another machine.
 *
 * Nothing a builder submitted is executed, loaded as configuration or installed
 * from. The recipe compiles the source with esbuild/rollup transforms and the
 * platform's own React plugin, and that is all.
 *
 * Workstream W2 (hosted R3).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { InlineConfig } from "vite";
import { RECIPE_V1, type RecipeSpec } from "@/lib/hosted/contracts";
import { foreignModules, recipeAliases, recipeInlineConfig, RECIPE_ALIAS_SPECIFIERS } from "./recipe-config.mjs";

export { RECIPE_V1, RECIPE_ALIAS_SPECIFIERS, foreignModules };

/** The packages the recipe needs on the machine that runs it. */
export const RECIPE_PACKAGES = ["vite", "@vitejs/plugin-react", "react", "react-dom"] as const;

/** `npm install` line that reproduces the pinned toolchain in a sandbox or image. */
export const RECIPE_INSTALL_ARGS = [
  "install",
  "--no-audit",
  "--no-fund",
  `vite@${RECIPE_V1.vite}`,
  `@vitejs/plugin-react@${RECIPE_V1.pluginReact}`,
  `react@${RECIPE_V1.react}`,
  `react-dom@${RECIPE_V1.react}`,
] as const;

/** Where the worker lives inside the platform tree, relative to the platform root. */
export const RECIPE_WORKER_RELATIVE = path.posix.join("src", "lib", "hosted", "build", "recipe-worker.mjs");

/**
 * The directory that owns the `node_modules` holding the pinned toolchain.
 *
 * ponytail: discovered by walking up from `process.cwd()`, because that is the
 * one anchor that behaves the same under `next`, `vitest`, `tsx` and the
 * container image. A deployment that starts the server from somewhere else must
 * pass `platformRoot` explicitly to the runner; `availability()` says so rather
 * than guessing. Upgrade: read it from a build-time constant the integrator
 * stamps into the image.
 */
export function platformRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "node_modules", "vite", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

/** Absolute path of the worker script for a platform root. */
export const recipeWorkerPath = (root: string = platformRoot()): string =>
  path.join(root, ...RECIPE_WORKER_RELATIVE.split("/"));

/** The platform directories a build may read besides the source root. */
export const recipeAllowedReads = (root: string = platformRoot()): string[] => [path.join(root, "node_modules")];

/** Which of the recipe's packages this machine cannot resolve, and where it looked. */
export function missingRecipePackages(root: string = platformRoot()): string[] {
  const resolver = createRequire(path.join(root, "noop.js"));
  const missing: string[] = [];
  for (const name of RECIPE_PACKAGES) {
    try {
      resolver.resolve(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

/** Everything a runner has to move to the machine that will build. */
export interface RecipeJob {
  /** materialized source root */
  root: string;
  /** where the compiled site is written */
  outDir: string;
  /** Vite scratch space, outside both root and outDir */
  cacheDir: string;
  /** the directory whose node_modules holds the pinned toolchain */
  platformRoot: string;
  recipe: RecipeSpec;
}

/** What `recipe-worker.mjs` writes back. Deliberately small and free of host detail. */
export interface RecipeWorkerResult {
  ok: boolean;
  outDir?: string;
  /** number of modules the bundle drew from */
  modules?: number;
  /** modules that came from outside the source root and the platform toolchain */
  foreign?: string[];
  error?: string;
}

/** The serialisable job for a runner to write beside the source. */
export function recipeJob(input: {
  root: string;
  outDir: string;
  cacheDir: string;
  platformRoot?: string;
  recipe?: RecipeSpec;
}): RecipeJob {
  return {
    root: input.root,
    outDir: input.outDir,
    cacheDir: input.cacheDir,
    platformRoot: input.platformRoot ?? platformRoot(),
    recipe: input.recipe ?? RECIPE_V1,
  };
}

/**
 * The exact `InlineConfig` the recipe builds with.
 *
 * Loading `@vitejs/plugin-react` happens here rather than at module scope, so
 * importing this module (from a registry, a status route or a test) does not
 * drag the build toolchain in with it.
 */
export function recipeConfig(root: string, outDir: string, opts: { cacheDir?: string; platformRoot?: string } = {}): InlineConfig {
  const platform = opts.platformRoot ?? platformRoot();
  const resolver = createRequire(path.join(platform, "noop.js"));
  const loaded: unknown = resolver("@vitejs/plugin-react");
  const react =
    typeof loaded === "function"
      ? (loaded as () => unknown)
      : ((loaded as { default?: unknown } | null)?.default as (() => unknown) | undefined);
  if (typeof react !== "function")
    throw new Error(
      `@vitejs/plugin-react in ${platform} does not export a plugin factory. Fix: reinstall the pinned toolchain (${RECIPE_V1.pluginReact}).`
    );
  return recipeInlineConfig({
    root,
    outDir,
    cacheDir: opts.cacheDir ?? path.join(path.dirname(outDir), `${path.basename(outDir)}-vite-cache`),
    reactPlugin: react(),
    aliases: recipeAliases((specifier: string) => resolver.resolve(specifier)),
    allow: recipeAllowedReads(platform),
  }) as InlineConfig;
}
