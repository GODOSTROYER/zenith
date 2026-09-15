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
 */
export {
  RECIPE_ALIAS_SPECIFIERS,
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
  HOSTED_ACK_ENV,
  RecipeLocalRunner,
  buildChildEnv,
  killTree,
  secretEnvKeys,
  unsandboxedBuildsAcknowledged,
  type RecipeLocalOptions,
} from "./runner-recipe-local";
export {
  ATTESTATION_KEY_ID_ENV,
  ATTESTATION_SCHEME,
  E2bRunner,
  SANDBOX_KILL_TIMEOUT_MS,
  SANDBOX_OUT,
  SANDBOX_ROOT,
  SANDBOX_SOURCE,
  TEMPLATE_ATTESTATION,
  attestationKeyId,
  templateAttestationPayload,
  defaultSandboxFactory,
  type E2bOptions,
  type RecipeSandbox,
  type SandboxFactory,
  type TemplateAttestation,
} from "./runner-e2b";
export {
  CONTAINER_OUT,
  CONTAINER_SOURCE,
  DockerRunner,
  RECIPE_IMAGE_ENV,
  dockerRunArgs,
  resolveRecipeImage,
  type DockerOptions,
  type RecipeImage,
  type SpawnFn,
} from "./runner-docker";
export { NO_RUNNER_REASON, buildRunnerStatus, buildRunners, selectedBuildRunner } from "./registry";
