/**
 * The eight publish phases, one file each, behind the map `runPublish` drives.
 *
 * The *order* is not here: it is `PUBLISH_PHASES` in `../publish.ts`, which is
 * also what `resumeFrom` indexes into. This file only answers "which function
 * runs this phase", so adding a phase means adding it to that array and to
 * this map, and nothing else in the pipeline changes.
 *
 * Every handler takes the claimed job and the job's durable phase data, writes
 * only to its own records, and is safe to re-enter: each skips itself when its
 * output is already recorded, because a resumed job re-runs the phase that was
 * in flight when the last worker stopped.
 *
 * Workstream W7 (hosted R3).
 */
import type { PublishPhase } from "../publish";
import type { JobRun, PhaseData } from "../shared";
import { intake } from "./intake";
import { build } from "./build";
import { storeArtifact } from "./artifact";
import { verifyArtifact } from "./verify-artifact";
import { stage } from "./stage";
import { probe } from "./probe";
import { activate } from "./activate";
import { cleanup } from "./cleanup";

/**
 * What one phase does. `stage` answers with the candidate release id it
 * recorded; every other phase writes what it learned into `data` and answers
 * nothing.
 */
export type PhaseHandler = (run: JobRun, data: PhaseData) => Promise<string | void>;

/** Which function runs each phase. The order lives in `PUBLISH_PHASES`. */
export const PUBLISH_PHASE_HANDLERS: Record<PublishPhase, PhaseHandler> = {
  intake,
  build,
  artifact: storeArtifact,
  verify_artifact: verifyArtifact,
  stage,
  probe,
  activate,
  cleanup,
};

export { intake, build, storeArtifact, verifyArtifact, stage, probe, activate, cleanup };
