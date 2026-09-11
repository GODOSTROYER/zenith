import type { Bootstrap } from "@/components/shell/shell-context";
import type { ProviderChoice } from "@/components/screens/onboarding/types";

export interface GuideDraft {
  version: 1;
  workspaceId: string;
  userId: string;
  step: number;
  providerId?: string;
  connectionId?: string;
  projectId?: string;
}

/** The legacy product namespace remains stable. Anonymous demo sessions are not persisted. */
export function guideStorageKey(boot: Bootstrap): string | undefined {
  return boot.user?.id ? `zenith:guide:v1:${encodeURIComponent(boot.user.id)}:${encodeURIComponent(boot.workspace.id)}` : undefined;
}

/** Allowlist fields and validate every stored identity against fresh workspace state. */
export function restoreGuide(raw: string | null, boot: Bootstrap): GuideDraft | undefined {
  if (!raw || !boot.user?.id) return;
  try {
    const d = JSON.parse(raw) as GuideDraft;
    if (d.version !== 1 || d.workspaceId !== boot.workspace.id || d.userId !== boot.user.id) return;
    const provider = boot.providers.find((p) => p.id === d.providerId && p.availability !== "planned");
    const connection = boot.connections.find((c) => c.id === d.connectionId && c.workspaceId === boot.workspace.id && c.provider === provider?.id);
    const project = boot.projects.find((p) => p.id === d.projectId && p.workspaceId === boot.workspace.id);
    return {
      version: 1, workspaceId: boot.workspace.id, userId: boot.user.id,
      step: Number.isInteger(d.step) && d.step >= 1 && d.step <= 4 ? (d.step === 3 && !provider ? 2 : d.step) : 1,
      providerId: provider?.id, connectionId: connection?.id, projectId: project?.id,
    };
  } catch { return; }
}

export function choiceFromDraft(draft: GuideDraft | undefined, boot: Bootstrap): ProviderChoice | undefined {
  const provider = boot.providers.find((p) => p.id === draft?.providerId && p.availability !== "planned");
  if (!provider) return;
  return { providerId: provider.id, displayName: provider.displayName, connectionId: draft?.connectionId };
}

export function canEditGuide(boot: Bootstrap | undefined): boolean {
  return boot?.role === "admin" || boot?.role === "editor";
}

/** A visited page is never evidence of setup or deployment. */
export function guideProgress(boot: Bootstrap | undefined, projectId?: string) {
  const projects = boot?.projects.filter((p) => p.workspaceId === boot.workspace.id) ?? [];
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const environment = boot?.environments.find((e) => e.projectId === project?.id);
  const connection = boot?.connections.find((c) => c.id === environment?.connectionId && c.workspaceId === boot.workspace.id);
  const provider = boot?.providers.find((p) => p.id === connection?.provider);
  const hasNodes = !!project && (project.workingManifest.services.length + project.workingManifest.resources.length) > 0;
  const complete = [!!boot?.workspace, !!connection, !!project && !!environment && hasNodes, false];
  const mode = connection?.provider === "sandbox" ? "Simulation" : provider?.availability === "preview" ? "Preview · plan and export only" : connection?.provider === "localstack" ? "LocalStack · S3 and SQS" : "No connection";
  const next = !project ? "Create a project or import a file" : !environment ? "Add an environment in Settings" : !connection ? "Choose a connection in Settings" : !hasNodes ? "Add your first service or resource in System" : connection.status !== "healthy" ? "Recheck your connection in Settings" : provider?.availability === "preview" ? "Review Source, then preview a plan or export Terraform" : "Review your system, then preview a deployment plan";
  return { project, environment, connection, provider, complete, mode, next, hasNodes };
}
