/**
 * Repository analysis: source -> requirements -> proposed architecture.
 *
 *   snapshotFromTarball / snapshotFromGithub / snapshotFromFiles   intake
 *   analyzeRepository(snapshot)              -> AppRequirements
 *   proposeArchitecture(requirements, intent) -> ArchitectureProposal (V1 Manifest)
 *
 * Deterministic and side-effect free once a snapshot exists. See each module's
 * header for its invariants; the shared contract is `./types`.
 */
export * from "./types";
export { snapshotFromTarball, snapshotFromFiles, checkEntryPath, classifyPath } from "./snapshot";
export { snapshotFromGithub, type GithubSnapshotRequest } from "./github";
export { analyzeRepository } from "./analyze";
export { proposeArchitecture } from "./propose";
