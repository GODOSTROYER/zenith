/**
 * The URL name rule, said in words. `isValidAppSlug` is the contract; this
 * turns a rejection into the one sentence that tells a builder what to change,
 * and derives a first guess from the app's name.
 *
 * Pure — no React, no fetch — so the new-app screen and its test share it.
 *
 * Workstream W9 (hosted R3)
 */
import { APP_SLUG_RE, RESERVED_SLUGS, isValidAppSlug } from "@/lib/hosted/contracts/hosts";

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** What a builder is allowed to type, in one line, shown under the field. */
export const SLUG_RULE = `${SLUG_MIN}–${SLUG_MAX} characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.`;

/**
 * A first URL name from the app's name: lowercase, spaces and punctuation
 * become single hyphens, and the result is trimmed to the length rule. Never
 * final — the field stays editable, and the rule check runs on what is typed.
 */
export function deriveSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return base;
}

/**
 * Why this URL name would be refused, or `undefined` when it is fine. One
 * problem at a time, most basic first, so the message changes as it is fixed.
 */
export function slugProblem(slug: string): string | undefined {
  if (!slug) return "Give the app a URL name — it becomes the first part of its address.";
  if (slug.length < SLUG_MIN)
    return `Use at least ${SLUG_MIN} characters. “${slug}” has ${slug.length}.`;
  if (slug.length > SLUG_MAX)
    return `Use at most ${SLUG_MAX} characters. This one has ${slug.length}.`;
  const bad = Array.from(new Set(slug.replace(/[a-z0-9-]/g, "").split(""))).join(" ");
  if (bad)
    return `Lowercase letters, digits and hyphens only — remove ${bad}. Capitals become lowercase automatically.`;
  if (!APP_SLUG_RE.test(slug))
    return "Start and end with a letter or a digit; hyphens go in the middle.";
  if (RESERVED_SLUGS.has(slug))
    return `“${slug}” is reserved for the platform's own hosts. Pick a different URL name.`;
  return undefined;
}

/** True when the contract would accept this URL name. */
export const slugAccepted = (slug: string): boolean => isValidAppSlug(slug);
