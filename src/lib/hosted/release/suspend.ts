/**
 * Suspension: stop admitting requests to an app without destroying anything
 * about it.
 *
 * Suspension is a state on the app record and nothing else. Data stays,
 * grants stay, artifacts stay, releases stay, and the active pointer stays —
 * which is what makes resuming a single word rather than a recovery. The
 * gateway refuses on the state (423) before it reaches a session or an
 * artifact, so no session has to be terminated for suspension to take effect,
 * and terminating them would only cost the recipients their place when the app
 * came back.
 *
 * These are jobs rather than direct writes for one reason: they are operations
 * an operator retries, and a retry with the same job id has to be the same
 * operation.
 *
 * Workstream W7 (hosted R3).
 */
import { admitJob, authority, nowIso } from "@/lib/hosted/authority";
import { HostedError, type HostedApp, type HostedJob, type Subject } from "@/lib/hosted/contracts";
import { setAppState } from "./apps";
import { stateIntent } from "./intent";
import {
  advanceTo,
  appendLog,
  emit,
  failJob,
  phaseDataOf,
  reasonOf,
  requireApp,
  requireAppIn,
  seedPhaseData,
  type JobRun,
} from "./shared";

/** What admitting a suspend or resume needs. */
export interface AdmitStateChangeInput {
  jobId: string;
  appId: string;
  workspaceId: string;
  actor: Subject;
  reason?: string;
}

/** Queue a suspension. Refused when the app is already suspended. */
export function admitSuspend(input: AdmitStateChangeInput): { job: HostedJob; created: boolean } {
  const app = requireAppIn(input.appId, input.workspaceId);
  if (app.state === "suspended")
    throw new HostedError("conflict", `${app.name} is already suspended.`, {
      fix: `Resume it with POST /api/hosted/apps/${app.id}/resume when it should serve again.`,
      details: { appId: app.id, reason: app.stateReason },
    });
  return admitStateChange("suspend", app, input);
}

/** Queue a resume. Refused when the app is not suspended. */
export function admitResume(input: AdmitStateChangeInput): { job: HostedJob; created: boolean } {
  const app = requireAppIn(input.appId, input.workspaceId);
  if (app.state === "active")
    throw new HostedError("conflict", `${app.name} is already active.`, {
      fix: "Nothing to resume. Open the app, or publish a release to it.",
      details: { appId: app.id },
    });
  if (app.state !== "suspended")
    throw new HostedError("conflict", `${app.name} is ${app.state}, which resume does not undo.`, {
      fix: "Only a suspended app can be resumed. Wait for recovery to finish, then try again.",
      details: { appId: app.id, state: app.state },
    });
  return admitStateChange("resume", app, input);
}

function admitStateChange(
  kind: "suspend" | "resume",
  app: HostedApp,
  input: AdmitStateChangeInput
): { job: HostedJob; created: boolean } {
  const { intent } = stateIntent({
    kind,
    appId: input.appId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    reason: input.reason,
  });
  const admitted = admitJob({
    id: input.jobId,
    kind,
    workspaceId: input.workspaceId,
    appId: input.appId,
    actor: input.actor,
    intent,
  });
  if (!admitted.created) return admitted;
  seedPhaseData(input.jobId, {
    reason: input.reason ?? null,
    logs: [`${nowIso()} admitted ${kind} of ${app.slug}`],
  });
  return { job: authority().repos.jobs.get(input.jobId) ?? admitted.job, created: true };
}

/** The default reason recorded when an operator suspends without giving one. */
export const SUSPEND_DEFAULT_REASON =
  "Suspended by an operator. Data, grants, releases and artifacts were kept; the app refuses requests until it is resumed.";

/** Move an app to `suspended`. Sessions are left alone; the gateway refuses on the state. */
export async function runSuspend(run: JobRun): Promise<void> {
  await runStateChange(run, "suspend");
}

/** Move an app back to `active`, clearing the reason it carried. */
export async function runResume(run: JobRun): Promise<void> {
  await runStateChange(run, "resume");
}

async function runStateChange(run: JobRun, kind: "suspend" | "resume"): Promise<void> {
  const data = phaseDataOf(run.job);
  const a = authority();
  try {
    const app = requireApp(run.job.appId);
    advanceTo(run, kind, data);

    const reason =
      kind === "suspend" ? (typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : SUSPEND_DEFAULT_REASON) : null;
    const updated = setAppState(app.id, kind === "suspend" ? "suspended" : "active", reason);

    data.state = updated.state;
    data.previousState = app.state;
    appendLog(data, `${app.slug} is now ${updated.state}${reason ? `: ${reason}` : ""}`);
    emit({
      event: kind === "suspend" ? "app.suspended" : "app.resumed",
      workspaceId: run.job.workspaceId,
      appId: app.id,
      subject: run.job.actor,
      outcome: "ok",
      logicalId: run.job.id,
      props: { from: app.state, to: updated.state },
    });

    advanceTo(run, "finish", data);
    a.repos.jobs.finish(run.job.id, run.fence, { state: updated.state, reason });
    await Promise.resolve();
  } catch (err) {
    if (err instanceof Error && err.name === "LeaseLost") return;
    failJob(run, data, reasonOf(err));
  }
}
