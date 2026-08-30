/**
 * Workspace bootstrap — the one mutation that happens before any workspace
 * exists, so it cannot be an action. Creates the workspace, the local member,
 * and a healthy sandbox connection in one atomic step.
 * Integrator-owned exception inside api/ (see docs/OWNERSHIP.md).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, save } from "@/lib/db/store";
import { id } from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";

export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(60) });

export async function POST(req: NextRequest) {
  await ensureBoot();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "Workspace needs a name.", fix: "Send { name: string } (1–60 chars)." } },
      { status: 400 }
    );
  }
  const data = db();
  if (data.workspaces.length > 0) {
    return NextResponse.json(
      {
        error: {
          message: `A workspace already exists ("${data.workspaces[0].name}").`,
          fix: "Orrery local runs one workspace. Use it, or reset with npm run seed.",
        },
      },
      { status: 409 }
    );
  }
  const name = parsed.data.name;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) || "workspace";

  const workspace = { id: id(), name, slug, createdAt: new Date().toISOString() };
  data.workspaces.push(workspace);
  data.members.push({
    id: id(),
    workspaceId: workspace.id,
    name: "You",
    email: "you@local",
    role: "admin",
  });
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
  return NextResponse.json({ workspace });
}
