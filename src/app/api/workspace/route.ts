/**
 * Workspace bootstrap — the one mutation that happens before any workspace
 * exists, so it cannot be an action. Creates the workspace and a healthy
 * sandbox connection in one atomic step.
 * Integrator-owned exception inside api/ (see docs/OWNERSHIP.md).
 */
import { z } from "zod";
import { db, save } from "@/lib/db/store";
import { id } from "@/lib/domain/types";
import { ApiError, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(60) });

export const POST = route(async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("Workspace needs a name.", 400, { fix: "Send { name: string } (1–60 chars)." });
  const data = db();
  if (data.workspaces.length > 0)
    throw new ApiError(`A workspace already exists ("${data.workspaces[0].name}").`, 409, {
      fix: "Orrery local runs one workspace. Use it, or reset with npm run seed.",
    });
  const name = parsed.data.name;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) || "workspace";

  const workspace = { id: id(), name, slug, createdAt: new Date().toISOString() };
  data.workspaces.push(workspace);
  // No member is seeded. A placeholder "you@local" admin is an admin seat
  // nobody can sign in as, and it demoted every real user to editor forever.
  // The first real user to sign in becomes admin (ensureMember); with no
  // Supabase keys the local demo actor is admin because there is nobody else.
  data.connections.push({
    id: id(),
    workspaceId: workspace.id,
    provider: "sandbox",
    label: "Orrery Sandbox",
    region: "local-1",
    status: "healthy",
    grantedPermissions: [
      "Provision simulated services and resources",
      "Read simulated logs, health, and cost estimates",
      "No access to any real cloud account",
    ],
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  });
  save();
  return { workspace };
});
