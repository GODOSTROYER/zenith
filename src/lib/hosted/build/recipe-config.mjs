/**
 * The one definition of the Vite configuration the platform builds with.
 *
 * Plain ESM JavaScript on purpose: the build actually happens inside
 * `recipe-worker.mjs`, which is spawned by `node` and cannot import TypeScript,
 * while `recipe.ts` needs the same object to describe and test the recipe. One
 * file, imported by both, so the config a test inspects is the config that runs.
 *
 * The shape is fixed and never merged with anything a builder submitted:
 * `configFile: false` and `envFile: false` mean Vite is forbidden from reading
 * a `vite.config.*` or a `.env` out of the source root, and `plugins` holds
 * exactly the platform's React plugin.
 *
 * Workstream W2 (hosted R3).
 */
import path from "node:path";

/**
 * Bare specifiers the recipe pins to the platform's own copies.
 *
 * ponytail: an exact list, not a subpath pattern. A submission that imports
 * something else from React (`react-dom/server`, `react/compiler-runtime`) gets
 * a plain "failed to resolve import" from Vite rather than a silent fallback —
 * honest, but narrow. Upgrade: a capture-group alias, once one of these is a
 * shape a real submission actually needs.
 */
export const RECIPE_ALIAS_SPECIFIERS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

/**
 * Resolve every pinned specifier to an absolute file in the platform's
 * `node_modules`, so a submission cannot supply its own React and nothing has
 * to be installed from the source tree.
 *
 * @param {(specifier: string) => string} resolve a `require.resolve` bound to the platform root
 * @returns {{ find: RegExp, replacement: string }[]} Vite `resolve.alias` entries
 */
export function recipeAliases(resolve) {
  return RECIPE_ALIAS_SPECIFIERS.map((specifier) => ({
    find: new RegExp(`^${specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}$`),
    replacement: resolve(specifier),
  }));
}

/**
 * The recipe's `InlineConfig`.
 *
 * @param {object} input
 * @param {string} input.root materialized source root; the only tree the build may read from
 * @param {string} input.outDir where the compiled site is written
 * @param {string} input.cacheDir Vite's scratch directory, kept outside the source and the output
 * @param {unknown} input.reactPlugin the instantiated `@vitejs/plugin-react`
 * @param {{ find: RegExp, replacement: string }[]} input.aliases from `recipeAliases`
 * @param {string[]} input.allow absolute prefixes the build is allowed to read besides `root`
 */
export function recipeInlineConfig({ root, outDir, cacheDir, reactPlugin, aliases, allow }) {
  return {
    root,
    // No submitted configuration is ever loaded or merged.
    configFile: false,
    envFile: false,
    logLevel: "info",
    cacheDir,
    plugins: [reactPlugin],
    define: {},
    resolve: { alias: aliases, dedupe: ["react", "react-dom"] },
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      target: "es2022",
      rollupOptions: { input: path.join(root, "index.html") },
    },
    // `server` is unused: the recipe only ever calls `build()`. `fs.allow` is a
    // dev-server control and does NOT gate a build, which is why the worker
    // checks the module graph after the fact instead of trusting it.
    server: { fs: { allow: [root, ...allow], strict: true } },
  };
}

/** Normalise a rollup module id for comparison: drop the virtual marker and any query. */
function normaliseModuleId(id) {
  let value = id.startsWith("\u0000") ? id.slice(1) : id;
  const query = value.indexOf("?");
  if (query !== -1) value = value.slice(0, query);
  return value.split("\\").join("/");
}

const looksAbsolute = (value) => value.startsWith("/") || /^[A-Za-z]:\//.test(value);

/**
 * Every module that ended up in the bundle from outside `root` and outside the
 * allowed platform directories.
 *
 * This is the check that makes the "the build only reads the source root"
 * claim testable. Virtual modules (Vite's own polyfill injections, rollup
 * helpers) are not filesystem reads and are ignored.
 *
 * @param {string[]} moduleIds
 * @param {{ root: string, allow: string[] }} bounds
 * @returns {string[]} offending module ids, empty when the build stayed inside
 */
export function foreignModules(moduleIds, bounds) {
  const insensitive = process.platform === "win32";
  const fold = (value) => (insensitive ? value.toLowerCase() : value);
  const prefixes = [bounds.root, ...bounds.allow].map((p) => fold(p.split("\\").join("/").replace(/\/+$/, "")) + "/");
  const out = [];
  for (const id of moduleIds) {
    const normalised = normaliseModuleId(id);
    if (!looksAbsolute(normalised)) continue;
    // Resolve `..` before comparing: `<root>/../elsewhere` is not inside root,
    // however much of root its text repeats.
    const folded = fold(path.posix.normalize(normalised));
    if (prefixes.some((prefix) => folded.startsWith(prefix))) continue;
    out.push(normalised);
  }
  return out;
}
