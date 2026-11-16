/**
 * Helpers every Zenith-managed driver shares: tenant-scoped contexts, honest
 * observation builders, and error normalization that can never echo a secret.
 *
 * Observation rules (driver conventions): report only what was actually read,
 * as `known`; everything else `unknown` with a reason; `presence` is `present`
 * / `missing` (API said not found) / `inaccessible` (forbidden) / `unknown`
 * (anything else). The `native` bag stays small and redacted.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { DriverCapabilities, DriverContext, VerificationCheck, VerificationResult } from "@/lib/drivers/types";
import type { ObservedValue, Observation, Presence, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { assertSessionMatches, type ZenithSession } from "../session";
import { scrubText } from "../database";

/** The Kubernetes provider's context for a tenant-scoped call; refuses when the session belongs to another tenant. */
export function scopedContext(ctx: DriverContext<ZenithSession>): DriverContext<KubernetesSession> {
  assertSessionMatches(ctx.session, ctx);
  return { ...ctx, session: ctx.session.kubernetes };
}

/** Every claim a zenith driver makes is `contract` at best: nothing has run against a managed cluster. */
export function contractEvidence(keys: readonly string[]): DriverCapabilities["evidence"] {
  return Object.fromEntries(keys.map((k) => [k, "contract" as const]));
}

export const known = <T>(value: T, at: Date): ObservedValue<T> => ({ state: "known", value, observedAt: at.toISOString() });

export const unknownValue = (reason: Extract<ObservedValue, { state: "unknown" }>["reason"], detail?: string): ObservedValue => ({
  state: "unknown",
  reason,
  ...(detail ? { detail: scrubText(detail, [], 200) } : {}),
});

export interface ObservationInput {
  ctx: DriverContext<ZenithSession>;
  node: ResourceNode;
  source: string;
  presence: Presence;
  externalId?: string;
  attributes?: Record<string, ObservedValue>;
  native?: Record<string, unknown>;
  error?: string;
}

export function observation(i: ObservationInput): Observation {
  return {
    address: i.node.address,
    ...(i.externalId ? { externalId: i.externalId } : {}),
    presence: i.presence,
    attributes: i.attributes ?? {},
    ...(i.native ? { native: i.native } : {}),
    observedAt: i.ctx.now().toISOString(),
    source: i.source,
    simulated: false,
    ...(i.error ? { error: scrubText(i.error, [], 700) } : {}),
  };
}

/** Presence from a thrown Kubernetes-provider error: forbidden is `inaccessible`, not-found is `missing`, the rest `unknown`. */
export function presenceFromError(e: unknown): { presence: Presence; message: string } {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const message = scrubText(e instanceof Error ? e.message : "Unexpected error.", [], 300);
  if (code === "forbidden" || code === "unauthorized" || code === "namespace_forbidden") return { presence: "inaccessible", message };
  if (code === "not_found") return { presence: "missing", message };
  return { presence: "unknown", message };
}

export function runtimeState(ctx: DriverContext<ZenithSession>, node: ResourceNode, source: string, r: Partial<Pick<RuntimeState, "health" | "counts" | "signals">>): RuntimeState {
  return {
    address: node.address,
    health: r.health ?? "unknown",
    counts: r.counts ?? {},
    signals: r.signals ?? [],
    observedAt: ctx.now().toISOString(),
    source,
    simulated: false,
  };
}

/** The kind prefix of a node address (`load_balancer/public` → `load_balancer`). */
export const addressPrefix = (address: string): string => {
  const i = address.indexOf("/");
  return i === -1 ? address : address.slice(0, i);
};

/** Structural equality for the JSON-ish attribute values drivers compare. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/**
 * Verify an observation against the attributes the driver expects: a check per
 * expected attribute (`unknown` when it was not read, never "matches"), plus the
 * caller's extra checks. Existence is always the first check.
 */
export function verifyAgainst(
  ctx: DriverContext<ZenithSession>,
  node: ResourceNode,
  observation: Observation,
  expected: Record<string, unknown>,
  extra: VerificationCheck[] = []
): VerificationResult {
  const checks: VerificationCheck[] = [
    {
      id: "exists",
      description: "the resource exists",
      passed: observation.presence === "present" ? true : observation.presence === "missing" ? false : "unknown",
      ...(observation.presence === "present" ? {} : { detail: `presence is ${observation.presence}` }),
    },
  ];
  if (observation.presence === "present") {
    for (const [attr, want] of Object.entries(expected)) {
      const got = observation.attributes[attr];
      if (!got || got.state !== "known") checks.push({ id: `attr:${attr}`, description: `${attr} matches the desired value`, passed: "unknown", detail: "not read" });
      else checks.push({ id: `attr:${attr}`, description: `${attr} matches the desired value`, passed: sameValue(got.value, want) });
    }
  }
  checks.push(...extra);
  const failed = checks.some((c) => c.passed === false);
  const unknown = checks.some((c) => c.passed === "unknown");
  return { address: node.address, status: failed ? "failed" : unknown ? "unknown" : "passed", checks, checkedAt: ctx.now().toISOString(), simulated: false };
}
