/**
 * Static source inspection for a bound (private) or public GitHub repository.
 *
 * What it does: resolves the ref to an immutable commit through the binding-aware immutable
 * access (installation token scoped to the ONE bound repository, contents:read, minted per call),
 * downloads the commit tarball through the bounded intake reader, and runs the existing static
 * analysis (roots, Dockerfile reader, manifests) over file TEXT. Monorepo subdirectories,
 * Dockerfile and buildpack strategies are DETECTED from file names and contents only.
 *
 * What it never does: write the tree to disk, run a package manager, Dockerfile RUN lines, build
 * scripts, git hooks or any repository-supplied code on the control-plane host. Executing the
 * build is the isolated build executor's job; this module hands off identifiers only
 * (`buildSource` has the shape of the existing SourceBundle input: repo + exact commit + path).
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { analyzeRepository, snapshotFromGithub, type BuildPlan, type Confidence } from "@/lib/analysis";
import { createGithubImmutableSourceAccess } from "./runtime";
import { GithubSourceError, repository } from "./types";

export interface SourceInspectionRequest {
  workspaceId: string;
  environmentId?: string;
  owner: string;
  repo: string;
  /** Branch, tag or commit; resolved to an exact commit before any bytes are read. */
  ref: string;
  /** Optional monorepo subdirectory (repository-relative, no traversal). */
  root?: string;
  signal?: AbortSignal;
}
export interface BuildCandidate {
  root: string;
  strategy: BuildPlan["strategy"];
  dockerfile?: string;
  language?: string;
  needsDockerfile: boolean;
  confidence: Confidence;
  note: string;
}
export interface SourceInspection {
  owner: string;
  repo: string;
  repositoryId: number;
  commitSha: string;
  /** True when access went through a workspace GitHub App binding. */
  viaBinding: boolean;
  candidates: BuildCandidate[];
  selected?: BuildCandidate;
  monorepo: boolean;
  truncated: boolean;
  unknowns: string[];
  /** Input for the existing source/bundle interface. Present only for a Dockerfile build. */
  buildSource?: { repo: string; ref: string; dockerfile: string; contextDir: string; contextDigest: string };
  /** Always "static_only": nothing from the repository was executed here. */
  execution: "static_only";
}

/** The digest that binds a build context to one repository, commit, directory tree and Dockerfile blob. Shared by inspection and build admission. */
export function computeContextDigest(i: { repo: string; commit: string; contextDir: string; contextTree: string; dockerfile: string; dockerfileBlob: string }): string {
  return createHash("sha256").update(JSON.stringify({ repo: i.repo, commit: i.commit, contextDir: i.contextDir, contextTree: i.contextTree, dockerfile: i.dockerfile, dockerfileBlob: i.dockerfileBlob })).digest("hex");
}

const ROOT_SEGMENT = /^[A-Za-z0-9._@+-]{1,100}$/;
/** Canonical repository-relative directory or "" for the repository root. */
export function normalizeInspectionRoot(raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw === ".") return "";
  if (typeof raw !== "string" || raw.length > 200 || raw.startsWith("/") || raw.includes("\\")) throw new GithubSourceError("invalid");
  const parts = raw.replace(/\/+$/, "").split("/");
  if (parts.length > 12 || parts.some(part => !ROOT_SEGMENT.test(part) || part === "." || part === "..")) throw new GithubSourceError("invalid");
  return parts.join("/");
}

/** Walk the pinned commit tree one directory at a time. Returns the tree sha of the directory, or the blob mode for a file. */
async function walkTree(location: { owner: string; repo: string }, commitSha: string, path: string, kind: "tree" | "blob", token: string | undefined, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  let sha = commitSha;
  const parts = path === "" ? [] : path.split("/");
  const refuse = (reason: string): never => { throw new GithubSourceError("refused", reason); };
  for (let i = 0; i <= parts.length; i++) {
    const response = await fetchImpl(`https://api.github.com/repos/${location.owner}/${location.repo}/git/trees/${sha}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "zenith-source-inspect", "X-GitHub-Api-Version": "2026-03-10", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: "error", signal });
    if (!response.ok || Number(response.headers.get("content-length")) > 8 * 1024 * 1024) return refuse("The repository tree at the pinned commit could not be read.");
    const tree = JSON.parse(await response.text()) as { truncated?: unknown; tree?: { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }[] };
    if (tree.truncated === true || !Array.isArray(tree.tree)) return refuse("A directory on the path is too large to verify.");
    if (i === parts.length) return sha;
    const entry = tree.tree.find(e => e.path === parts[i]);
    if (!entry) return refuse(`${parts.slice(0, i + 1).join("/")} does not exist at the pinned commit.`);
    if (entry.mode === "120000") return refuse(`${parts.slice(0, i + 1).join("/")} is a symbolic link.`);
    const last = i === parts.length - 1;
    if (last && kind === "blob") { if (entry.type !== "blob" || entry.mode === "160000" || typeof entry.sha !== "string") return refuse(`${path} is not a regular file.`); return entry.sha; }
    if (entry.type !== "tree" || typeof entry.sha !== "string" || !/^[a-f0-9]{40}$/.test(entry.sha)) return refuse(`${parts.slice(0, i + 1).join("/")} is not a directory.`);
    sha = entry.sha;
  }
  return sha;
}

export function createGithubSourceInspector(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }) {
  const access = createGithubImmutableSourceAccess(deps);
  return async function inspect(input: SourceInspectionRequest): Promise<SourceInspection> {
    const location = repository(input.owner, input.repo);
    const root = normalizeInspectionRoot(input.root);
    return access({ ...location, workspaceId: input.workspaceId, environmentId: input.environmentId, ref: input.ref, signal: input.signal }, async (identity, token) => {
      // The commit SHA, not the moving ref, is fetched: analysis describes exactly what a build would get.
      const snapshot = await snapshotFromGithub({ owner: identity.owner, repo: identity.repo, ref: identity.commitSha, token, fetchImpl: deps.fetchImpl, timeoutMs: 45_000 });
      const analysis = analyzeRepository(snapshot);
      const inside = (dir: string) => root === "" || dir === root || dir.startsWith(`${root}/`);
      const candidates: BuildCandidate[] = analysis.builds.filter(plan => inside(plan.value.root)).map(plan => ({
        root: plan.value.root, strategy: plan.value.strategy, ...(plan.value.dockerfile ? { dockerfile: plan.value.dockerfile } : {}),
        ...(plan.value.language ? { language: plan.value.language } : {}), needsDockerfile: plan.value.needsDockerfile, confidence: plan.confidence, note: plan.value.note,
      }));
      const unknowns = [...analysis.unknowns];
      const selected = candidates.find(c => c.root === root);
      if (root !== "" && !selected) unknowns.push(`No build plan was detected at ${root}.`);
      if (selected && selected.strategy === "buildpack") unknowns.push("Buildpack builds need a Dockerfile before an isolated build can run; none is generated or executed here.");
      const dockerfile = selected?.strategy === "dockerfile" ? selected.dockerfile : undefined;
      let proof: { contextDir: string; contextDigest: string } | undefined;
      if (dockerfile) {
        const doFetch = deps.fetchImpl ?? fetch;
        const contextTree = await walkTree(location, identity.commitSha, root, "tree", token, doFetch, input.signal);
        const dockerfileBlob = await walkTree(location, identity.commitSha, dockerfile, "blob", token, doFetch, input.signal);
        proof = { contextDir: root, contextDigest: computeContextDigest({ repo: `${identity.owner}/${identity.repo}`, commit: identity.commitSha, contextDir: root, contextTree, dockerfile, dockerfileBlob }) };
      }
      return {
        owner: identity.owner, repo: identity.repo, repositoryId: identity.repositoryId, commitSha: identity.commitSha, viaBinding: identity.binding !== null,
        candidates, ...(selected ? { selected } : {}), monorepo: Boolean(analysis.monorepo) || analysis.builds.length > 1,
        truncated: analysis.truncated, unknowns,
        ...(dockerfile ? { buildSource: { repo: `${identity.owner}/${identity.repo}`, ref: identity.commitSha, dockerfile, ...proof! } } : {}),
        execution: "static_only" as const,
      };
    });
  };
}

export interface ContextVerification {
  workspaceId: string;
  environmentId?: string;
  /** `owner/repo` */
  repository: string;
  /** the exact approved commit */
  commitSha: string;
  contextDir: string;
  dockerfile: string;
  contextDigest: string;
  signal?: AbortSignal;
}

/**
 * Build admission's check that a context directory really is what source inspection reported: the digest is
 * RE-DERIVED from the pinned commit through the same binding-scoped access (no symlink on the path, the
 * directory and the Dockerfile exist as regular tree entries), never trusted from the manifest. Returns false
 * on any mismatch or read failure; it never throws a detail that could leak repository content.
 */
export function createGithubContextVerifier(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }) {
  const access = createGithubImmutableSourceAccess(deps);
  return async function verifyContext(input: ContextVerification): Promise<boolean> {
    try {
      const [owner, repoName, ...rest] = input.repository.split("/");
      if (!owner || !repoName || rest.length > 0 || !/^[a-f0-9]{40}$/.test(input.commitSha) || !/^[a-f0-9]{64}$/.test(input.contextDigest)) return false;
      const location = repository(owner, repoName);
      const root = normalizeInspectionRoot(input.contextDir === "." ? "" : input.contextDir);
      const dockerfile = input.dockerfile;
      return await access({ ...location, workspaceId: input.workspaceId, environmentId: input.environmentId, ref: input.commitSha, signal: input.signal }, async (identity, token) => {
        if (identity.commitSha !== input.commitSha) return false;
        const doFetch = deps.fetchImpl ?? fetch;
        const contextTree = await walkTree(location, identity.commitSha, root, "tree", token, doFetch, input.signal);
        const dockerfileBlob = await walkTree(location, identity.commitSha, dockerfile, "blob", token, doFetch, input.signal);
        const derived = computeContextDigest({ repo: `${identity.owner}/${identity.repo}`, commit: identity.commitSha, contextDir: root, contextTree, dockerfile, dockerfileBlob });
        return derived === input.contextDigest;
      });
    } catch {
      return false;
    }
  };
}
