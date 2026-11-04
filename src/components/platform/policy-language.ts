/**
 * Plain-language renderings of a policy decision's parts. Pure; `import type`
 * only. The codes the policy engine emits (`prod_db_delete_denied`,
 * `maxWindowHours`) are stable identifiers for machines: they are shown only in a
 * disclosure, beside the human `message` the rule itself supplied.
 */
import type { ApprovalRequirement, PolicyOutcome } from "@/lib/controlplane/types";
import type { ChipTone } from "@/components/ui/chip";
import { formatScalar, humanizeToken } from "./text";

export const OUTCOME_PRESENTATION: Record<PolicyOutcome, { label: string; tone: ChipTone; sentence: string }> = {
  allow: { label: "Allowed", tone: "ok", sentence: "Policy allows this change to go ahead." },
  deny: {
    label: "Blocked",
    tone: "err",
    sentence: "Policy does not allow this change. It cannot be approved or run.",
  },
  require_approval: {
    label: "Needs approval",
    tone: "warn",
    sentence: "Policy allows this change only after a person approves it.",
  },
};

/** "1 person with the editor role or higher must approve it." */
export function describeApprovalRequirement(req: ApprovalRequirement): string {
  const who =
    req.count === 1
      ? `1 person with the ${req.minRole} role or higher must approve it.`
      : `${req.count} different people, each with the ${req.minRole} role or higher, must approve it.`;
  return req.separationOfDuties ? `${who} The person who requested the change cannot be one of them.` : who;
}

function seconds(n: number): string {
  if (n % 3600 === 0 && n >= 3600) return `${n / 3600} ${n === 3600 ? "hour" : "hours"}`;
  if (n % 60 === 0 && n >= 60) return `${n / 60} ${n === 60 ? "minute" : "minutes"}`;
  return `${n} ${n === 1 ? "second" : "seconds"}`;
}

function bytes(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}

export interface ConstraintLine {
  key: string;
  /** the limit as a sentence */
  sentence: string;
  /** the exact value, for the disclosure */
  value: string;
}

const KNOWN: Record<string, (n: number) => string> = {
  maxLines: (n) => `At most ${n} log lines can be read per request.`,
  maxWindowHours: (n) => `Logs can only be read from the last ${n} ${n === 1 ? "hour" : "hours"}.`,
  timeoutSec: (n) => `Each command is stopped after ${seconds(n)}.`,
  maxOutputBytes: (n) => `Command output is capped at ${bytes(n)}.`,
  grantDurationSec: (n) => `Access for this operation lasts at most ${seconds(n)}.`,
};

/** Every constraint as a sentence. Unknown keys still get a readable line, never a bare key. */
export function describeConstraints(constraints: Record<string, unknown> | undefined): ConstraintLine[] {
  if (!constraints) return [];
  return Object.entries(constraints)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => {
      const known = Object.prototype.hasOwnProperty.call(KNOWN, key) ? KNOWN[key] : undefined;
      const sentence =
        known && typeof value === "number" && Number.isFinite(value)
          ? known(value)
          : `Limit on ${humanizeToken(key).toLowerCase()}: ${formatScalar(value, 120)}.`;
      return { key, sentence, value: formatScalar(value, 200) };
    });
}
