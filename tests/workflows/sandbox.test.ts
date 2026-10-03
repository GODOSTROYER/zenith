/**
 * The workflow sandbox boundary and the worker's wiring, without a Temporal
 * server:
 *
 *  - `definitions/` is deterministic code: only `@temporalio/workflow` and
 *    relative workflow modules at run time, no `@/` alias, no Node, no I/O;
 *  - Temporal's bundler can bundle it (and rejects an alias or a Node import,
 *    proven with negative controls, so the positive result means something);
 *  - the stub activities, the fake and the policy table cover the same set of
 *    activities, and the stubs fail as `not_implemented`;
 *  - control-plane errors cross the activity boundary as typed failures.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { bundleWorkflowCode } from "@temporalio/worker";
import { createStubActivities as createActivities } from "@/lib/workflows/activities";
import { createFakeActivities } from "@/lib/workflows/activities/fake";
import { toTemporalFailure, withFailureMapping } from "@/lib/workflows/activities/failures";
import { ACTIVITY_OPTIONS } from "@/lib/workflows/definitions/policies";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { LeaseLostError } from "@/lib/controlplane/types";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { bundleDefinitions, capturingLogger, useEsbuildLoader } from "../../workers/execution/bundle";
import { DEFINITIONS_DIR, DEFINITIONS_ENTRY } from "./support";

const ROOT = path.resolve(__dirname, "../..");
const definitionFiles = readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith(".ts"));

/** Runtime (non-type) import specifiers of a module. */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(staticImport)) {
    if (m[2]) continue; // `import type` / `export type` is erased
    specifiers.push(m[4]!);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) specifiers.push(m[1]!);
  for (const m of source.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(m[1]!);
  return specifiers;
}

describe("definitions/ is sandbox-safe deterministic code", () => {
  it("has the files it should", () => {
    expect(definitionFiles.sort()).toEqual(["activities.ts", "capability.ts", "dayTwo.ts", "deploy.ts", "destroy-review.ts", "destroy.ts", "ecsReplicaRepair.ts", "failures.ts", "index.ts", "policies.ts", "reconcile.ts", "reconcileSweep.ts", "remediation.ts", "runtime.ts"]);
  });

  it.each(definitionFiles)("%s imports only @temporalio/workflow and relative workflow modules", (file) => {
    const source = readFileSync(path.join(DEFINITIONS_DIR, file), "utf8");
    for (const specifier of runtimeImports(source)) {
      const ok =
        specifier === "@temporalio/workflow" ||
        specifier.startsWith("./") ||
        specifier === "../types";
      expect(ok, `${file} imports "${specifier}"`).toBe(true);
    }
  });

  it.each(definitionFiles)("%s type-imports only from ../types (no activity code, no @/ alias)", (file) => {
    const source = readFileSync(path.join(DEFINITIONS_DIR, file), "utf8");
    const typeImports = [...source.matchAll(/import\s+type\s+[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const specifier of typeImports) expect(["../types", "@temporalio/workflow"].includes(specifier) || specifier.startsWith("./"), `${file} type-imports "${specifier}"`).toBe(true);
    expect(source).not.toMatch(/from\s*["']@\//);
  });

  it.each(definitionFiles)("%s uses no ambient I/O, environment or nondeterministic source", (file) => {
    // Strip comments so the doc text can talk about what is forbidden.
    const code = readFileSync(path.join(DEFINITIONS_DIR, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [/\bprocess\./, /\brequire\s*\(/, /\bfetch\s*\(/, /\bMath\.random\b/, /\bcrypto\b/, /\bsetInterval\b/, /\bnode:/, /\bBuffer\b/, /\bconsole\./]) {
      expect(code, `${file} matches ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("exports exactly the seven workflows from the entry point (helpers must not leak as workflow types)", async () => {
    const source = readFileSync(DEFINITIONS_ENTRY, "utf8");
    const exported = [...source.matchAll(/export\s*\{\s*(\w+)\s*\}\s*from/g)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["dayTwoOperationWorkflow", "infrastructureDeployWorkflow", "infrastructureDestroyWorkflow", "reconcileEnvironmentWorkflow", "reconcileSweepWorkflow", "remediationWorkflow", "teardownReviewWorkflow"]);
    expect(source).not.toMatch(/export\s+\*/);
  });
});

describe("Temporal's bundler and the @/ alias", () => {
  it("bundles the real definitions (which use relative imports)", async () => {
    const { code, bundler } = await bundleDefinitions(DEFINITIONS_ENTRY);
    expect(["swc", "esbuild"]).toContain(bundler);
    expect(code.length).toBeGreaterThan(100_000);
    for (const name of ["infrastructureDeployWorkflow", "infrastructureDestroyWorkflow", "dayTwoOperationWorkflow", "remediationWorkflow", "reconcileEnvironmentWorkflow", "reconcileSweepWorkflow", "teardownReviewWorkflow"]) expect(code).toContain(name);
    expect(code).not.toContain("node:fs");
  }, 120_000);

  const attempt = async (fixture: string) => {
    const { logger, lines } = capturingLogger();
    const result = await bundleWorkflowCode({ workflowsPath: path.join(ROOT, "tests/workflows/fixtures", fixture), webpackConfigHook: useEsbuildLoader, logger }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );
    return { ...result, output: lines.join("\n") };
  };

  it("negative control: an @/ import cannot be resolved by the bundler (which is why definitions use relative imports)", async () => {
    const r = await attempt("uses-alias.ts");
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Can't resolve '@\/lib\/workflows\/types'/);
  }, 120_000);

  it("positive control: the same import, made relative, bundles", async () => {
    expect((await attempt("uses-relative.ts")).ok).toBe(true);
  }, 120_000);

  it("negative control: a Node built-in import is refused", async () => {
    const r = await attempt("uses-node.ts");
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Reading from "node:fs" is not handled/);
  }, 120_000);
});

describe("activity sets stay in step", () => {
  const stubs = createActivities({ workerIdentity: "test" });
  const fake = createFakeActivities();

  it("the stubs, the fake and the policy table cover the same activities", () => {
    const policy = Object.keys(ACTIVITY_OPTIONS).sort();
    expect(Object.keys(stubs).sort()).toEqual(policy);
    expect(Object.keys(fake.activities).sort()).toEqual(policy);
  });

  it("every stub activity fails non-retryably as not_implemented, saying nothing was changed", async () => {
    for (const [name, fn] of Object.entries(stubs)) {
      const err = await (fn as (input: unknown) => Promise<unknown>)({}).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(ApplicationFailure);
      const failure = err as ApplicationFailure;
      expect(failure.type, name).toBe(FAILURE_TYPES.notImplemented);
      expect(failure.nonRetryable, name).toBe(true);
      expect(failure.message, name).toContain(name);
      expect(failure.message, name).toContain("nothing was changed");
    }
  });
});

describe("control-plane errors cross the activity boundary as typed failures", () => {
  it("maps LeaseLostError to a non-retryable LeaseLost", () => {
    const mapped = toTemporalFailure(new LeaseLostError("env:e1", 7)) as ApplicationFailure;
    expect(mapped).toBeInstanceOf(ApplicationFailure);
    expect(mapped.type).toBe("LeaseLost");
    expect(mapped.nonRetryable).toBe(true);
    expect(mapped.message).toContain("env:e1");
  });

  it("maps TofuPlanChangedError to a non-retryable plan_changed", () => {
    const mapped = toTemporalFailure(new TofuPlanChangedError("a".repeat(64), "b".repeat(64))) as ApplicationFailure;
    expect(mapped.type).toBe("plan_changed");
    expect(mapped.nonRetryable).toBe(true);
    expect(mapped.message).toMatch(/new approval is required/);
  });

  it("leaves typed failures, cancellations and unknown errors alone (unknown stays retryable)", () => {
    const typed = ApplicationFailure.nonRetryable("x", "StepFailed");
    const cancelled = new CancelledFailure("c");
    const unknown = new Error("socket hang up");
    expect(toTemporalFailure(typed)).toBe(typed);
    expect(toTemporalFailure(cancelled)).toBe(cancelled);
    expect(toTemporalFailure(unknown)).toBe(unknown);
    expect(toTemporalFailure("a string")).toBe("a string");
  });

  it("withFailureMapping wraps every activity and preserves results", async () => {
    const wrapped = withFailureMapping({
      ok: async (n: number) => n + 1,
      lost: async () => {
        throw new LeaseLostError("env:e2", 3);
      },
    });
    expect(await wrapped.ok(1)).toBe(2);
    const err = (await wrapped.lost().catch((e: unknown) => e)) as ApplicationFailure;
    expect(err.type).toBe("LeaseLost");
  });
});

describe("the contract carries no credential-shaped fields", () => {
  it("has no property named like a secret in workflows/types.ts", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/workflows/types.ts"), "utf8");
    const props = [...source.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]!);
    expect(props.length).toBeGreaterThan(30);
    const suspicious = props.filter((p) => /(secret|password|passwd|credential|apikey|accesskey|privatekey|sessiontoken|authorization|bearer)/i.test(p));
    expect(suspicious).toEqual([]);
  });
});
