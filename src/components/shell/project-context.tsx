"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useJson, type ApiError } from "@/lib/client/api";
import type { ValidationIssue } from "@/lib/domain/graph";
import type {
  Actor,
  Changeset,
  Deployment,
  Environment,
  Project,
  SecurityFinding,
} from "@/lib/domain/types";
import { useShell } from "./shell-context";

/** Revision metadata only — full manifests come from GET /api/revisions/:id. */
export interface RevisionMeta {
  id: string;
  number: number;
  message: string;
  author: Actor;
  createdAt: string;
}

/** Exactly what GET /api/projects/:idOrSlug returns. */
export interface ProjectPayload {
  project: Project;
  environments: Environment[];
  revisions: RevisionMeta[];
  findings: SecurityFinding[];
  workingIssues: ValidationIssue[];
  /** keyed by environment id: working copy vs. what that environment runs */
  changesets: Record<string, Changeset>;
}

export interface ProjectData extends ProjectPayload {
  /** the environment every screen in this project is currently talking about */
  selectedEnvId: string;
  selectedEnv: Environment | undefined;
  setSelectedEnv: (environmentId: string) => void;
  /** newest deployment per environment of this project (from /api/bootstrap) */
  deployments: Deployment[];
  /** refetch the project and the workspace bootstrap */
  refresh: () => void;
}

const ProjectContext = createContext<ProjectData | null>(null);

/**
 * The project every `/p/[slug]` screen reads from. One fetch, one selected
 * environment, one refresh — so no two tabs can disagree about the system.
 */
export function useProjectData(): ProjectData {
  const ctx = useContext(ProjectContext);
  if (!ctx)
    throw new Error(
      "useProjectData() was called outside a project route. Render the screen under src/app/(product)/p/[slug]/."
    );
  return ctx;
}

const envKey = (projectId: string) => `orrery-env-${projectId}`;

export interface ProjectProviderProps {
  slug: string;
  /** rendered with the loading/error surface when the project is not available */
  fallback: (state: { loading: boolean; error: ApiError | undefined; slug: string }) => ReactNode;
  children: ReactNode;
}

export function ProjectProvider({ slug, fallback, children }: ProjectProviderProps) {
  const { boot, refresh: refreshShell } = useShell();
  const { data, error, loading, refresh: refreshProject } = useJson<ProjectPayload>(
    `/api/projects/${encodeURIComponent(slug)}`,
    5000
  );
  const [envId, setEnvId] = useState<string>("");

  const environments = useMemo(() => data?.environments ?? [], [data]);
  const projectId = data?.project.id;

  // Restore the last environment for this project; fall back to the first one.
  useEffect(() => {
    if (!projectId || environments.length === 0) return;
    setEnvId((current) => {
      if (current && environments.some((e) => e.id === current)) return current;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(envKey(projectId));
      } catch {
        /* private mode — the first environment is a fine default */
      }
      return environments.find((e) => e.id === saved)?.id ?? environments[0].id;
    });
  }, [projectId, environments]);

  const setSelectedEnv = useCallback(
    (next: string) => {
      setEnvId(next);
      if (!projectId) return;
      try {
        localStorage.setItem(envKey(projectId), next);
      } catch {
        /* preference only — selection still works for this session */
      }
    },
    [projectId]
  );

  const refresh = useCallback(() => {
    refreshProject();
    refreshShell();
  }, [refreshProject, refreshShell]);

  const value = useMemo<ProjectData | null>(() => {
    if (!data || !envId) return null;
    const ids = new Set(data.environments.map((e) => e.id));
    return {
      ...data,
      selectedEnvId: envId,
      selectedEnv: data.environments.find((e) => e.id === envId),
      setSelectedEnv,
      deployments: (boot?.deployments ?? []).filter((d) => ids.has(d.environmentId)),
      refresh,
    };
  }, [data, envId, boot, setSelectedEnv, refresh]);

  if (!value) return <>{fallback({ loading, error, slug })}</>;
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
