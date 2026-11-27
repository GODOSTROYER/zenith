/** Isolated, synthetic scope approvals for offline tests. Never modifies the shipped manifest. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentDigest, FORBIDDEN_ACTIONS, parseManifest, type ScopeManifest } from "../../scripts/release/scope";

export const COMPUTE_SCOPE_NOW = "2026-11-27T00:00:00.000Z";
export const COMPUTE_SCOPE_PROJECT = "fixture-project";
export const COMPUTE_SCOPE_SUBSCRIPTION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export function computeScopeFixture(edit?: (manifest: ScopeManifest) => void): ScopeManifest {
  const manifest = parseManifest({
    schema: 1,
    budgets: { currency: "USD", perRunUsd: 0, perProviderPerRunUsd: { public: 0, aws: 0, gcp: 0, azure: 0 }, totalUsd: 0, maxRunTtlMinutes: 60 },
    disposable: { runIdPattern: "^zlive-\\d{12}-[a-z0-9]{4}$", namePrefix: "zenith-", requiredTag: "zenith:live-run", ttlTag: "zenith:ttl-expires" },
    sandboxes: {
      aws: { accountId: "123456789012", regions: ["ap-south-1", "us-east-1", "us-west-2"] },
      gcp: { projectId: COMPUTE_SCOPE_PROJECT, regions: ["us-central1"] },
      azure: { subscriptionId: COMPUTE_SCOPE_SUBSCRIPTION, tenantId: "ffffffff-0000-4000-8000-000000000002", regions: ["centralindia", "eastus"] },
      oci: { tenancyId: null, compartmentId: null, regions: ["us-ashburn-1"] },
      supabase: { projectRef: null, region: "us-east-1" },
    },
    allowances: { stopAtFraction: 0.8, anthropicUsd: 0, sharedLedger: "test-scope-ledger.json" },
    harnesses: { "compute-catalog": { description: "Synthetic offline metadata collection scope", providers: ["public", "aws", "gcp", "azure"], actions: ["read"], maxRunUsd: 0 } },
    forbiddenActions: [...FORBIDDEN_ACTIONS], exemptions: [],
    approval: { status: "not_approved", approvedBy: null, approvedAt: null, expiresAt: null, approvedDigest: null },
  });
  edit?.(manifest);
  return parseManifest({
    ...manifest,
    approval: { status: "approved", approvedBy: "Offline Test Fixture", approvedAt: "2026-11-26T00:00:00.000Z", expiresAt: "2026-11-28T00:00:00.000Z", approvedDigest: contentDigest(manifest) },
  });
}

export function writeComputeScopeFixture(directory: string, manifest = computeScopeFixture()): Record<string, string> {
  const file = join(directory, "scope.json");
  writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
  return { ZENITH_LIVE_CATALOG_REFRESH: "1", ZENITH_LIVE_SCOPE_FILE: file };
}
