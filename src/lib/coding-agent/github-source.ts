/**
 * Exact, independently authorized repository input for Gimbal. Every access,
 * including a cache hit, rechecks the pinned provider identity and binding
 * version. Raw archives are never persisted; the bounded cache holds only the
 * redacted analysis view and is separate from build source custody.
 */
import type { Sql } from "@/lib/controlplane/types";
import { snapshotFromGithub, type RepoSnapshot } from "@/lib/analysis";
import { createGithubImmutableSourceAccess } from "@/lib/sources/github/runtime";
import { createGithubContextVerifier, normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { createGithubSourceStore, type GithubBindingState } from "@/lib/sources/github/store";
import { GithubSourceError, repository, type GithubImmutableSource } from "@/lib/sources/github/types";
import type { SourceReader, SourceRequest, SourceResolver } from "./service";
import type { AgentSourceRef } from "./types";
import { redactedSnapshot, SOURCE_REDACTION_VERSION } from "./redaction";

const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_TTL = 5 * 60_000;

/** The grant inspected before resolution must still be the grant that pinned the commit. */
function assertSameGrant(state: GithubBindingState | undefined, identity: GithubImmutableSource): void {
  const binding = state?.binding, pinned = identity.binding;
  if (!binding && pinned || binding && (!pinned || binding.appId !== pinned.appId || binding.installationId !== pinned.installationId || binding.repositoryId !== pinned.repositoryId || binding.version !== pinned.version)) throw new GithubSourceError("conflict");
}

export function createGithubSource(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }): { read: SourceReader; resolve: SourceResolver; assertLocalAccess: (request: SourceRequest) => Promise<void> } {
  const access = createGithubImmutableSourceAccess(deps);
  const verifyContext = createGithubContextVerifier(deps);
  const cache = new Map<string, { snapshot: RepoSnapshot; bytes: number; expiresAt: number }>();

  async function authorize(request: SourceRequest) {
    const parts = request.repository.split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const location = repository(parts[0], parts[1]);
    const root = normalizeInspectionRoot(request.root);
    const store = createGithubSourceStore(await deps.db());
    const state = await store.getState(request.workspaceId,
      request.bindingId ? { bindingId: request.bindingId } : location);
    if (state?.revoked) throw new GithubSourceError("refused");
    if (state && (state.binding.owner !== location.owner || state.binding.repo !== location.repo)) throw new GithubSourceError("refused");
    if (request.bindingId && state?.bindingId !== request.bindingId) throw new GithubSourceError("refused");
    if (request.bindingVersion !== undefined && state?.binding.version !== request.bindingVersion) throw new GithubSourceError("conflict");
    if (request.repositoryId !== undefined && state?.binding.repositoryId !== request.repositoryId && request.accessKind !== "public") throw new GithubSourceError("conflict");
    if (!state && request.accessKind !== "public" && request.expected?.binding !== null) throw new GithubSourceError("refused", "Select an authorized repository or explicitly select public access.");
    const publicSource = request.accessKind === "public" || request.expected?.binding === null;
    const pinnedId = request.repositoryId ?? request.expected?.repositoryId;
    if (publicSource && (state || pinnedId !== undefined && await store.getState(request.workspaceId, { repositoryId: pinnedId }))) throw new GithubSourceError("refused", "This repository has a workspace binding; use its current authorization.");
    return { location, root, state };
  }

  const resolve: SourceResolver = async request => {
    const { location, root, state } = await authorize(request);
    return access({ ...location, workspaceId: request.workspaceId, ref: request.ref, signal: request.signal, accessKind: request.accessKind, ...(request.expected ? { expected: request.expected } : {}) }, async identity => {
      assertSameGrant(state, identity);
      if (request.repositoryId !== undefined && identity.repositoryId !== request.repositoryId) throw new GithubSourceError("conflict");
      const contextDir = normalizeInspectionRoot(request.contextDir);
      if (request.contextDigest && (!request.dockerfile || !await verifyContext({
        workspaceId: request.workspaceId, repository: request.repository, commitSha: identity.commitSha,
        contextDir, dockerfile: request.dockerfile, contextDigest: request.contextDigest, signal: request.signal,
      }))) throw new GithubSourceError("refused", "The inspected build context changed. Inspect this commit again.");
      if (contextDir && !request.contextDigest) throw new GithubSourceError("invalid", "A subdirectory build context requires a verified inspection.");
      return {
        repository: identity.owner + "/" + identity.repo, commit: identity.commitSha, sourceIdentity: identity,
        repositoryId: identity.repositoryId, ...(root ? { root } : {}),
        ...(state ? { bindingId: state.bindingId, bindingVersion: state.binding.version } : {}),
        ...(request.contextDigest ? { contextDir, contextDigest: request.contextDigest, dockerfile: request.dockerfile } : {}),
      };
    });
  };

  const read: SourceReader = async (request, consume) => {
    const { location, root, state } = await authorize(request);
    if (!request.expected) throw new GithubSourceError("refused", "This legacy run has no pinned source authorization. Start a new analysis.");
    const acquired = await access({ ...location, workspaceId: request.workspaceId, ref: request.ref, expected: request.expected, signal: request.signal, accessKind: request.accessKind }, async (identity, token, acquisitionSignal) => {
      assertSameGrant(state, identity);
      const key = JSON.stringify([request.workspaceId, identity, SOURCE_REDACTION_VERSION]);
      for (const [k, value] of cache) if (value.expiresAt < Date.now()) cache.delete(k);
      let entry = cache.get(key);
      if (!entry) {
        const full = await snapshotFromGithub({ owner: identity.owner, repo: identity.repo, ref: identity.commitSha, token,
          fetchImpl: deps.fetchImpl, timeoutMs: 45_000, includeEvidence: true, signal: acquisitionSignal ?? request.signal });
        // Analyze the complete retained workspace so shared-library dependencies remain visible.
        // requirementsForRoot selects the requested application's services after static analysis.
        const snapshot = redactedSnapshot(full);
        const bytes = snapshot.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
        let total = [...cache.values()].reduce((n, e) => n + e.bytes, 0);
        while (cache.size && (cache.size >= 6 || total + bytes > CACHE_BYTES)) {
          const first = cache.keys().next().value!;
          total -= cache.get(first)!.bytes;
          cache.delete(first);
        }
        entry = { snapshot, bytes, expiresAt: Date.now() + CACHE_TTL };
        if (bytes <= CACHE_BYTES) cache.set(key, entry);
      }
      const ref: AgentSourceRef = {
        repository: identity.owner + "/" + identity.repo, commit: identity.commitSha, sourceIdentity: identity,
        repositoryId: identity.repositoryId, ...(root ? { root } : {}),
        ...(state ? { bindingId: state.bindingId, bindingVersion: state.binding.version } : {}),
        ...(request.contextDigest ? { contextDir: request.contextDir ?? "", contextDigest: request.contextDigest, dockerfile: request.dockerfile } : {}),
      };
      return { snapshot: entry.snapshot, ref };
    });
    // A repository download deadline must never abandon an in-flight paid model
    // call. Only redacted data leaves the credential/deadline scope; the worker
    // owns model cancellation and rechecks authority before each checkpoint and
    // proposal. Preserve consumer control-flow errors (including RunSuperseded).
    const result = await consume(acquired.snapshot, acquired.ref);
    // Consumers other than the durable worker also retain a fresh authorization
    // check before their result is released, with a new source-only deadline.
    await resolve({ ...request, ref: acquired.ref.commit, expected: acquired.ref.sourceIdentity });
    return result;
  };
  return { read, resolve, assertLocalAccess: async request => { await authorize(request); } };
}
