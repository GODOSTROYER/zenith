/** Workspace-scoped project/environment choices. Planning is requested on
 * demand; this page never changes provider connections on load. */
import type { Metadata } from "next";
import { db, runInStoreScope } from "@/lib/db/store";
import { currentWorkspace } from "@/lib/server/context";
import { PlacementPlanner } from "./placement-planner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Placement" };

export default async function PlacementPage() {
  return runInStoreScope(async () => {
    const workspace = await currentWorkspace();
    if (!workspace) return <p className="p-6">Choose a workspace before planning placement.</p>;
    const data = db();
    const projects = data.projects.filter((p) => p.workspaceId === workspace.id).map((p) => ({ id: p.id, name: p.name,
      environments: data.environments.filter((e) => e.projectId === p.id).map((e) => ({ id: e.id, name: e.name })) }));
    return <PlacementPlanner projects={projects} />;
  });
}
