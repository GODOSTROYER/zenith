/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * A webpack loader that compiles TypeScript with esbuild, used ONLY as a
 * fallback when Temporal's default loader (`swc-loader`) cannot run.
 *
 * Why it exists: `@swc/core` 1.16 refuses to load its native addon when its
 * cache directory's ACL grants write rights to anyone but SYSTEM /
 * Administrators, which is the normal state of a user profile on this
 * Windows development machine ("Failed to load native binding"). Linux (the
 * container image) does not hit this; there the default swc path is used.
 * Nothing in the workflow code depends on which compiler ran: only TypeScript
 * syntax is stripped, `target` is ES2020, and the bundle is otherwise the same.
 *
 * `esbuild` is a devDependency-of-a-devDependency (tsx / vite); this loader is
 * therefore a build/development aid, never required at production run time
 * (the production worker loads a prebuilt bundle).
 */
const esbuild = require("esbuild");

module.exports = function esbuildLoader(source) {
  const callback = this.async();
  esbuild
    .transform(source, {
      loader: "ts",
      target: "es2020",
      format: "esm",
      sourcemap: true,
      sourcefile: this.resourcePath,
    })
    .then(
      (result) => callback(null, result.code, result.map ? JSON.parse(result.map) : undefined),
      (err) => callback(err)
    );
};
