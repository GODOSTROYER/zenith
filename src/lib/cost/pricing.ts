/**
 * Cost model. Static estimate tables, clearly labeled as estimates in the UI.
 * The engine and UI both use these numbers, so cost previews and post-deploy
 * reporting always agree.
 *
 * Knows nothing about providers or real billing: it prices a manifest, never
 * an account. Formatting the number is `@/lib/format`'s job, not this one's.
 * SPINE FILE — owned by the integrator.
 */
import type { Manifest, ServiceSize } from "@/lib/domain/types";

/** USD / month for one replica of a service, by size. */
const SERVICE_MONTHLY: Record<ServiceSize, number> = {
  nano: 3.5,
  small: 7,
  standard: 14,
  performance: 42,
};

/** USD / month for resources, by kind and size. */
const RESOURCE_MONTHLY: Record<string, Record<ServiceSize, number>> = {
  postgres: { nano: 6, small: 12, standard: 26, performance: 78 },
  redis: { nano: 4, small: 8, standard: 18, performance: 50 },
  object_store: { nano: 1, small: 2.5, standard: 6, performance: 15 },
  queue: { nano: 1, small: 2, standard: 5, performance: 12 },
  email: { nano: 1, small: 3, standard: 8, performance: 20 },
};

/** Routes with managed TLS. */
const ROUTE_MONTHLY = 0.5;

export function nodeMonthlyCostUsd(m: Manifest, nodeId: string): number {
  const s = m.services.find((x) => x.id === nodeId);
  if (s) {
    if (s.kind === "cron") return SERVICE_MONTHLY[s.size] * 0.15; // runs briefly
    if (s.kind === "static") return 1.5;
    // Zero replicas runs nothing and bills nothing; the estimate must say so.
    return SERVICE_MONTHLY[s.size] * Math.max(0, s.replicas);
  }
  const r = m.resources.find((x) => x.id === nodeId);
  if (r) {
    if (r.ownership !== "managed") return 0; // referenced/external: not our bill
    return RESOURCE_MONTHLY[r.kind]?.[r.size] ?? 0;
  }
  const route = m.routes.find((x) => x.id === nodeId);
  if (route) return ROUTE_MONTHLY;
  return 0;
}

export function monthlyCostUsd(m: Manifest): number {
  let total = 0;
  for (const s of m.services) total += nodeMonthlyCostUsd(m, s.id);
  for (const r of m.resources) total += nodeMonthlyCostUsd(m, r.id);
  for (const rt of m.routes) total += nodeMonthlyCostUsd(m, rt.id);
  return Math.round(total * 100) / 100;
}

/** Per-size vCPU / memory shown in the inspector so defaults are never hidden. */
export const SIZE_SPECS: Record<ServiceSize, { vcpu: number; memoryMb: number }> = {
  nano: { vcpu: 0.25, memoryMb: 256 },
  small: { vcpu: 0.5, memoryMb: 512 },
  standard: { vcpu: 1, memoryMb: 1024 },
  performance: { vcpu: 2, memoryMb: 4096 },
};
