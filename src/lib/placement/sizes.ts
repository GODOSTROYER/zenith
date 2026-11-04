/**
 * Size semantics for the cost engine and the solver.
 *
 * `SIZE_SPECS` is the same nano/small/standard/performance vCPU and memory
 * table as the legacy cost model (`@/lib/cost/pricing` SIZE_SPECS, which stays
 * for the V1 UI); a test pins them equal so the two can never drift silently.
 *
 * What differs from the legacy model, on purpose:
 * - Container memory is rounded UP to the providers' shared minimum of 2 GB per
 *   vCPU (Fargate, Cloud Run and Container Apps all reject smaller ratios), so
 *   nano/small/standard bill 0.5/1/2 GB rather than 0.25/0.5/1 GB.
 * - OCI Container Instances bill whole OCPUs (1 OCPU = 2 vCPU, 1 GB minimum),
 *   so small shapes are billed as 2 vCPU.
 * - Managed databases and caches map onto the closest provider instance class
 *   (see the catalog `note` of each `*.nano|small|standard|performance_hour`
 *   entry); they are comparable classes, not identical hardware.
 */
export const PLACEMENT_SIZES = ["nano", "small", "standard", "performance"] as const;
export type PlacementSize = (typeof PLACEMENT_SIZES)[number];

export function isPlacementSize(v: unknown): v is PlacementSize {
  return typeof v === "string" && (PLACEMENT_SIZES as readonly string[]).includes(v);
}

/** vCPU / memory per size, identical to the legacy `SIZE_SPECS`. */
export const SIZE_SPECS: Record<PlacementSize, { vcpu: number; memoryMb: number }> = {
  nano: { vcpu: 0.25, memoryMb: 256 },
  small: { vcpu: 0.5, memoryMb: 512 },
  standard: { vcpu: 1, memoryMb: 1024 },
  performance: { vcpu: 2, memoryMb: 4096 },
};

export interface ContainerShape {
  /** vCPU actually billed per replica */
  vcpu: number;
  /** GB actually billed per replica */
  memoryGb: number;
  /** why the billed shape differs from the spec, if it does */
  note?: string;
}

/** Billed container shape for a size on a provider (see module doc for the rounding rules). */
export function containerShape(provider: string, size: PlacementSize): ContainerShape {
  const spec = SIZE_SPECS[size];
  const legacyGb = spec.memoryMb / 1024;
  let vcpu = spec.vcpu;
  let memoryGb = Math.max(legacyGb, 2 * vcpu);
  const notes: string[] = [];
  if (memoryGb !== legacyGb) notes.push(`memory raised from ${legacyGb} GB to the ${memoryGb} GB provider minimum (2 GB per vCPU)`);
  if (provider === "oci") {
    const billedVcpu = Math.max(2, vcpu);
    if (billedVcpu !== vcpu) notes.push(`OCI bills whole OCPUs: ${vcpu} vCPU billed as ${billedVcpu} vCPU (1 OCPU)`);
    vcpu = billedVcpu;
    memoryGb = Math.max(memoryGb, 1);
  }
  return { vcpu, memoryGb, note: notes.length > 0 ? notes.join("; ") : undefined };
}

export type VmClass = "small" | "medium" | "large";

/** compute_instance size -> VM class: nano/small -> small, standard -> medium, performance -> large. */
export function vmClass(size: PlacementSize): VmClass {
  if (size === "performance") return "large";
  if (size === "standard") return "medium";
  return "small";
}
