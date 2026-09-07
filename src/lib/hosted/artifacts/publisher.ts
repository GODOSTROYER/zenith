/**
 * The trusted publisher check.
 *
 * A successful build is not permission to activate anything. Before a release
 * may point at an artifact, this step — deliberately separate from the build,
 * and reading only what is on disk — recomputes the artifact's bytes and
 * compares its recorded provenance with what the release claims: the pinned
 * source digest, the job that asked for it, and the exact recipe versions.
 *
 * A mismatch is refused with a sentence naming which field disagreed. Nothing
 * here trusts a runner's word for anything.
 *
 * Workstream W2 (hosted R3).
 */
import type { Artifact, ArtifactStore, RecipeSpec } from "@/lib/hosted/contracts";
import { FsArtifactStore } from "./store";

/** What a release says the artifact must be, checked field by field. */
export interface ReleaseExpectation {
  sourceDigest: string;
  jobId: string;
  recipe: RecipeSpec;
}

export interface PublisherVerdict {
  ok: boolean;
  /** one sentence: what was checked, or which field disagreed */
  detail: string;
  /** the stored record, carrying `verifiedAt` when the check passed */
  artifact?: Artifact;
}

const recipeDifferences = (expected: RecipeSpec, actual: RecipeSpec): string[] => {
  const keys: (keyof RecipeSpec)[] = ["id", "vite", "pluginReact", "react", "node"];
  return keys
    .filter((key) => expected[key] !== actual[key])
    .map((key) => `recipe.${key} is "${actual[key]}", the release expects "${expected[key]}"`);
};

/**
 * Verify an artifact against what a release claims about it.
 *
 * On success the store records `verifiedAt` on the manifest — metadata beside
 * the artifact, never inside the `files/` tree the digest covers — so the fact
 * that a trusted step checked these bytes survives a restart.
 */
export async function verifyForRelease(
  store: ArtifactStore,
  digest: string,
  expected: ReleaseExpectation
): Promise<PublisherVerdict> {
  const artifact = await store.get(digest);
  if (!artifact)
    return { ok: false, detail: `No artifact ${digest} is stored, so no release may reference it.` };

  const bytes = await store.verify(digest);
  if (!bytes.ok) return { ok: false, detail: `The stored bytes do not match the manifest: ${bytes.detail}`, artifact };

  const provenance = artifact.provenance;
  const problems: string[] = [];
  if (provenance.sourceDigest !== expected.sourceDigest)
    problems.push(
      `the artifact was built from source ${provenance.sourceDigest}, the release expects ${expected.sourceDigest}`
    );
  if (provenance.jobId !== expected.jobId)
    problems.push(`the artifact was built by job ${provenance.jobId}, the release expects ${expected.jobId}`);
  problems.push(...recipeDifferences(expected.recipe, provenance.recipe));
  if (provenance.contractVersion !== 1)
    problems.push(`the artifact records source contract version ${provenance.contractVersion}, not 1`);
  if (provenance.schemaVersion !== 1)
    problems.push(`the artifact records data schema version ${provenance.schemaVersion}, not 1`);

  if (problems.length > 0)
    return {
      ok: false,
      detail: `Provenance does not match the release: ${problems.join("; ")}.`,
      artifact,
    };

  const stamped = store instanceof FsArtifactStore ? store.markVerified(digest) : null;
  return {
    ok: true,
    detail: `${bytes.detail} Built by ${provenance.builtBy} from source ${provenance.sourceDigest} for job ${provenance.jobId} with recipe ${provenance.recipe.id}.`,
    artifact: stamped ?? artifact,
  };
}
