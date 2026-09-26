import { WorkspaceAccessPage } from "./workspace-access-page";

export default async function WorkspacePage({ searchParams }: {
  searchParams: Promise<{ workspace?: string | string[] }>;
}) {
  const params = await searchParams;
  const requestedWorkspaceId = typeof params.workspace === "string" ? params.workspace : undefined;
  return <WorkspaceAccessPage requestedWorkspaceId={requestedWorkspaceId} />;
}
