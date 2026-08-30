/** One Navigator run with its steps. */
import { db } from "@/lib/db/store";
import { notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const run = db().navigatorRuns.find((r) => r.id === id);
  if (!run) throw notFound(`Navigator run "${id}"`, "Open the project's Navigator tab to see runs that exist.");
  return { run };
});
