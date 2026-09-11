/**
 * The workspace's hosted apps: what exists, and what this install can do.
 *
 * The GET carries more than a list on purpose. A screen that shows apps has to
 * answer "why can I not publish?" without a second round trip, so the limits,
 * who enforces each of them, the runtime and every build runner's own
 * availability come back with the apps — including, and especially, when they
 * are unavailable. An empty list with no builder status would be a screen with
 * a dead button on it.
 */
import { z } from "zod";
import { NO_RUNNER_REASON, buildRunnerStatus, selectedBuildRunner } from "@/lib/hosted/build";
import { buildsPaused } from "@/lib/hosted/usage";
import { hostedConfig } from "@/lib/hosted/config";
import type { AppCreatedWire, HostedAppsWire } from "@/lib/hosted/contracts";
import { appSummary, listApps } from "@/lib/hosted/release";
import {
  executeHosted,
  hostedJson,
  hostedRoute,
  limitsBlock,
  readJsonBody,
  runtimeStatus,
} from "@/lib/server/hosted";
import { buildCtx, requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().toLowerCase().min(3).max(40),
});

export const GET = hostedRoute({ workspaceRole: "viewer" }, async (): Promise<HostedAppsWire> => {
  const workspace = requireWorkspace();
  const runtime = await runtimeStatus();
  const config = hostedConfig();
  return {
    apps: await Promise.all((await listApps(workspace.id)).map((app) => appSummary(app.id))),
    limits: limitsBlock(),
    enforcement: runtime.enforcement,
    runtime: { id: runtime.id, label: runtime.label, availability: runtime.availability },
    builder: await buildRunnerStatus(),
    // Which runner ZENITH_BUILD_RUNNER actually selected — null with the
    // reason when none — so a screen never has to infer it from the list.
    selectedBuilder: selectedBuildRunner()?.id ?? null,
    selectedBuilderReason: selectedBuildRunner() ? null : NO_RUNNER_REASON,
    // The spending pause applies to everyone who can publish, not only to the
    // admin who can read the spending screen.
    buildsPaused: await buildsPaused(workspace.id),
    // So a workspace with no apps yet can still show the address the first one
    // will have, instead of reading it back off an app that does not exist.
    appDomain: config.ZENITH_APP_DOMAIN,
    appScheme: config.ZENITH_APP_SCHEME,
  };
});

export const POST = hostedRoute({ workspaceRole: "editor" }, async (req, _params, { actor }) => {
  const body = await readJsonBody(req, CreateBody, {
    fix: 'POST { "name": "Equipment tracker", "slug": "tracker" }.',
  });
  const result = await executeHosted("app.create", buildCtx({}, actor), body);
  const { app } = result.data as AppCreatedWire;
  return hostedJson({ app }, 201);
});
