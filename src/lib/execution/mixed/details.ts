/**
 * What an approver reads for a mixed parent proposal. The proposal input itself is
 * what the approval binds (it is part of the proposal digest); these lines only
 * make that input visible: the plan id, the child set digest and, per child in
 * order, its environment and the digests the approval pins. Defensive about shape:
 * anything that is not exactly a mixed parent input yields no lines.
 */
import { MIXED_PARENT_INPUT_KEY, MIXED_PARENT_REVIEW_KEY } from "./types";

const HEX = /^[a-f0-9]{64}$/;

function reviewDetails(value: Record<string, unknown>): string[] {
  if (typeof value.requiredParentDigest !== "string" || !HEX.test(value.requiredParentDigest) || typeof value.previousParentDigest !== "string" || !HEX.test(value.previousParentDigest)
    || typeof value.childSetDigest !== "string" || !HEX.test(value.childSetDigest) || !Array.isArray(value.consumers)) return [];
  const lines = [
    `Review of a changed mixed-cloud parent plan (run ${String(value[MIXED_PARENT_REVIEW_KEY]).slice(0, 80)}): outputs produced by an earlier child changed what later children will do.`,
    `Approving this approves ONLY parent digest ${value.requiredParentDigest.slice(0, 16)} (was ${value.previousParentDigest.slice(0, 16)}) for the original child set ${value.childSetDigest.slice(0, 16)}. It starts nothing by itself.`,
  ];
  for (const consumer of value.consumers.slice(0, 16)) {
    if (!consumer || typeof consumer !== "object") continue;
    const c = consumer as Record<string, unknown>;
    if (typeof c.childId !== "string" || typeof c.previousEffectDigest !== "string" || typeof c.newEffectDigest !== "string") continue;
    lines.push(`Child ${c.childId.slice(0, 80)}: effect ${c.previousEffectDigest.slice(0, 12)} becomes ${c.newEffectDigest.slice(0, 12)}`);
  }
  return lines;
}

export function mixedProposalDetails(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const value = input as Record<string, unknown>;
  if (typeof value[MIXED_PARENT_REVIEW_KEY] === "string") return reviewDetails(value);
  const planId = value[MIXED_PARENT_INPUT_KEY];
  if (typeof planId !== "string" || typeof value.childSetDigest !== "string" || !HEX.test(value.childSetDigest) || !Array.isArray(value.children)) return [];
  const lines = [
    `Mixed-cloud parent plan ${planId.slice(0, 80)}: approving it approves exactly this ordered set of ${value.children.length} child plan(s).`,
    `Child set digest ${value.childSetDigest.slice(0, 16)}; each child still needs its own approval and runs only after the one before it succeeded.`,
  ];
  for (const child of value.children.slice(0, 16)) {
    if (!child || typeof child !== "object") continue;
    const c = child as Record<string, unknown>;
    if (typeof c.ordinal !== "number" || typeof c.childEnvironmentId !== "string" || typeof c.subplanDigest !== "string" || typeof c.semanticsDigest !== "string") continue;
    lines.push(`Child ${c.ordinal + 1}: environment ${c.childEnvironmentId.slice(0, 80)}, subplan ${c.subplanDigest.slice(0, 12)}, semantics ${c.semanticsDigest.slice(0, 12)}`);
  }
  return lines;
}
