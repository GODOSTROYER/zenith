/**
 * The workspace's hosted apps: what exists, and what this install can do.
 *
 * The GET carries more than a list on purpose. A screen that shows apps has to
 * answer "why can I not publish?" without a second round trip, so the limits,
 * who enforces each of them, the runtime and every build runner's own
 * availability come back with the apps — including, and especially, when they
 * are unavailable. An empty list with no builder status would be a screen with
 * a dead button on it.
 *
 * Workstream W7 (hosted R3).
 */
import { z } from "zod";
import "@/lib/actions/defs/hosted";
import { buildRunnerStatus } from "@/lib/hosted/build";
import { hostedConfig } from "@/lib/hosted/config";
import { appSummary, listApps } from "@/lib/hosted/release";
import {
  actorOf,
  executeHosted,
  hostedRoute,
  limitsBlock,
  readBody,
  requireWorkspaceRole,
  runtimeStatus,
} from "@/lib/hosted/release/http";
import { buildCtx, json, requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().toLowerCase().min(3).max(40),
});

export const GET = hostedRoute(async (req) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "viewer");
  const workspace = requireWorkspace();
  const runtime = await runtimeStatus();
  const config = hostedConfig();
  return {
    apps: listApps(workspace.id).map((app) => appSummary(app.id)),
    limits: limitsBlock(),
    enforcement: runtime.enforcement,
    runtime: { id: runtime.id, label: runtime.label, availability: runtime.availability },
    builder: await buildRunnerStatus(),
    // So a workspace with no apps yet can still show the address the first one
    // will have, instead of reading it back off an app that does not exist.
    appDomain: config.ZENITH_APP_DOMAIN,
    appScheme: config.ZENITH_APP_SCHEME,
  };
});

export const POST = hostedRoute(async (req) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "editor");
  const body = await readBody(req, CreateBody, 'POST { "name": "Equipment tracker", "slug": "tracker" }.');
  const result = await executeHosted("app.create", buildCtx({}, actor), body);
  return json({ app: (result.data as { app: unknown }).app }, 201);
});
