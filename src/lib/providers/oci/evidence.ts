/**
 * Evidence declarations for the OCI drivers (DRIVER-CONVENTIONS "Evidence and
 * tests"). There is no OCI account behind this workstream, so the honest level
 * for every operation is `contract`:
 *
 *   compile   `tofu validate` against the pinned oracle/oci 9.7.1 provider
 *             schema (gated test) plus structural tests. NEVER planned or
 *             applied against a tenancy.
 *   observe / runtime / verify / discover / operations
 *             exercised only against a fake `OciApiTransport`. Request paths,
 *             query names and response field names follow the public OCI API
 *             reference and were not exercised against the real service.
 *
 * Nothing here may be raised to `real` or `emulated` without a live acceptance
 * run; `tests/providers/oci/evidence.test.ts` fails if a driver claims more.
 */
import type { DriverCapabilities, EvidenceLevel } from "@/lib/drivers/types";

export interface CapabilityFlags {
  compile?: boolean;
  observe?: boolean;
  runtime?: boolean;
  verify?: boolean;
  discover?: boolean;
  operations?: string[];
}

export function ociCapabilities(flags: CapabilityFlags): DriverCapabilities {
  const level: EvidenceLevel = "contract";
  const evidence: Record<string, EvidenceLevel> = {};
  const c = { compile: !!flags.compile, observe: !!flags.observe, runtime: !!flags.runtime, verify: !!flags.verify, discover: !!flags.discover };
  for (const [k, v] of Object.entries(c)) if (v) evidence[k] = level;
  const operations = [...(flags.operations ?? [])].sort();
  for (const op of operations) evidence[op] = level;
  return { ...c, operations, evidence };
}

/** `oci.<suffix>@1` from a native type `oci:<suffix>`. */
export const ociDriverId = (nativeType: string): string => `oci.${nativeType.slice("oci:".length)}@1`;
