/**
 * How a deployment Output is presented, in one place, because the success
 * panel and the Deploys screen both show the same outputs and must not
 * disagree about what is real.
 *
 * The sandbox hands out a pretty hostname nothing answers on and a local
 * `/preview/…` path that does. Only `url` outputs are openable at all: a
 * connection string ("db.staging…:5432") has no scheme, so as an href the
 * browser resolves it against this app and lands on a 404.
 */
import type { Output } from "@/lib/domain/types";

/** Absolute form of a local path, so what lands on the clipboard is a link. */
export function absoluteHref(value: string, origin?: string): string {
  const base = origin ?? (typeof window === "undefined" ? undefined : window.location.origin);
  if (!base) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * `true` simulated, `false` real, `undefined` not known yet.
 *
 * The output's own flag wins when the provider sets one; an absent flag means
 * the provider did not say, which is not the same as "real", so the
 * environment's provider decides. Unknown stays unknown — a panel that
 * renders "Open" while the answer is still loading has claimed a fake address
 * is real for as long as the fetch takes.
 */
export function isSimulated(
  output: Pick<Output, "simulated">,
  envSimulated: boolean | undefined
): boolean | undefined {
  return output.simulated ?? envSimulated;
}

/** The only unqualified "Open" is one we know opens something real. */
export function openLabel(simulated: boolean | undefined): string {
  return simulated === false ? "Open" : "Open preview";
}

/** What Copy should put on the clipboard: never an address that will not resolve. */
export function copyTarget(
  output: Output,
  simulated: boolean | undefined,
  origin?: string
): { value: string; what: string } {
  const pretty = output.label.includes(" — ")
    ? output.label.slice(output.label.indexOf(" — ") + 3)
    : output.label;
  if (output.kind !== "url") return { value: output.value, what: `the ${output.kind} value` };
  if (simulated)
    return {
      value: absoluteHref(output.value, origin),
      what: "the preview link that opens this service",
    };
  return { value: pretty, what: "the address" };
}
