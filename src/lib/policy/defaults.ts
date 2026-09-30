/**
 * Workspace policy parameters: defaults and validated merging (ADR-0008).
 *
 * The workspace-tunable knobs (approved regions, cost threshold, two-person
 * rule, auto-remediation classes, denied capabilities) are data, not code. A
 * workspace stores only what it changed; `resolveWorkspacePolicy` merges that
 * over `DEFAULT_WORKSPACE_POLICY`, validates it, and returns the complete,
 * canonical parameters the broker puts in `PolicyInput.workspacePolicy`.
 *
 * Canonical means equal policies produce equal values: region and capability
 * lists are de-duplicated and sorted, so the policy input digest does not
 * depend on the order a person happened to add things.
 *
 * Invalid configuration throws `PolicyConfigError`. It never "corrects" a
 * value silently: an unknown key, an unknown capability name (a typo that
 * would otherwise deny nothing), or an empty region list is refused loudly.
 */
import { z } from "zod";
import { isCapability } from "@/lib/capabilities/catalog";
import { RegionSchema } from "./schema";
import { DEFAULT_WORKSPACE_POLICY, type EnvironmentClass, type WorkspacePolicyParams } from "./types";

export { DEFAULT_WORKSPACE_POLICY };

export class PolicyConfigError extends Error {
  readonly code = "policy_config_invalid";
  constructor(readonly issues: string[]) {
    super(`Invalid workspace policy: ${issues.join("; ")}`);
  }
}

type AutoRemediationMode = WorkspacePolicyParams["autoRemediation"][EnvironmentClass];

/** What a workspace may override; every field optional, `null` clears an optional field. */
export interface WorkspacePolicyOverrides {
  approvedRegions?: string[] | null;
  costApprovalThresholdUsd?: number;
  budgetUsdMonthly?: number | null;
  allowEscapeHatchInProduction?: boolean;
  twoPersonProduction?: boolean;
  autoRemediation?: Partial<Record<EnvironmentClass, AutoRemediationMode>>;
  deniedCapabilities?: string[];
}

const mode = z.enum(["none", "safe", "any"]);

const OverridesSchema = z
  .object({
    approvedRegions: z
      .array(RegionSchema)
      .min(1, "list at least one region, or leave approvedRegions unset for no restriction")
      .max(200)
      .nullish(),
    costApprovalThresholdUsd: z.number().finite().min(0).max(1e12).optional(),
    budgetUsdMonthly: z.number().finite().positive().max(1e12).nullish(),
    allowEscapeHatchInProduction: z.boolean().optional(),
    twoPersonProduction: z.boolean().optional(),
    autoRemediation: z
      .object({
        sandbox: mode.optional(),
        development: mode.optional(),
        staging: mode.optional(),
        production: mode.optional(),
      })
      .strict()
      .optional(),
    deniedCapabilities: z.array(z.string().min(1).max(100)).max(500).optional(),
  })
  .strict();

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/**
 * Merge `overrides` over the defaults and validate. `undefined`/`null` overrides
 * mean "all defaults".
 */
export function resolveWorkspacePolicy(overrides?: WorkspacePolicyOverrides | null): WorkspacePolicyParams {
  const parsed = OverridesSchema.safeParse(overrides ?? {});
  if (!parsed.success) {
    throw new PolicyConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  const o = parsed.data;

  const unknownCapabilities = (o.deniedCapabilities ?? []).filter((name) => !isCapability(name));
  if (unknownCapabilities.length > 0) {
    throw new PolicyConfigError([`deniedCapabilities: unknown capability name(s): ${unknownCapabilities.join(", ")}`]);
  }

  const resolved: WorkspacePolicyParams = {
    costApprovalThresholdUsd: o.costApprovalThresholdUsd ?? DEFAULT_WORKSPACE_POLICY.costApprovalThresholdUsd,
    allowEscapeHatchInProduction: o.allowEscapeHatchInProduction ?? DEFAULT_WORKSPACE_POLICY.allowEscapeHatchInProduction,
    twoPersonProduction: o.twoPersonProduction ?? DEFAULT_WORKSPACE_POLICY.twoPersonProduction,
    autoRemediation: {
      sandbox: o.autoRemediation?.sandbox ?? DEFAULT_WORKSPACE_POLICY.autoRemediation.sandbox,
      development: o.autoRemediation?.development ?? DEFAULT_WORKSPACE_POLICY.autoRemediation.development,
      staging: o.autoRemediation?.staging ?? DEFAULT_WORKSPACE_POLICY.autoRemediation.staging,
      production: o.autoRemediation?.production ?? DEFAULT_WORKSPACE_POLICY.autoRemediation.production,
    },
    deniedCapabilities: sortedUnique(o.deniedCapabilities ?? DEFAULT_WORKSPACE_POLICY.deniedCapabilities),
  };
  if (o.approvedRegions) resolved.approvedRegions = sortedUnique(o.approvedRegions);
  else if (o.approvedRegions === undefined && DEFAULT_WORKSPACE_POLICY.approvedRegions) {
    resolved.approvedRegions = sortedUnique(DEFAULT_WORKSPACE_POLICY.approvedRegions);
  }
  const budget = o.budgetUsdMonthly === undefined ? DEFAULT_WORKSPACE_POLICY.budgetUsdMonthly : o.budgetUsdMonthly;
  if (budget !== undefined && budget !== null) resolved.budgetUsdMonthly = budget;
  return resolved;
}
