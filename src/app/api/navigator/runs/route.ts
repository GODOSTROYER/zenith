/** Navigator runs, newest first. Optional `?projectId=`. */
import { db } from "@/lib/db/store";
import { route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const projectId = req.nextUrl.searchParams.get("projectId");
  const runs = db()
    .navigatorRuns.filter((r) => !projectId || r.projectId === projectId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { runs };
});
