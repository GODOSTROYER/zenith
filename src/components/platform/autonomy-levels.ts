/**
 * The six autonomy levels (ADR-0007) in plain language.
 *
 * Autonomy is per environment, 0 to 5. It sets the lowest level at which a
 * capability may run WITHOUT a human approval; policy can still demand an approval
 * at any level (production network changes, cost thresholds, data loss), and the
 * capability catalog marks some actions as never automatic (destroying
 * infrastructure, deleting data, identity changes, arbitrary commands). The
 * descriptions below say what a level adds and do not promise more than the
 * catalog and policy grant.
 */
import type { AutonomyLevel } from "@/lib/policy/types";

export interface AutonomyLevelInfo {
  level: AutonomyLevel;
  name: string;
  /** one sentence, what Zenith and connected agents may do at this level */
  summary: string;
}

export const AUTONOMY_LEVELS: readonly AutonomyLevelInfo[] = [
  {
    level: 0,
    name: "Observe",
    summary: "Read only. Zenith and connected agents can look at your infrastructure but cannot propose or run changes.",
  },
  {
    level: 1,
    name: "Recommend",
    summary: "Zenith can analyse, plan and recommend changes. It does not queue or run any of them.",
  },
  {
    level: 2,
    name: "Plan with approval",
    summary: "Zenith prepares exact proposals. A person must approve each one before anything changes.",
  },
  {
    level: 3,
    name: "Safe automatic",
    summary:
      "Low-risk changes such as restarting or scaling a service, or taking a database snapshot, run on their own. Anything riskier still needs approval.",
  },
  {
    level: 4,
    name: "Bounded operations",
    summary:
      "Routine operations such as deploys, rollbacks and drift repair run on their own within policy limits. Changes outside those limits still need approval.",
  },
  {
    level: 5,
    name: "Broad autonomy",
    summary:
      "Most changes, including applying infrastructure plans, run without waiting, within the limits policy sets. Destroying infrastructure, deleting data, changing identity and running arbitrary commands still need approval.",
  },
];

export const AUTONOMY_POLICY_NOTE =
  "Policy can still require approval at any level, and every action is recorded in the audit trail whatever the level.";

export function autonomyInfo(level: AutonomyLevel): AutonomyLevelInfo {
  return AUTONOMY_LEVELS[level];
}
