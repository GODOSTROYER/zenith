/**
 * Cost engine v2, price catalog and placement solver (ADR-0013). Pure: no
 * network, environment, clock or store. See each module's header for its
 * invariants and honest limits.
 */
export * from "@/lib/placement/types";
export * from "@/lib/placement/pricebook";
export * from "@/lib/placement/sizes";
export * from "@/lib/placement/latency";
export * from "@/lib/placement/capabilities";
export * from "@/lib/placement/cost";
export * from "@/lib/placement/components";
export {
  MULTI_REGION_AVAILABILITY_TARGET,
  HIGH_AVAILABILITY_TARGET,
  deriveRequirements,
  type CandidateSpec,
  type Requirements,
  type Site,
  type Topology,
} from "@/lib/placement/candidates";
export * from "@/lib/placement/solver";
export * from "@/lib/placement/explain";
export * from "@/lib/placement/optimizer";
export * from "@/lib/placement/optimizer-submit";
