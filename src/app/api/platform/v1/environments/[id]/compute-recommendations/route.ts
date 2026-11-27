/**
 * Read-only native VM discovery. The broker authorizes before reading the
 * operator's catalog or connection metadata; callers cannot supply evidence.
 * This never changes the working manifest, connects a cloud, or provisions.
 */
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { ComputeRecommendationRequestSchema, recommendCompute } from "@/lib/compute-catalog/recommend";
import { ComputeCatalogUnavailableError, ComputeCatalogValidationError, loadComputeCatalog } from "@/lib/compute-catalog/store";
import type { ComputeCatalog, ComputeProvider } from "@/lib/compute-catalog/types";
import { db } from "@/lib/db/store";
import { regionInfo, regionSatisfiesResidency } from "@/lib/placement/latency";
import { placementReads } from "@/lib/placement/recommend";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { parseWith, platformRoute, readJson } from "../../../_lib/http";
import { callerOf } from "../../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isComputeProvider = (provider: string): provider is ComputeProvider =>
  provider === "aws" || provider === "gcp" || provider === "azure";

async function trustedCatalog(): Promise<ComputeCatalog> {
  try {
    return await loadComputeCatalog();
  } catch (error) {
    if (error instanceof ComputeCatalogUnavailableError || error instanceof ComputeCatalogValidationError) {
      throw new BrokerError(
        "platform_store_unavailable",
        "A validated compute catalog is not available.",
        "Ask an operator to import current provider snapshots with compute:catalog, then retry.",
        { reason: error instanceof ComputeCatalogUnavailableError ? "compute_catalog_unavailable" : "compute_catalog_invalid" },
      );
    }
    throw error;
  }
}

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await callerOf(req);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw notFound();
  const data = db();
  const env = data.environments.find((e) => e.id === id && data.projects.some((p) => p.id === e.projectId && p.workspaceId === caller.workspaceId));
  if (!env) throw notFound();
  const project = data.projects.find((p) => p.id === env.projectId && p.workspaceId === caller.workspaceId);
  if (!project) throw notFound();
  const authorization = await (await platformBroker()).authorizeRead({ capability: "placement.solve", scope: {
    workspaceId: caller.workspaceId, projectId: project.id, environmentId: env.id,
  } }, caller.principal);
  if (authorization.decision.outcome !== "allow" || !authorization.claims) {
    throw new BrokerError("policy_denied", "Current policy does not authorize compute recommendations.", "Use a credential with the plan scope or ask a workspace administrator to review policy.");
  }
  // Resolve scope access before request-shape errors can reveal whether an
  // environment outside the caller's permitted projects or workspace exists.
  const input = parseWith(ComputeRecommendationRequestSchema, await readJson(req));

  const parsed = parseManifest(project.workingManifest);
  if (!parsed.ok) throw new BrokerError("invalid_request", "The working manifest is invalid.", "Fix the working manifest before requesting compute recommendations.");
  const manifest = parsed.manifest.version === 2 ? parsed.manifest : undefined;
  const placement = manifest?.placement;
  // A request may tighten these limits, but cannot relax the current project or
  // environment policy. This remains a compute-only estimate, not a total bill.
  const budgets = [manifest?.constraints?.budgetUsdMonthly, env.policies.budgetUsdMonthly, input.budgetUsdMonthly]
    .filter((value): value is number => value !== undefined);
  const budgetUsdMonthly = budgets.length ? Math.min(...budgets) : undefined;
  const boundedInput = parseWith(ComputeRecommendationRequestSchema, { ...input, ...(budgetUsdMonthly !== undefined ? { budgetUsdMonthly } : {}) });
  const catalog = await trustedCatalog();
  const policyRejections: Record<string, string[]> = Object.create(null);
  for (const offer of catalog.offers) {
    const reasons: string[] = [];
    if (placement?.provider && placement.provider !== "auto" && placement.provider !== offer.provider) {
      reasons.push("provider: the offer does not match the manifest's explicit placement provider");
    }
    if (placement?.regions.length && !placement.regions.includes(offer.region)) {
      reasons.push("region: the offer is outside the manifest's permitted placement regions");
    }
    if (placement?.residency?.length) {
      // Only geography is reused here. Approximate latency from the old planner
      // is not evidence for this endpoint's measured latency requirements.
      const geography = regionInfo(offer.provider, offer.region);
      if (!geography) reasons.push("residency: the offer's geography is unverified for the manifest's residency requirement");
      else if (!regionSatisfiesResidency(geography, placement.residency)) reasons.push("residency: the offer does not satisfy the manifest's residency requirement");
    }
    if (reasons.length) policyRejections[offer.id] = reasons;
  }
  const connectedProviders = [...new Set((await placementReads.connections(caller.workspaceId))
    .filter((connection) => connection.workspaceId === caller.workspaceId && connection.verified)
    .map((connection) => connection.provider).filter(isComputeProvider))].sort();
  const result = recommendCompute(catalog, boundedInput, {
    now: new Date().toISOString(), connectedProviders, policyRejections,
  });
  return { body: {
    workspaceId: caller.workspaceId,
    projectId: project.id,
    environmentId: env.id,
    policy: {
      ...(budgetUsdMonthly !== undefined ? { budgetUsdMonthly } : {}),
      ...(placement?.provider && placement.provider !== "auto" ? { provider: placement.provider } : {}),
      ...(placement?.regions.length ? { regions: placement.regions } : {}),
      ...(placement?.residency?.length ? { residency: placement.residency } : {}),
      scope: "compute_only",
      note: "These limits screen VM discovery estimates. They do not establish full-environment budget, availability, or deployment eligibility.",
    },
    result,
  } };
});
