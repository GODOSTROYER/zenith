/**
 * Hosted app actions: create, publish, roll back, suspend, resume.
 *
 * These are Actions rather than route bodies for the reason every mutation in
 * this product is one — the UI, the REST API and the Navigator all call the
 * same definition, so no surface can hold private knowledge about how a
 * publish works. What is different about the hosted ones is the second half of
 * their authorization (PLAN-R3 G10): the workspace role that `runAction`
 * enforces says whether you may operate *this workspace's* infrastructure, and
 * the app's **owner** grant says whether you may operate *this app*. Both are
 * required, and the plan says so before the button is pressed rather than
 * after.
 *
 * Every plan here is honest about what would stop the execute: no build runner
 * configured, spending past the pause threshold, a suspended app, a missing
 * owner grant. A plan with `blocked` set is what makes the confirm control
 * disabled instead of dead.
 *
 * Workstream W7 (hosted R3).
 */
import { z } from "zod";
import { defineAction, type ActionContext, type ActionResult } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import { appHostname, hostedConfig } from "@/lib/hosted/config";
import { NO_RUNNER_REASON } from "@/lib/hosted/build";
import { HostedError, isValidAppSlug, type Subject } from "@/lib/hosted/contracts";
import {
  PublishSource,
  admitPublish,
  admitResume,
  admitRollback,
  admitSuspend,
  assertRollbackTarget,
  createApp,
  getApp,
  releaseDeps,
} from "@/lib/hosted/release";
import { authority, authorityOpen } from "@/lib/hosted/authority";
import { currentRequest } from "@/lib/server/context";

/* --------------------------------- helpers -------------------------------- */

/** The acting subject. Hosted grants are keyed by identity-provider subject, never by email. */
const subjectOf = (ctx: ActionContext): Subject => ctx.actor.id;

/**
 * The acting user's verified email, for display on the grant they are about to
 * be given. Falls back to the member row, then to nothing — an app is still
 * created for a demo actor who has no email, and the grant simply shows none.
 */
function emailOf(ctx: ActionContext): string {
  const user = currentRequest()?.user;
  if (user?.email) return user.email.toLowerCase();
  const member = db().members.find((m) => m.id === ctx.actor.id && m.workspaceId === ctx.workspaceId);
  return (member?.email ?? "").toLowerCase();
}

/**
 * Turn a `HostedError` into a result the API layer can still answer with the
 * right status.
 *
 * `runAction` flattens a thrown error to a string, which is the right shape
 * for the UI and the wrong one for HTTP: a duplicate slug is a 409 and an
 * unknown app is a 404, and both would otherwise become 500. The code travels
 * in `data.hosted` so the route can restore it (see `hostedStatusOf`).
 */
function refusal(err: unknown, title: string): ActionResult {
  if (err instanceof HostedError)
    return {
      ok: false,
      summary: err.message,
      error: err.fix ? `${err.message} ${err.fix}` : err.message,
      data: { hosted: { code: err.code, message: err.message, fix: err.fix, details: err.details } },
    };
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, summary: `${title} failed.`, error: message };
}

/** Whether this actor holds the app's owner grant, and the sentence to show when they do not. */
function ownerCheck(appId: string, subject: Subject): { ok: boolean; reason?: string } {
  try {
    releaseDeps.requireAppRole(appId, subject, "owner");
    return { ok: true };
  } catch (err) {
    if (err instanceof HostedError)
      return { ok: false, reason: err.fix ? `${err.message} ${err.fix}` : err.message };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The runner that would build, and what it does and does not isolate. */
async function builderLine(): Promise<{ ok: boolean; line: string }> {
  const runner = releaseDeps.buildRunner();
  if (!runner) return { ok: false, line: NO_RUNNER_REASON };
  const availability = await runner.availability();
  if (!availability.available)
    return {
      ok: false,
      line: `The ${runner.label} runner is selected but cannot run here: ${availability.reason ?? "it reported itself unavailable."} ${availability.fix ?? ""}`.trim(),
    };
  return { ok: true, line: `${runner.label} will build this release. ${runner.boundary}` };
}

/** The app a hosted action names, scoped to the workspace the action runs in. */
function appFor(ctx: ActionContext, appId: string) {
  if (!authorityOpen())
    throw new HostedError("policy_unavailable", "The hosted control authority is not open in this process.", {
      fix: "This is a boot problem, not an input problem: ensureHosted() runs on every server boot path.",
    });
  const app = getApp(appId);
  if (!app || app.workspaceId !== ctx.workspaceId)
    throw new HostedError("not_found", `No hosted app ${appId} exists in this workspace.`, {
      fix: "Pick an app from the workspace's Apps list.",
    });
  return app;
}

/* -------------------------------- app.create ------------------------------ */

const CreateApp = z.object({
  name: z.string().trim().min(1, "an app needs a name").max(60, "keep the app name under 60 characters"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "a slug needs at least 3 characters")
    .max(40, "keep the slug under 40 characters"),
});
type CreateApp = z.infer<typeof CreateApp>;

defineAction<CreateApp>({
  id: "app.create",
  title: "Create hosted app",
  category: "hosted",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: CreateApp,
  plan(_ctx, input) {
    const runtime = hostedConfig().ZENITH_RUNTIME;
    const legal = isValidAppSlug(input.slug);
    const taken = legal && authorityOpen() ? authority().repos.apps.getBySlug(input.slug) : null;
    return {
      summary: `Create the hosted app “${input.name}” at ${appHostname(input.slug)}.`,
      details: [
        `The app is served by the ${runtime} runtime and reached at ${appHostname(input.slug)}.`,
        "You become its owner in the same transaction that creates it, so it is never an app nobody can operate.",
        "No release is published yet: the app exists, and its hostname answers once you publish one.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
      blocked: !legal
        ? `“${input.slug}” cannot be an app slug. Use 3–40 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit, and not one of the reserved platform names.`
        : taken
          ? `The slug “${input.slug}” already belongs to another app on this install. Slugs are hostnames, so they are unique — pick another one.`
          : undefined,
    };
  },
  async execute(ctx, input) {
    try {
      const app = await createApp({
        workspaceId: ctx.workspaceId,
        name: input.name,
        slug: input.slug,
        createdBy: subjectOf(ctx),
        email: emailOf(ctx),
      });
      return {
        ok: true,
        summary: app.stateReason
          ? `Created “${app.name}” at ${appHostname(app.slug)}, but the ${app.runtime} runtime could not prepare it yet: ${app.stateReason}`
          : `Created “${app.name}” at ${appHostname(app.slug)}. You are its owner. Publish a release to make it answer.`,
        data: { app },
      };
    } catch (err) {
      return refusal(err, "Create hosted app");
    }
  },
});

/* ------------------------------- app.publish ------------------------------ */

const PublishApp = z.object({
  appId: z.string().min(1),
  jobId: z.string().uuid("a job id is a UUID the client generates, so a retry is recognisable"),
  source: PublishSource,
});
type PublishApp = z.infer<typeof PublishApp>;

defineAction<PublishApp>({
  id: "app.publish",
  title: "Publish hosted app",
  category: "hosted",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: PublishApp,
  async plan(ctx, input) {
    const app = appFor(ctx, input.appId);
    const builder = await builderLine();
    const owner = ownerCheck(app.id, subjectOf(ctx));
    let paused: { paused: boolean; reason?: string };
    try {
      paused = releaseDeps.buildsPaused(ctx.workspaceId);
    } catch (err) {
      paused = { paused: true, reason: err instanceof Error ? err.message : String(err) };
    }
    const source =
      input.source.kind === "fixture" ? `the “${input.source.name}” fixture` : "the submitted tarball";

    return {
      summary: `Publish ${source} to “${app.name}” at ${appHostname(app.slug)}.`,
      details: [
        builder.line,
        "Phases: intake, build, artifact, verify_artifact, stage, probe, activate, cleanup. Each one is recorded before it runs, so a restart resumes rather than repeats.",
        "The candidate is probed against a disposable test database before anything switches over.",
        app.activeReleaseId
          ? "The release now serving stays live until the candidate passes; a failed candidate never replaces it."
          : "This app has never activated a release, so this is the one its hostname will answer with.",
      ],
      costDeltaUsd: 0,
      risk: "medium",
      warnings:
        app.activeReleaseId === null
          ? []
          : ["Everyone with a grant sees the new release as soon as it activates. Roll back if it is wrong."],
      requiresApproval: false,
      blocked:
        app.state !== "active"
          ? `${app.name} is ${app.state}, so it does not accept new releases. Resume it first — its data, grants and artifacts were kept.`
          : !owner.ok
            ? owner.reason
            : paused.paused
              ? (paused.reason ??
                "Builds are paused for this workspace because spending reached 90 % of the approved envelope.")
              : !builder.ok
                ? builder.line
                : undefined,
    };
  },
  async execute(ctx, input) {
    try {
      const app = appFor(ctx, input.appId);
      // Workspace role is `runAction`'s to enforce; the app's owner grant is
      // this action's, and it is checked before anything is queued.
      releaseDeps.requireAppRole(app.id, subjectOf(ctx), "owner");
      const { job, created } = await admitPublish({
        jobId: input.jobId,
        appId: app.id,
        workspaceId: ctx.workspaceId,
        actor: subjectOf(ctx),
        source: input.source,
      });
      return {
        ok: true,
        summary: created
          ? `Publishing to “${app.name}”. Job ${job.id} is queued; watch it at /api/hosted/apps/${app.id}/jobs/${job.id}.`
          : `Job ${job.id} was already publishing this exact source to “${app.name}” (${job.status}, phase ${job.phase}). Nothing was queued twice.`,
        data: { jobId: job.id, job, created },
      };
    } catch (err) {
      return refusal(err, "Publish hosted app");
    }
  },
});

/* ------------------------------- app.rollback ----------------------------- */

const RollbackApp = z.object({
  appId: z.string().min(1),
  jobId: z.string().uuid("a job id is a UUID the client generates, so a retry is recognisable"),
  releaseId: z.string().min(1),
});
type RollbackApp = z.infer<typeof RollbackApp>;

defineAction<RollbackApp>({
  id: "app.rollback",
  title: "Roll back hosted app",
  category: "hosted",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: RollbackApp,
  plan(ctx, input) {
    const app = appFor(ctx, input.appId);
    const owner = ownerCheck(app.id, subjectOf(ctx));
    let target: string | undefined;
    let blocked: string | undefined;
    try {
      const release = assertRollbackTarget(app.id, input.releaseId, app.activeReleaseId);
      target = `release ${release.number}`;
    } catch (err) {
      blocked = err instanceof HostedError ? `${err.message} ${err.fix ?? ""}`.trim() : String(err);
    }
    return {
      summary: `Put “${app.name}” back onto ${target ?? `release ${input.releaseId}`}.`,
      details: [
        "Rollback replaces code, not data: every record your users wrote stays exactly as it is, at the version it is at.",
        "The target's data schema is compared with the app's before anything switches, and a mismatch is refused rather than attempted.",
        "The release now serving is marked rolled_back, so the history says somebody stepped off it rather than that something newer arrived.",
      ],
      costDeltaUsd: 0,
      risk: "medium",
      warnings: [],
      requiresApproval: false,
      blocked: !owner.ok ? owner.reason : blocked,
    };
  },
  execute(ctx, input) {
    try {
      const app = appFor(ctx, input.appId);
      releaseDeps.requireAppRole(app.id, subjectOf(ctx), "owner");
      const { job, created } = admitRollback({
        jobId: input.jobId,
        appId: app.id,
        workspaceId: ctx.workspaceId,
        actor: subjectOf(ctx),
        releaseId: input.releaseId,
      });
      return {
        ok: true,
        summary: created
          ? `Rolling “${app.name}” back. Job ${job.id} is queued.`
          : `Job ${job.id} was already rolling this app back to that release (${job.status}).`,
        data: { jobId: job.id, job, created },
      };
    } catch (err) {
      return refusal(err, "Roll back hosted app");
    }
  },
});

/* -------------------------- app.suspend / app.resume ---------------------- */

const AppState = z.object({
  appId: z.string().min(1),
  jobId: z.string().uuid("a job id is a UUID the client generates, so a retry is recognisable"),
  reason: z.string().trim().max(300).optional(),
});
type AppState = z.infer<typeof AppState>;

defineAction<AppState>({
  id: "app.suspend",
  title: "Suspend hosted app",
  category: "hosted",
  risk: "high",
  requiredRole: "admin",
  mutates: true,
  input: AppState,
  plan(ctx, input) {
    const app = appFor(ctx, input.appId);
    const owner = ownerCheck(app.id, subjectOf(ctx));
    return {
      summary: `Suspend “${app.name}” at ${appHostname(app.slug)}.`,
      details: [
        "Every request to the app is refused with 423 until it is resumed — before any session or artifact is touched.",
        "Nothing is destroyed: data, grants, invitations, releases and artifacts are all kept.",
        "Open sessions are left alone. They stop working while the app is suspended and work again when it resumes.",
      ],
      costDeltaUsd: 0,
      risk: "high",
      warnings: ["Everyone using the app loses access immediately."],
      requiresApproval: false,
      blocked: !owner.ok
        ? owner.reason
        : app.state === "suspended"
          ? `${app.name} is already suspended. Resume it when it should serve again.`
          : undefined,
    };
  },
  execute(ctx, input) {
    try {
      const app = appFor(ctx, input.appId);
      releaseDeps.requireAppRole(app.id, subjectOf(ctx), "owner");
      const { job, created } = admitSuspend({
        jobId: input.jobId,
        appId: app.id,
        workspaceId: ctx.workspaceId,
        actor: subjectOf(ctx),
        reason: input.reason,
      });
      return {
        ok: true,
        summary: created
          ? `Suspending “${app.name}”. Job ${job.id} is queued.`
          : `Job ${job.id} was already suspending this app (${job.status}).`,
        data: { jobId: job.id, job, created },
      };
    } catch (err) {
      return refusal(err, "Suspend hosted app");
    }
  },
});

defineAction<AppState>({
  id: "app.resume",
  title: "Resume hosted app",
  category: "hosted",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: AppState,
  plan(ctx, input) {
    const app = appFor(ctx, input.appId);
    const owner = ownerCheck(app.id, subjectOf(ctx));
    return {
      summary: `Resume “${app.name}” at ${appHostname(app.slug)}.`,
      details: [
        app.activeReleaseId
          ? "The app serves the release it was serving before, from the same artifact bytes."
          : "The app has never activated a release, so it will answer once you publish one.",
        "Grants are unchanged; anyone who could open it before can open it again.",
      ],
      costDeltaUsd: 0,
      risk: "medium",
      warnings: [],
      requiresApproval: false,
      blocked: !owner.ok
        ? owner.reason
        : app.state === "active"
          ? `${app.name} is already active. There is nothing to resume.`
          : app.state !== "suspended"
            ? `${app.name} is ${app.state}, which resume does not undo.`
            : undefined,
    };
  },
  execute(ctx, input) {
    try {
      const app = appFor(ctx, input.appId);
      releaseDeps.requireAppRole(app.id, subjectOf(ctx), "owner");
      const { job, created } = admitResume({
        jobId: input.jobId,
        appId: app.id,
        workspaceId: ctx.workspaceId,
        actor: subjectOf(ctx),
        reason: input.reason,
      });
      return {
        ok: true,
        summary: created
          ? `Resuming “${app.name}”. Job ${job.id} is queued.`
          : `Job ${job.id} was already resuming this app (${job.status}).`,
        data: { jobId: job.id, job, created },
      };
    } catch (err) {
      return refusal(err, "Resume hosted app");
    }
  },
});
