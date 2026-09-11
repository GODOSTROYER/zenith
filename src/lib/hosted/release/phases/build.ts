/**
 * `build` — compile the materialized source with the runner this install
 * selected.
 *
 * The runner is asked through `releaseDeps` rather than imported, because "the
 * build runner is unavailable" and "the build produced nothing" are the two
 * states a real runner will not produce on demand. The build's machine time is
 * recorded whether or not it produced anything: a ledger that only counts
 * successes understates exactly the spending a runaway build causes.
 *
 * Workstream W7 (hosted R3).
 */
import { NO_RUNNER_REASON } from "@/lib/hosted/build";
import { DEFAULT_LIMITS, HostedError, RECIPE_V1 } from "@/lib/hosted/contracts";
import { validateSource } from "@/lib/hosted/source";
import { releaseDeps } from "../deps";
import { buildSlot } from "../build-slot";
import { appendLog, emit, jobWorkPath, reasonOf, type JobRun, type PhaseData } from "../shared";

/** Compile the materialized source with the runner this install selected. */
export async function build(run: JobRun, data: PhaseData): Promise<void> {
  if (typeof data.artifactDigest === "string") {
    appendLog(data, `build skipped: artifact ${data.artifactDigest.slice(0, 12)} was already produced`);
    return;
  }

  const slot = buildSlot(run.job.appId, run.job.id);
  if (!slot.ok)
    throw new HostedError("conflict", slot.reason ?? "No build slot is free.", {
      fix: "Wait for the running build to finish and publish again; this install runs a bounded number of builds at once.",
    });

  const runner = releaseDeps.buildRunner();
  if (!runner)
    throw new HostedError("runtime_unavailable", "No build runner is configured, so nothing was built.", {
      fix: NO_RUNNER_REASON,
    });

  const availability = await runner.availability();
  if (!availability.available)
    throw new HostedError(
      "runtime_unavailable",
      `The ${runner.label} build runner cannot run here: ${availability.reason ?? "it reported itself unavailable."}`,
      { fix: availability.fix ?? NO_RUNNER_REASON }
    );

  const validated = validateSource({ kind: "directory", path: jobWorkPath(run.job.id) });
  if (validated.digest !== data.sourceDigest)
    throw new HostedError(
      "internal",
      "The materialized source no longer hashes to the digest intake recorded, so it was not built.",
      { fix: "Publish again. The job's work directory was modified after intake accepted it." }
    );

  emit({
    event: "build.started",
    workspaceId: run.job.workspaceId,
    appId: run.job.appId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { runner: runner.id },
  });
  appendLog(data, `build started on ${runner.id} (${runner.boundary})`);

  const controller = new AbortController();
  const result = await runner.run(
    {
      jobId: run.job.id,
      appId: run.job.appId,
      source: validated,
      recipe: RECIPE_V1,
      limits: { timeoutMs: DEFAULT_LIMITS.buildTimeoutMs, maxLogBytes: 256_000, memoryMb: 1024 },
    },
    controller.signal
  );

  for (const line of result.logs.slice(-60)) appendLog(data, `[${line.stream}] ${line.line}`);
  data.buildMs = result.durationMs;
  data.buildRunner = result.runner;
  data.buildBoundary = result.boundary;

  // The build cost real machine time whether or not it produced anything, so
  // it is recorded either way; a ledger that only counts successes understates
  // exactly the spending a runaway build causes.
  try {
    releaseDeps.recordUsage({
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      kind: "build_ms",
      amount: result.durationMs,
      note: `${result.runner} build for job ${run.job.id}`,
    });
  } catch (err) {
    appendLog(data, `usage not recorded: ${reasonOf(err)}`);
  }

  if (!result.ok || !result.outputDir) {
    emit({
      event: "build.failed",
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      subject: run.job.actor,
      outcome: "error",
      logicalId: run.job.id,
      props: { runner: runner.id, durationMs: result.durationMs },
    });
    throw new HostedError(
      "unsupported_source",
      result.error ?? `The ${runner.label} runner ended without producing build output.`,
      {
        fix: "Read the job log (GET /api/hosted/apps/<id>/jobs/<jobId>), fix the source, and publish again. The app is still serving its previous release.",
      }
    );
  }

  emit({
    event: "build.succeeded",
    workspaceId: run.job.workspaceId,
    appId: run.job.appId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { runner: runner.id, durationMs: result.durationMs },
  });
  data.outputDir = result.outputDir;
  appendLog(data, `build succeeded in ${result.durationMs} ms`);
}
