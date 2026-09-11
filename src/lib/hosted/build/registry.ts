/**
 * Which build runners exist, which one this process is allowed to use, and what
 * each one honestly reports about itself.
 *
 * `ZENITH_BUILD_RUNNER` is the single switch. Its default (`none`) selects no
 * runner at all, so a hosted install that has not decided where builds happen
 * refuses to build rather than quietly falling back to the control host.
 */
import type { Availability, BuildRunner, BuildRunnerId } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { DockerRunner } from "./runner-docker";
import { E2bRunner } from "./runner-e2b";
import { RecipeLocalRunner } from "./runner-recipe-local";

/** Every runner the product knows about, in the order a screen should list them. */
export function buildRunners(): BuildRunner[] {
  return [new DockerRunner(), new E2bRunner(), new RecipeLocalRunner()];
}

/**
 * The runner `ZENITH_BUILD_RUNNER` selects, or `null` when it is `none`.
 *
 * Selection is not permission: the returned runner still answers
 * `availability()` with what it is actually missing.
 */
export function selectedBuildRunner(): BuildRunner | null {
  const selected = hostedConfig().ZENITH_BUILD_RUNNER;
  if (selected === "none") return null;
  return buildRunners().find((runner) => runner.id === (selected as BuildRunnerId)) ?? null;
}

/** One row per runner for a status screen: what it is, what it isolates, and whether it can run. */
export async function buildRunnerStatus(): Promise<
  { id: BuildRunnerId; label: string; boundary: string; availability: Availability }[]
> {
  return Promise.all(
    buildRunners().map(async (runner) => ({
      id: runner.id,
      label: runner.label,
      boundary: runner.boundary,
      availability: await runner.availability(),
    }))
  );
}

/** Why no build can run right now, when nothing is selected. Names the variable and the options. */
export const NO_RUNNER_REASON =
  "ZENITH_BUILD_RUNNER is not set, so this install has not decided where builds run and refuses to build. Set it to docker (a throwaway container), e2b (a disposable remote sandbox, needs E2B_API_KEY) or recipe-local (a child process on this control host, which is a process boundary and not a hostile-code sandbox).";
