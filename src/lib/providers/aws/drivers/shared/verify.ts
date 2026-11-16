/**
 * Verification helpers: turn (expected attributes, observation) into honest
 * checks. `verify` never claims "matches" for an attribute nobody read — that
 * check is `"unknown"` — and a failed expectation names both sides (bounded).
 *
 *   exists            presence `present` → true, `missing` → false, else "unknown"
 *   attr:<name>       known and equal → true; known and different → false;
 *                     unknown / not read → "unknown"
 *
 * Overall status: any `false` → `failed`; else any `"unknown"` → `unknown`;
 * else `passed`. Comparison is structural over JSON (key order and array
 * order of objects are ignored only for object keys, never for arrays: lists
 * a driver wants compared as sets must be sorted by the driver).
 */
import type { VerificationCheck, VerificationResult } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { scrubErrorText } from "./errors";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

/** Structural JSON equality (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const show = (v: unknown): string => scrubErrorText(JSON.stringify(canonical(v)) ?? "undefined", 120);

export function existsCheck(observation: Observation, what = "the resource"): VerificationCheck {
  const passed = observation.presence === "present" ? true : observation.presence === "missing" ? false : "unknown";
  return {
    id: "exists",
    description: `${what} exists`,
    passed,
    ...(passed === true ? {} : { detail: observation.error ?? `presence is ${observation.presence}` }),
  };
}

/** One check per expected attribute, against what `observe` actually read. */
export function attributeChecks(expected: Record<string, unknown>, observation: Observation): VerificationCheck[] {
  return Object.keys(expected)
    .sort()
    .map((name): VerificationCheck => {
      const description = `${name} matches the desired configuration`;
      const observed = observation.attributes[name];
      if (!observed || observed.state === "unknown") {
        return { id: `attr:${name}`, description, passed: "unknown", detail: `not read${observed?.state === "unknown" ? ` (${observed.reason})` : ""}` };
      }
      return jsonEqual(expected[name], observed.value)
        ? { id: `attr:${name}`, description, passed: true }
        : { id: `attr:${name}`, description, passed: false, detail: `desired ${show(expected[name])}, observed ${show(observed.value)}` };
    });
}

export function overallStatus(checks: VerificationCheck[]): VerificationResult["status"] {
  if (checks.some((c) => c.passed === false)) return "failed";
  if (checks.some((c) => c.passed === "unknown")) return "unknown";
  return "passed";
}

export function verificationResult(ctx: { now(): Date }, node: ResourceNode, checks: VerificationCheck[]): VerificationResult {
  return { address: node.address, status: overallStatus(checks), checks, checkedAt: ctx.now().toISOString(), simulated: false };
}

/**
 * The standard verification: exists, then every expected attribute. When the
 * object is not present the attribute checks are omitted (there is nothing to
 * compare) and the `exists` check carries the verdict.
 */
export function standardVerification(ctx: { now(): Date }, node: ResourceNode, observation: Observation, expected: Record<string, unknown>, what?: string): VerificationResult {
  const exists = existsCheck(observation, what);
  const checks = observation.presence === "present" ? [exists, ...attributeChecks(expected, observation)] : [exists];
  return verificationResult(ctx, node, checks);
}
