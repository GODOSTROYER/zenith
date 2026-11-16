/**
 * Bundling the workflow definitions for the Temporal worker.
 *
 * The definitions use relative imports only (no `@/` alias), so Temporal's own
 * bundler needs no extra configuration; `tests/workflows/sandbox.test.ts`
 * enforces that and bundles them.
 *
 * Compiler: Temporal's bundler compiles TypeScript with `swc-loader`. On a host
 * where the swc native addon cannot load, `bundleDefinitions` retries with an
 * esbuild loader (esbuild-loader.cjs) and reports which compiler produced the
 * bundle. `prefer` pins one for reproducibility.
 */

import path from "node:path";
import { bundleWorkflowCode, type BundleOptions, type Logger } from "@temporalio/worker";

type Configuration = Parameters<NonNullable<BundleOptions["webpackConfigHook"]>>[0];

export type BundlerKind = "swc" | "esbuild";

export interface DefinitionsBundle {
  code: string;
  sourceMap: string;
  /** which TypeScript compiler produced it */
  bundler: BundlerKind;
  /** set when esbuild was used because swc failed: the first line swc reported */
  fallbackReason?: string;
}

function loaderPath(): string {
  const here = typeof __dirname === "string" ? __dirname : process.cwd();
  return path.resolve(here, "esbuild-loader.cjs");
}

/** Swap the `.ts` rule's loader for the esbuild one. */
export function useEsbuildLoader(config: Configuration): Configuration {
  const rules = config.module?.rules ?? [];
  for (const rule of rules) {
    if (rule && typeof rule === "object" && rule.test instanceof RegExp && rule.test.test("x.ts") && rule.use && typeof rule.use === "object" && !Array.isArray(rule.use)) {
      rule.use = { loader: loaderPath() };
    }
  }
  return config;
}

/** A logger that keeps webpack's output instead of printing it (the first attempt may be expected to fail). */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const add = (_level: unknown, message: string): void => {
    lines.push(String(message));
  };
  const logger: Logger = {
    log: add,
    trace: (m) => add("trace", m),
    debug: (m) => add("debug", m),
    info: (m) => add("info", m),
    warn: (m) => add("warn", m),
    error: (m) => add("error", m),
  };
  return { logger, lines };
}

const reasonFrom = (lines: string[]): string =>
  (lines.join("\n").match(/Module build failed[^\n]*\n(?:Error: )?([^\n]+)/)?.[1] ?? "webpack reported errors").slice(0, 200);

/**
 * Bundle with swc; unless `prefer` pins a compiler, fall back to esbuild when
 * that fails. (Webpack's summary error does not say whether the compiler or the
 * code was at fault, so any failure is retried once; if esbuild fails too the
 * definitions are at fault and that error is thrown, naming the first as well.)
 */
export async function bundleDefinitions(workflowsPath: string, prefer?: BundlerKind): Promise<DefinitionsBundle> {
  let first: unknown;
  let fallbackReason: string | undefined;
  if (prefer !== "esbuild") {
    const attempt = prefer === "swc" ? undefined : capturingLogger();
    try {
      const { code, sourceMap } = await bundleWorkflowCode({ workflowsPath, ...(attempt ? { logger: attempt.logger } : {}) });
      return { code, sourceMap, bundler: "swc" };
    } catch (err) {
      if (prefer === "swc") throw err;
      first = err;
      fallbackReason = reasonFrom(attempt?.lines ?? []);
    }
  }
  try {
    const { code, sourceMap } = await bundleWorkflowCode({ workflowsPath, webpackConfigHook: useEsbuildLoader });
    return { code, sourceMap, bundler: "esbuild", ...(fallbackReason ? { fallbackReason } : {}) };
  } catch (err) {
    if (first === undefined) throw err;
    const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    throw new Error(`bundling the workflow definitions failed with swc (${detail(first)}) and with esbuild (${detail(err)})`);
  }
}
