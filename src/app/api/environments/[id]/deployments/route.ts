/**
 * Deployment history for one environment, newest first.
 *
 * The Deploys screen used to read the store through a "use server" action with
 * a hardcoded 50-row cap; this is the REST route that replaces it.
 *
 *   ?limit=50            1..200 (default 50)
 *   ?cursor=<offset>     `nextCursor` from the previous page
 *   ?status=live         "live" | "terminal" | comma-separated DeploymentStatus
 */
import { q } from "@/lib/db/store";
import { DeploymentStatus } from "@/lib/domain/types";
import { ApiError, intParam, notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "cancelled", "rolled_back"];
const LIVE = DeploymentStatus.options.filter((s) => !TERMINAL.includes(s));

function statusFilter(raw: string | null): Set<DeploymentStatus> | undefined {
  if (!raw || raw === "all") return undefined;
  const out = new Set<DeploymentStatus>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part === "live") LIVE.forEach((s) => out.add(s));
    else if (part === "terminal") TERMINAL.forEach((s) => out.add(s));
    else {
      const parsed = DeploymentStatus.safeParse(part);
      if (!parsed.success)
        throw new ApiError(`Unknown deployment status "${part}".`, 400, {
          fix: `Use "live", "terminal", or any of: ${DeploymentStatus.options.join(", ")}.`,
        });
      out.add(parsed.data);
    }
  }
  return out.size ? out : undefined;
}

export const GET = route<{ id: string }>(async (req, { id }) => {
  const env = q.environment(id);
  if (!env)
    throw notFound(
      `Environment "${id}"`,
      "Pick an environment from the project's environment switcher, or create one in Settings → Environments."
    );

  const wanted = statusFilter(req.nextUrl.searchParams.get("status"));
  const all = q.deploymentsOf(env.id).filter((d) => !wanted || wanted.has(d.status));
  const limit = Math.min(Math.max(intParam(req, "limit", 50), 1), 200);
  const offset = Math.max(intParam(req, "cursor", 0), 0);
  const deployments = all.slice(offset, offset + limit);
  const next = offset + deployments.length;

  return {
    deployments,
    /** total matching the filter, so the UI can say "50 of 214" honestly */
    total: all.length,
    nextCursor: next < all.length ? String(next) : undefined,
  };
});
