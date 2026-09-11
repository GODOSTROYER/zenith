/**
 * Artifacts — immutable, content-addressed, and verified before release.
 *
 *   store.ts          FsArtifactStore: create-only, sha256-keyed, re-checkable
 *   storage-store.ts  the same store over object storage, for hosted installs
 *   publisher.ts      the trusted check a release must pass before it may activate
 */
export {
  ARTIFACT_CONTENT_TYPES,
  FsArtifactStore,
  artifactContentType,
  artifactDigest,
  artifactPath,
  walkOutput,
  type ArtifactManifest,
} from "./store";
export {
  StorageArtifactStore,
  artifactManifestKey,
  artifactObjectKey,
  type ByteRange,
  type StorageStoreOptions,
} from "./storage-store";
export { verifyForRelease, type PublisherVerdict, type ReleaseExpectation } from "./publisher";
