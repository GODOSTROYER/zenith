"use client";
/**
 * The single point where workstream E2 touches workstream E1's project shell.
 * Every screen reads the project through `useSelectedEnv()`, so if the shell
 * moves or changes shape there is exactly one file to repoint.
 */
import {
  useProjectData,
  type ProjectPayload,
  type RevisionMeta,
} from "@/components/shell/project-context";
import type { Environment } from "@/lib/domain/types";

export type { ProjectPayload, RevisionMeta };

export interface SelectedEnv {
  /** the `GET /api/projects/:id` payload */
  data: ProjectPayload;
  /** the environment the shell header has selected */
  env: Environment | undefined;
  projectId: string;
  slug: string;
  setSelectedEnv: (environmentId: string) => void;
  refresh: () => void;
}

export function useSelectedEnv(): SelectedEnv {
  const ctx = useProjectData();
  return {
    data: ctx,
    env: ctx.selectedEnv ?? ctx.environments[0],
    projectId: ctx.project.id,
    slug: ctx.project.slug,
    setSelectedEnv: ctx.setSelectedEnv,
    refresh: ctx.refresh,
  };
}
