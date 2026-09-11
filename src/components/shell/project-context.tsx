"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  Suspense,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { streamedPollMs, useEventStream, useJson, type ApiError } from "@/lib/client/api";
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
  /**
   * Optimistic-concurrency token for the working copy, from
   * `GET /api/projects/:id`. Any surface that holds a manifest across time
   * sends it back as `expectedHash` on project.updateManifest, so a save that
   * raced another writer is refused instead of overwriting them.
   */
  manifestHash: string;
  environments: Environment[];
  revisions: RevisionMeta[];
  findings: SecurityFinding[];
  workingIssues: ValidationIssue[];
  /** keyed by environment id: working copy vs. what that environment runs */
  changesets: Record<string, Changeset>;
  /** the payload's ETag — present on stream deliveries, absent on a poll */
  etag?: string;
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

const envKey = (projectId: string) => `zenith-env-${projectId}`;

/** Query-only navigation must reach the existing provider without remounting drafts. */
function EnvironmentUrlSync({ select }: { select: (id: string) => void }) {
  const params = useSearchParams();
  const requested = params.get("env");
  useEffect(() => { if (requested) select(requested); }, [requested, select]);
  return null;
}

/** Poll interval used whenever the stream is not delivering. Unchanged. */
const POLL_MS = 5000;
/** Stable identity: useEventStream re-subscribes when this list changes. */
const PROJECT_EVENTS = ["project"];

export interface ProjectProviderProps {
  slug: string;
  /** rendered with the loading/error surface when the project is not available */
  fallback: (state: { loading: boolean; error: ApiError | undefined; slug: string }) => ReactNode;
  children: ReactNode;
}

export function ProjectProvider({ slug, fallback, children }: ProjectProviderProps) {
  const { boot, refresh: refreshShell } = useShell();
  const url = `/api/projects/${encodeURIComponent(slug)}`;

  /**
   * Two transports, one payload. The stream pushes the same body the GET
   * returns, so whichever spoke last wins and no screen can tell the
   * difference. `live` is only true once a payload has actually arrived over
   * the stream — until then, and again the moment it drops, the 5s poll is
   * still running. A browser without EventSource never leaves that state.
   */
  const [data, setData] = useState<ProjectPayload>();
  const [live, setLive] = useState(false);

  const { data: polled, error, loading, refresh: refreshProject } = useJson<ProjectPayload>(
    url,
    streamedPollMs(live, POLL_MS)
  );
  useEffect(() => {
    if (polled) setData(polled);
  }, [polled]);

  const onPush = useCallback((_type: string, payload: unknown) => {
    setData(payload as ProjectPayload);
    setLive(true);
  }, []);
  const { connected } = useEventStream(`${url}/stream`, PROJECT_EVENTS, onPush);
  useEffect(() => {
    if (!connected) setLive(false); // errored or reconnecting: poll again
  }, [connected]);

  // useJson re-syncs on visibility even when SSE disables its polling timer.
  // A second listener here would queue a duplicate request on every tab return.

  const [envId, setEnvId] = useState<string>("");

  const environments = useMemo(() => data?.environments ?? [], [data]);
  const projectId = data?.project.id;

  // `?env=<id>` wins on arrival (that is what an overview link means), then the
  // last environment used for this project, then the first one.
  useEffect(() => {
    if (!projectId || environments.length === 0) return;
    setEnvId((current) => {
      if (current && environments.some((e) => e.id === current)) return current;
      const asked = new URLSearchParams(window.location.search).get("env");
      if (asked && environments.some((e) => e.id === asked)) return asked;
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
      if (!environments.some((environment) => environment.id === next)) return;
      setEnvId(next);
      if (!projectId) return;
      try {
        localStorage.setItem(envKey(projectId), next);
      } catch {
        /* preference only — selection still works for this session */
      }
      // Keep shareable links and Back/Forward consistent with a manual pick.
      // replaceState is supported by Next's history integration and preserves
      // route, other filters and hash without a server navigation or remount.
      const url = new URL(window.location.href);
      if (url.searchParams.get("env") !== next) {
        url.searchParams.set("env", next);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    },
    [projectId, environments]
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
  return <ProjectContext.Provider value={value}>
    <Suspense fallback={null}><EnvironmentUrlSync select={setSelectedEnv} /></Suspense>
    {children}
  </ProjectContext.Provider>;
}
