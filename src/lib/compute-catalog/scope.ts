import { requireScope, ScopeError, type Scope } from "../../../scripts/release/scope";
import type { ComputeCollectionRequest } from "./collect";
import type { ComputeProvider } from "./types";

export const COMPUTE_CATALOG_HARNESS = "compute-catalog";

/** Price-index Local/Wavelength locations are not regional EC2 SDK endpoints. */
export function isAwsInventoryRegion(region: string): boolean {
  return /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region);
}

export function assertComputeScopeRegions(scope: Scope, provider: ComputeProvider, regions: readonly string[]): void {
  const approved = scope.manifest.sandboxes[provider].regions;
  if (regions.some(region => !approved.includes(region))) {
    throw new ScopeError("sandbox_unconfirmed", `Compute catalog ${provider} regions must match the approved sandbox regions.`);
  }
}

/** Enforce the existing approved scope contract; no collector-specific approval bypass exists. */
export function requireComputeCollectionScope(
  request: ComputeCollectionRequest,
  env: Readonly<Record<string, string | undefined>>,
  now: () => string,
): Scope {
  const clock = () => {
    const date = new Date(now());
    if (!Number.isFinite(date.getTime())) throw new ScopeError("manifest_invalid", "Compute collection requires a valid current timestamp for scope approval checks.");
    return date;
  };
  clock();
  const provider = request.provider === "aws" && !request.awsInventory ? "public" : request.provider;
  const scope = requireScope(COMPUTE_CATALOG_HARNESS, provider, env, clock);
  if (provider === "public") return scope;

  if (request.provider === "gcp" && request.gcpProject !== scope.manifest.sandboxes.gcp.projectId) {
    throw new ScopeError("sandbox_unconfirmed", "The GCP project must match the approved compute-catalog sandbox.");
  }
  if (request.provider === "azure" && request.azureSubscription?.toLowerCase() !== scope.manifest.sandboxes.azure.subscriptionId?.toLowerCase()) {
    throw new ScopeError("sandbox_unconfirmed", "The Azure subscription must match the approved compute-catalog sandbox.");
  }
  if (request.provider !== "aws" && !request.regions?.length) {
    throw new ScopeError("sandbox_unconfirmed", "Authenticated GCP/Azure collection requires explicit approved regions; --all-regions is not supported.");
  }
  if (request.regions) {
    const regions = request.provider === "aws" ? request.regions.filter(isAwsInventoryRegion) : request.regions;
    assertComputeScopeRegions(scope, request.provider, regions);
  }
  // GCP/Azure APIs still return global machine/SKU metadata for the matched account.
  // Regions constrain requested output, not the wire response. AWS regions are also
  // checked after index discovery; its ambient SDK credential account is not verified
  // here. Operators must select the credential chain for the approved AWS account.
  return scope;
}
