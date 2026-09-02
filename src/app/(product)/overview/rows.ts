/**
 * What the overview needs to answer "what needs me?", derived on the server
 * once and handed to the client grid as plain data.
 *
 * Kept out of the page component so the sorting and the "needs attention"
 * rule are testable without rendering anything.
 */
import type { DotStatus } from "@/components/ui";
import type { Deployment, Environment } from "@/lib/domain/types";

export interface EnvRow {
  id: string;
  name: string;
  /** "production" | "staging" | … — drives the amber prod treatment */
  klass: Environment["class"];
  region: string;
  dot: DotStatus;
  /** the state in words, because colour is never the only carrier */
  word: string;
  /** "r12", or null when this environment has never been deployed */
  revision: string | null;
  /** undeployed changes between the working copy and what this runs */
  pending: number;
  /** ISO timestamp of the last finished deployment here */
  lastDeployedAt?: string;
  /** monthly cost the working copy would run at once deployed */
  projectedUsd: number;
  budgetUsd?: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  /** cost of the editable working copy — not what anything is running */
  workingUsd: number;
  /** cost of what is actually deployed, summed across environments */
  deployedUsd: number;
  openFindings: number;
  /** the largest undeployed changeset across this project's environments */
  pending: number;
  environments: EnvRow[];
  /** newest finished deployment across the project's environments */
  lastDeployedAt?: string;
}

export type SortKey = "attention" | "name" | "cost" | "recent";

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "attention", label: "Needs attention" },
  { value: "name", label: "Name" },
  { value: "cost", label: "Working cost" },
  { value: "recent", label: "Recently deployed" },
];

/** Something here is waiting on a human: undeployed work, or an open finding. */
export const needsAttention = (p: ProjectRow): boolean => p.pending > 0 || p.openFindings > 0;

/**
 * What the environment chip says out loud. Colour is never the only carrier:
 * every state also has a word, and the dot carries an accessible label.
 */
export function envStatus(
  env: Environment,
  latest: Deployment | undefined
): { dot: DotStatus; word: string } {
  switch (latest?.status) {
    case "applying":
    case "verifying":
      return { dot: "running", word: "deploying" };
    case "rolling_back":
      return { dot: "running", word: "rolling back" };
    case "failed":
      return { dot: "err", word: "deploy failed" };
    case "awaiting_approval":
      return { dot: "warn", word: "awaiting approval" };
    default:
      return env.deployedRevisionId
        ? { dot: "ok", word: "live" }
        : { dot: "idle", word: "not deployed" };
  }
}

export function sortProjects(rows: ProjectRow[], key: SortKey): ProjectRow[] {
  const by = [...rows];
  switch (key) {
    case "name":
      return by.sort((a, b) => a.name.localeCompare(b.name));
    case "cost":
      return by.sort((a, b) => b.workingUsd - a.workingUsd);
    case "recent":
      return by.sort((a, b) => (b.lastDeployedAt ?? "").localeCompare(a.lastDeployedAt ?? ""));
    default:
      // Most work waiting first, then anything with findings, then by name.
      return by.sort(
        (a, b) =>
          b.pending - a.pending ||
          b.openFindings - a.openFindings ||
          a.name.localeCompare(b.name)
      );
  }
}

export function filterProjects(
  rows: ProjectRow[],
  query: string,
  onlyAttention: boolean
): ProjectRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (p) =>
      (!onlyAttention || needsAttention(p)) &&
      (!q ||
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        p.environments.some((e) => e.name.toLowerCase().includes(q)))
  );
}
