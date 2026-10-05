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
  buildSource?: { repo: string; ref: string; dockerfile: string };
  /** Always "static_only": nothing from the repository was executed here. */
  execution: "static_only";
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
      return {
        owner: identity.owner, repo: identity.repo, repositoryId: identity.repositoryId, commitSha: identity.commitSha, viaBinding: identity.binding !== null,
        candidates, ...(selected ? { selected } : {}), monorepo: Boolean(analysis.monorepo) || analysis.builds.length > 1,
        truncated: analysis.truncated, unknowns,
        ...(dockerfile ? { buildSource: { repo: `${identity.owner}/${identity.repo}`, ref: identity.commitSha, dockerfile } } : {}),
        execution: "static_only" as const,
      };
    });
  };
}
