"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useJson, type ApiError } from "@/lib/client/api";
import type {
  AutonomyLevel,
  CloudConnection,
  Deployment,
  Environment,
  Member,
  Project,
  Workspace,
} from "@/lib/domain/types";

export interface ProviderInfo {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
  /** exactly what the bootstrap route sends — adapters carry id + label */
  regions: { id: string; label: string }[];
}

/** One row of the workspace switcher — a workspace, and your role in it. */
export interface WorkspaceRow extends Pick<Workspace, "id" | "name" | "slug"> {
  role: Member["role"];
}

/** Exactly what GET /api/bootstrap returns. */
export interface Bootstrap {
  catalog: ActionEntry[];
  /** the workspace this browser is in — everything else here is scoped to it */
  workspace: Workspace;
  /** every workspace the caller belongs to, for the switcher */
  workspaces: WorkspaceRow[];
  projects: Project[];
  environments: Environment[];
  /** newest deployment per environment — the health source for map + overview */
  deployments: Deployment[];
  connections: CloudConnection[];
  providers: ProviderInfo[];
  settings: Record<string, unknown> & { autonomy?: AutonomyLevel };
  /** signed-in user, or null in demo mode / signed out */
  user: { id: string; email: string; name: string } | null;
  /** the caller's own role — what every role-gated control should read */
  role: "admin" | "editor" | "viewer" | null;
  auth: { configured: boolean };
  members: Member[];
}

/**
 * The serialisable half of an ActionDef — what a picker or a role check needs,
 * nothing more. Bootstrap reads the real registry on the server; the browser
 * never keeps a second definition of who may run what.
 */
export interface ActionEntry {
  id: string;
  title: string;
  category: string;
  risk: "low" | "medium" | "high";
  requiredRole: "viewer" | "editor" | "admin";
}

export interface ShellData {
  boot: Bootstrap | undefined;
  loading: boolean;
  error: ApiError | undefined;
  refresh: () => void;
  /** the action registry, as the server sees it — the source for requiredRole */
  catalog: ActionEntry[];
}

const ShellContext = createContext<ShellData | null>(null);
const EMPTY_CATALOG: ActionEntry[] = [];

/** Workspace-wide data, hydrated once by the product shell. */
export function useShell(): ShellData {
  const ctx = useContext(ShellContext);
  if (!ctx)
    throw new Error(
      "useShell() was called outside the product shell. Render the screen under src/app/(product)/."
    );
  return ctx;
}

export function ShellProvider({
  children,
  catalog = EMPTY_CATALOG,
}: {
  children: ReactNode;
  catalog?: ActionEntry[];
}) {
  const { data, loading, error, refresh } = useJson<Bootstrap>("/api/bootstrap", 10_000);
  const value = useMemo(() => ({
    boot: data, loading, error, refresh, catalog: data?.catalog ?? catalog,
  }), [data, loading, error, refresh, catalog]);
  return (
    <ShellContext.Provider value={value}>
      {children}
    </ShellContext.Provider>
  );
}

/**
 * What the registry says this action needs, or `fallback` when the catalog has
 * not been handed down (a provider rendered without it, or an id that is not in
 * it). The server enforces the real answer either way; this is what lets a
 * control refuse before it is pressed.
 */
export function requiredRoleOf(
  catalog: ActionEntry[],
  actionId: string,
  fallback: ActionEntry["requiredRole"]
): ActionEntry["requiredRole"] {
  return catalog.find((a) => a.id === actionId)?.requiredRole ?? fallback;
}
