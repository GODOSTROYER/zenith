/**
 * Build runners — the only place a submission is ever compiled.
 *
 * One recipe (`RECIPE_V1`), three boundaries. Whichever runs, the same
 * `recipe-worker.mjs` executes the same `recipeInlineConfig`, no submitted
 * script or configuration is loaded, and nothing is installed from the source.
 *
 *   recipe.ts              the pinned recipe, its config and its job shape
 *   recipe-config.mjs      the single definition of the Vite InlineConfig
 *   recipe-worker.mjs      the process that compiles, wherever it is run
 *   runner-recipe-local.ts child process on the control host (process boundary)
 *   runner-e2b.ts          disposable remote sandbox (unverified live)
 *   runner-docker.ts       throwaway container (unverified live)
 *   registry.ts            which runner this install selected, and its status
 *
 * Workstream W2 (hosted R3).
 */
export {
  RECIPE_ALIAS_SPECIFIERS,
  RECIPE_INSTALL_ARGS,
  RECIPE_PACKAGES,
  RECIPE_V1,
  RECIPE_WORKER_RELATIVE,
  foreignModules,
  missingRecipePackages,
  platformRoot,
  recipeAllowedReads,
  recipeConfig,
  recipeJob,
  recipeWorkerPath,
  type RecipeJob,
  type RecipeWorkerResult,
} from "./recipe";
export {
  FORBIDDEN_ENV_PREFIXES,
  RecipeLocalRunner,
  buildChildEnv,
  killTree,
  secretEnvKeys,
  type RecipeLocalOptions,
} from "./runner-recipe-local";
export {
  E2bRunner,
  SANDBOX_OUT,
  SANDBOX_ROOT,
  SANDBOX_SOURCE,
  defaultSandboxFactory,
  type E2bOptions,
  type RecipeSandbox,
  type SandboxFactory,
} from "./runner-e2b";
export {
  CONTAINER_OUT,
  CONTAINER_SOURCE,
  DockerRunner,
  RECIPE_IMAGE,
  dockerRunArgs,
  type DockerOptions,
  type SpawnFn,
} from "./runner-docker";
export { NO_RUNNER_REASON, buildRunnerStatus, buildRunners, selectedBuildRunner } from "./registry";
