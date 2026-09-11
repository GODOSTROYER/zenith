/**
 * Artifacts — immutable, content-addressed, and verified before release.
 *
 *   store.ts      FsArtifactStore: create-only, sha256-keyed, re-checkable
 *   publisher.ts  the trusted check a release must pass before it may activate
 */
export {
  ARTIFACT_CONTENT_TYPES,
  FsArtifactStore,
  artifactContentType,
  artifactDigest,
  artifactPath,
  type ArtifactManifest,
} from "./store";
export { verifyForRelease, type PublisherVerdict, type ReleaseExpectation } from "./publisher";
