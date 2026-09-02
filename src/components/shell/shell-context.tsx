"use client";
import { createContext, useContext, type ReactNode } from "react";
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
  regions: string[];
}

/** Exactly what GET /api/bootstrap returns. */
export interface Bootstrap {
  workspace: Workspace;
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

export interface ShellData {
  boot: Bootstrap | undefined;
  loading: boolean;
  error: ApiError | undefined;
  refresh: () => void;
}

const ShellContext = createContext<ShellData | null>(null);

/** Workspace-wide data, hydrated once by the product shell. */
export function useShell(): ShellData {
  const ctx = useContext(ShellContext);
  if (!ctx)
    throw new Error(
      "useShell() was called outside the product shell. Render the screen under src/app/(product)/."
    );
  return ctx;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, refresh } = useJson<Bootstrap>("/api/bootstrap", 10_000);
  return (
    <ShellContext.Provider value={{ boot: data, loading, error, refresh }}>
      {children}
    </ShellContext.Provider>
  );
}
