/**
 * The policy engine: OPA-compiled Rego, evaluated in-process (ADR-0008).
 *
 *   PolicyInput ─validate(zod, strict)─▶ catalog consistency ─▶ wasm (Rego)
 *     ─validate(zod, strict)─▶ EvaluatedPolicy { decision, policyVersion, inputDigest }
 *
 * Properties this module owns:
 *  - Deterministic. Same input, same wasm, same decision. No network, no clock,
 *    no environment reads inside evaluation; time comes from `input.context.now`
 *    and is only echoed back as `evaluatedAt`.
 *  - Fail closed. Malformed input, an input that disagrees with the capability
 *    catalog, a wasm trap, a missing/empty/malformed result: every one of them
 *    yields `outcome: "deny"` with reason `policy_error` (the failing stage is
 *    named in the reason's `rule`). `evaluate` does not throw for these. The
 *    engine never turns an error into an allow, and never returns a decision it
 *    could not validate.
 *  - Versioned. `policyVersion` is the SHA-256 of the wasm (from
 *    `policy/dist/manifest.json`, cross-checked against the bytes actually
 *    loaded); `inputDigest` is `digest(input)` from the control-plane rule.
 *
 * Loading fails loudly (`PolicyLoadError`) rather than degrading: a missing,
 * corrupt or tampered bundle means no engine, and callers must treat a
 * rejected `loadPolicyEngine()` as "deny everything" (the broker does).
 *
 * The wasm path is `ZENITH_POLICY_WASM` when set, else
 * `<cwd>/policy/dist/policy.wasm`. `next build` output tracing must include
 * `policy/dist/**` for serverless deployments (see policy/README.md).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPolicy } from "@/lib/policy/vendor/opa-wasm/index.mjs";
import { z } from "zod";
import { CAPABILITIES, type CapabilityDef } from "@/lib/capabilities/catalog";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import type { PolicyReason } from "@/lib/controlplane/types";
import { asPolicyDecision, asPolicyInput, PolicyDecisionSchema, PolicyInputSchema } from "./schema";
import type { EvaluatedPolicy, PolicyDecision, PolicyEngine, PolicyInput } from "./types";

export const POLICY_ENTRYPOINT = "zenith/decision/result";
export const DEFAULT_POLICY_WASM = path.join("policy", "dist", "policy.wasm");

/** Wasm linear memory: 1 MiB to start, 32 MiB at most, so a hostile input cannot exhaust the process. */
const WASM_MEMORY = { initial: 16, maximum: 512 } as const;

export class PolicyLoadError extends Error {
  readonly code = "policy_load_failed";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The subset of a loaded opa-wasm policy the engine uses (also what tests fake). */
export interface WasmPolicy {
  evaluate(input: unknown, entrypoint?: number | string): unknown;
}

const EPOCH = "1970-01-01T00:00:00.000Z";

const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

/* ------------------------------------------------------------ fail closed -- */

type FailureStage = "input" | "catalog" | "evaluation" | "output";

function failClosedDecision(stage: FailureStage, message: string): PolicyDecision {
  const reason: PolicyReason = { code: "policy_error", message, rule: `zenith.engine.${stage}` };
  return { outcome: "deny", reasons: [reason] };
}

/** Field paths and issue codes only — never values, which may be externally derived. */
function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(root)"} (${issue.code})`);
  return parts.join(", ") + (error.issues.length > 8 ? `, and ${error.issues.length - 8} more` : "");
}

function safeDigest(value: unknown): string {
  try {
    return digest(value);
  } catch {
    return digest({ unserializable: true });
  }
}

function claimedNow(input: unknown): string {
  const now = (input as { context?: { now?: unknown } } | null | undefined)?.context?.now;
  return typeof now === "string" && z.string().datetime({ offset: true }).safeParse(now).success ? now : EPOCH;
}

/* ------------------------------------------------------- catalog consistency -- */

/**
 * The broker derives `request` from the catalog; this re-derives the same facts
 * independently so a broker (or test) bug that understates a capability — say,
 * `database.delete` claiming `mutates: false` — is refused instead of being
 * evaluated as claimed. A request may carry a *higher* risk than the catalog
 * floor (policy raises risk, never lowers it), never a lower one.
 */
function catalogProblems(input: PolicyInput): string[] {
  const def: CapabilityDef | undefined = Object.prototype.hasOwnProperty.call(CAPABILITIES, input.request.capability)
    ? (CAPABILITIES as Record<string, CapabilityDef>)[input.request.capability]
    : undefined;
  if (!def) return ["request.capability (not in the catalog)"];

  const problems: string[] = [];
  if (input.request.mutates !== def.mutates) problems.push("request.mutates");
  if (input.request.destructive !== (def.destructive ?? false)) problems.push("request.destructive");
  if (input.request.escapeHatch !== (def.escapeHatch ?? false)) problems.push("request.escapeHatch");
  if (input.request.defaultAutonomy !== def.defaultAutonomy) problems.push("request.defaultAutonomy");
  if (RISK_RANK[input.request.risk] < RISK_RANK[def.risk]) problems.push("request.risk (below the catalog floor)");
  if (input.request.integrationScope !== undefined && input.request.integrationScope !== def.integrationScope) {
    problems.push("request.integrationScope");
  }
  return problems;
}

/** The document the wasm evaluates: the input plus the catalog's integration scope when absent. */
function wasmInput(input: PolicyInput): PolicyInput {
  if (input.request.integrationScope !== undefined) return input;
  const def = (CAPABILITIES as Record<string, CapabilityDef>)[input.request.capability];
  return { ...input, request: { ...input.request, integrationScope: def.integrationScope } };
}

/* ------------------------------------------------------------------ engine -- */

/** Wrap a loaded wasm policy as a `PolicyEngine`. Exported so tests can inject faults. */
export function createPolicyEngine(policy: WasmPolicy, version: string): PolicyEngine {
  return {
    version,
    async evaluate(rawInput: unknown): Promise<EvaluatedPolicy> {
      const inputDigest = safeDigest(rawInput);
      const finish = (decision: PolicyDecision, evaluatedAt: string): EvaluatedPolicy => ({
        decision,
        policyVersion: version,
        inputDigest,
        evaluatedAt,
      });

      const parsed = PolicyInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return finish(
          failClosedDecision("input", `The policy input is invalid (${describeIssues(parsed.error)}); the request is denied.`),
          claimedNow(rawInput)
        );
      }
      const input = asPolicyInput(parsed.data);
      const evaluatedAt = input.context.now;

      const mismatches = catalogProblems(input);
      if (mismatches.length > 0) {
        return finish(
          failClosedDecision("catalog", `The request disagrees with the capability catalog (${mismatches.join(", ")}); the request is denied.`),
          evaluatedAt
        );
      }

      let raw: unknown;
      try {
        raw = policy.evaluate(wasmInput(input));
      } catch {
        return finish(failClosedDecision("evaluation", "Policy evaluation failed; the request is denied."), evaluatedAt);
      }

      const first: unknown = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
      const result: unknown = first !== null && typeof first === "object" ? (first as { result?: unknown }).result : undefined;
      const decision = PolicyDecisionSchema.safeParse(result);
      if (!decision.success) {
        return finish(
          failClosedDecision("output", "The policy returned an unusable result; the request is denied."),
          evaluatedAt
        );
      }
      return finish(asPolicyDecision(decision.data), evaluatedAt);
    },
  };
}

/* ----------------------------------------------------------------- loading -- */

const ManifestSchema = z
  .object({
    entrypoint: z.string(),
    wasmSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

export function policyWasmPath(override?: string): string {
  const configured = override ?? process.env.ZENITH_POLICY_WASM;
  return path.resolve(configured && configured.trim() ? configured.trim() : path.join(process.cwd(), DEFAULT_POLICY_WASM));
}

/**
 * Read the manifest that sits next to the wasm and cross-check it against the
 * bytes. A manifest that is present must match; one that is absent (a wasm
 * supplied through `ZENITH_POLICY_WASM` without a manifest) falls back to the
 * bytes' own SHA-256, which is the same value.
 */
async function versionOf(wasmPath: string, bytes: Uint8Array): Promise<string> {
  const actual = sha256Hex(bytes);
  const manifestPath = path.join(path.dirname(wasmPath), "manifest.json");
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return actual;
    throw new PolicyLoadError("The policy manifest could not be read.", { cause: error });
  }
  let manifest: z.infer<typeof ManifestSchema>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new PolicyLoadError("The policy manifest is malformed.", { cause: error });
  }
  if (manifest.entrypoint !== POLICY_ENTRYPOINT) {
    throw new PolicyLoadError(`The policy manifest names entrypoint "${manifest.entrypoint}", expected "${POLICY_ENTRYPOINT}".`);
  }
  if (manifest.wasmSha256 !== actual) {
    throw new PolicyLoadError(`The policy wasm does not match its manifest (manifest ${manifest.wasmSha256.slice(0, 12)}, file ${actual.slice(0, 12)}).`);
  }
  return actual;
}

async function loadFrom(wasmPath: string): Promise<PolicyEngine> {
  let bytes: Buffer;
  try {
    bytes = await readFile(wasmPath);
  } catch (error) {
    throw new PolicyLoadError(`The policy wasm could not be read at ${wasmPath}.`, { cause: error });
  }
  const version = await versionOf(wasmPath, bytes);
  let policy: WasmPolicy;
  try {
    policy = await loadPolicy(bytes, WASM_MEMORY);
  } catch (error) {
    throw new PolicyLoadError("The policy wasm could not be instantiated.", { cause: error });
  }
  return createPolicyEngine(policy, version);
}

const cache = new Map<string, Promise<PolicyEngine>>();

/**
 * Load (once per wasm path) and return the policy engine. A failed load is not
 * cached, so a repaired bundle is picked up by the next call.
 */
export function loadPolicyEngine(options: { wasmPath?: string } = {}): Promise<PolicyEngine> {
  const wasmPath = policyWasmPath(options.wasmPath);
  const cached = cache.get(wasmPath);
  if (cached) return cached;
  const pending = loadFrom(wasmPath).catch((error: unknown) => {
    cache.delete(wasmPath);
    throw error;
  });
  cache.set(wasmPath, pending);
  return pending;
}

/** Drop cached engines (tests, or after replacing the bundle in a long-lived process). */
export function resetPolicyEngineCache(): void {
  cache.clear();
}
