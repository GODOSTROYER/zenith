/**
 * V1 → V2 upgrade and the exact way back (ADR-0003).
 *
 * `upgradeManifest` is pure, deterministic and LOSSLESS: services, resources,
 * routes and bindings are carried over untouched — same order, same optional
 * fields, same ids — so `downgradeToV1(upgradeManifest(m))` deep-equals `m`
 * for every V1 manifest (tested over the blueprints, the importers' output and
 * a seeded random population). What V2 adds is either supplied by the caller
 * (target provider/region, and optionally the environment's V1 policies) or
 * defaulted, and every default applied is recorded in `notes` — the upgrade
 * never invents a setting silently.
 *
 * V1 is never rewritten implicitly: nothing here mutates its input or persists
 * anything; whoever calls this decides whether the result replaces a revision.
 *
 * `downgradeToV1` returns only the V1 part. It is exact for an upgraded
 * manifest; for a hand-authored V2 manifest it drops the V2-only sections, and
 * `v2OnlySections` says which ones would be lost.
 */
import type { Manifest as ManifestV1, ManifestPolicies } from "@/lib/domain/types";
import {
  isV2,
  Placement,
  type AnyManifest,
  type ManifestV2,
  type PlacementProvider,
} from "./manifest-v2";
import { STATEFUL_KINDS } from "./types";

export interface UpgradeTarget {
  provider: PlacementProvider;
  /** required unless `provider` is `auto` */
  region?: string;
  /**
   * V1 keeps policies on the Environment, not on the manifest. Pass them to
   * carry them into V2; omit and they stay on the environment.
   */
  policies?: Partial<ManifestPolicies>;
}

export interface UpgradeResult {
  manifest: ManifestV2;
  /** every default applied and every V1 setting carried over, one line each, stable order */
  notes: string[];
}

/** Upgrade with the audit trail of what was defaulted. */
export function upgradeManifestDetailed(v1: ManifestV1, target: UpgradeTarget): UpgradeResult {
  if ((v1 as { version?: unknown }).version !== 1)
    throw new Error("upgradeManifest takes a version 1 manifest.");

  const placement = Placement.safeParse({
    provider: target.provider,
    regions: target.region === undefined ? [] : [target.region],
  });
  if (!placement.success)
    throw new Error(`Cannot upgrade: ${placement.error.issues.map((i) => i.message).join("; ")}`);

  const notes: string[] = [];
  const regionText = placement.data.regions.length ? `region ${placement.data.regions[0]}` : "no region";
  notes.push(`placement: provider ${placement.data.provider}, ${regionText} taken from the target environment; V1 manifests carry no placement.`);

  const stateful = v1.resources
    .filter((r) => (STATEFUL_KINDS as readonly string[]).includes(r.kind))
    .map((r) => r.name)
    .sort();
  notes.push('policies.deletion: defaulted to "approval"; V1 manifests carry no deletion policy.');
  notes.push(
    `policies.backup: defaulted to "daily", which applies to stateful resources${stateful.length ? ` (${stateful.join(", ")})` : " (this manifest has none yet)"}.`
  );

  const policies: NonNullable<ManifestV2["policies"]> = { deletion: "approval", backup: "daily" };
  let constraints: ManifestV2["constraints"];
  const carried = target.policies;
  if (carried) {
    if (carried.approvalRequired !== undefined) {
      policies.approvalRequired = carried.approvalRequired;
      notes.push(`policies.approvalRequired: carried over from the environment's V1 policies (${carried.approvalRequired}).`);
    }
    if (carried.allowStatefulDeletion !== undefined) {
      policies.allowStatefulDeletion = carried.allowStatefulDeletion;
      notes.push(`policies.allowStatefulDeletion: carried over from the environment's V1 policies (${carried.allowStatefulDeletion}).`);
    }
    if (carried.budgetUsdMonthly !== undefined) {
      constraints = { budgetUsdMonthly: carried.budgetUsdMonthly };
      notes.push(`constraints.budgetUsdMonthly: carried over from the environment's V1 policies (${carried.budgetUsdMonthly}).`);
    }
  } else {
    notes.push("policies.approvalRequired and policies.allowStatefulDeletion: left unset; V1 keeps them on the environment, which stays authoritative until they are copied here.");
  }

  notes.push("constraints, nodePlacement, providerConfig and native: omitted; V1 has no equivalent, so nothing was defaulted for them.");

  const manifest: ManifestV2 = {
    version: 2,
    services: structuredClone(v1.services),
    resources: structuredClone(v1.resources),
    routes: structuredClone(v1.routes),
    bindings: structuredClone(v1.bindings),
    placement: placement.data,
    policies,
    ...(constraints ? { constraints } : {}),
  };
  return { manifest, notes };
}

export function upgradeManifest(v1: ManifestV1, target: UpgradeTarget): ManifestV2 {
  return upgradeManifestDetailed(v1, target).manifest;
}

/** The V1 part of a V2 manifest, deep-copied. Exact inverse of `upgradeManifest`. */
export function downgradeToV1(m: ManifestV2): ManifestV1 {
  return structuredClone({
    version: 1 as const,
    services: m.services,
    resources: m.resources,
    routes: m.routes,
    bindings: m.bindings,
  });
}

/**
 * A V1-shaped view for code that only knows V1 (`diffManifests`, `bindingEnv`,
 * cost). Returns a V1 manifest as-is (no copy) and the V1 part of a V2 one.
 */
export function v1View(m: AnyManifest): ManifestV1 {
  return isV2(m) ? downgradeToV1(m) : m;
}

/** V2-only sections present on `m`: what `downgradeToV1` would discard. */
export function v2OnlySections(m: ManifestV2): string[] {
  const out: string[] = [];
  if (m.placement) out.push("placement");
  if (m.constraints) out.push("constraints");
  if (m.policies) out.push("policies");
  if (m.nodePlacement && Object.keys(m.nodePlacement).length) out.push("nodePlacement");
  if (m.providerConfig && Object.keys(m.providerConfig).length) out.push("providerConfig");
  if (m.native?.length) out.push("native");
  return out;
}
