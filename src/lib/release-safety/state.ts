/**
 * The release pipeline state machine. Pure: it only says which transitions exist. The store
 * applies one with a compare-and-set on `version`, so two workers cannot both move a run.
 *
 *   planned -> built -> verified -> deployed -> migrated -> ready -> cut_over -> readback_verified
 *                          |  ^                                              \-> cut_over_unverified
 *                          v  |
 *                    blocked_approval          any non-terminal state -> failed | uncertain | refused
 *
 * `verified` means the digest passed provenance. A run cannot reach `deployed` without it, and
 * it cannot reach `deployed` from `blocked_approval` either: only an approval moves it back to
 * `verified`. A rollback of CODE (`rolled_back`) never implies anything about data.
 */
import { ReleaseSafetyError, TERMINAL_RELEASE_STATES, type ReleaseState } from "./types";

const FAILURE: readonly ReleaseState[] = ["failed", "uncertain", "refused"];

const NEXT: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = {
  planned: ["built", ...FAILURE],
  built: ["verified", ...FAILURE],
  verified: ["verified", "blocked_approval", "deployed", ...FAILURE],
  blocked_approval: ["blocked_approval", "verified", ...FAILURE],
  // `deployed` may repeat: each progressive traffic step is recorded as a transition to itself
  deployed: ["deployed", "migrated", "rolled_back", ...FAILURE],
  migrated: ["ready", "rolled_back", ...FAILURE],
  ready: ["cut_over", "rolled_back", ...FAILURE],
  cut_over: ["readback_verified", "cut_over_unverified", "rolled_back", ...FAILURE],
  readback_verified: ["rolled_back"],
  cut_over_unverified: ["rolled_back"],
  failed: [],
  uncertain: ["rolled_back", "failed"],
  rolled_back: [],
  refused: [],
};

export function canTransition(from: ReleaseState, to: ReleaseState): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: ReleaseState, to: ReleaseState): void {
  if (!canTransition(from, to)) throw new ReleaseSafetyError("invalid_transition", `A release cannot move from ${from} to ${to}.`);
}

export const isTerminal = (state: ReleaseState): boolean => TERMINAL_RELEASE_STATES.has(state);

/** States a run must have reached for its digest to count as "released" (served to all traffic). */
export const RELEASED: ReadonlySet<ReleaseState> = new Set<ReleaseState>(["cut_over", "readback_verified", "cut_over_unverified"]);
