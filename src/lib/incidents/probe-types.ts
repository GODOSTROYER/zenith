/**
 * The shape of a probe: a fixed, read-only check of one hop that returns
 * evidence. A probe never throws to its caller and never mutates anything; if
 * it does throw or overrun its time box, the runner reports every check it
 * declares in `checks` as `unknown` evidence. "We could not tell" is a value.
 */
import type { ProbeContext } from "./probe-context";
import type { PathStep, RequestPath } from "./traverse";
import type { Evidence, Hop } from "./types";

export interface Probe {
  /** stable id */
  id: string;
  hop: Hop;
  /** every check name this probe can emit: the `unknown` fallback reports each one */
  checks: readonly string[];
  run(step: PathStep, ctx: ProbeContext, path: RequestPath): Promise<Evidence[]>;
}

/** A probe that is about the whole investigation rather than one hop (changes, drift, end-to-end HTTP). */
export interface GlobalProbe {
  id: string;
  hop: Hop;
  checks: readonly string[];
  /** the address the fallback `unknown` evidence is attached to, when one applies */
  address?: string;
  run(ctx: ProbeContext, path: RequestPath): Promise<Evidence[]>;
}
