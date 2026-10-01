/**
 * Running builds on a `aws:codebuild_project` — the helpers the deploy
 * workflow's build activity calls. They are NOT capability operations (there
 * is no `build.start` capability); the activity already holds the lease and
 * the credential session and passes a `DriverContext` in.
 *
 *   startBuild(ctx, node, { sourceS3Key, sourceDigest })  → { buildId, … }
 *   waitForBuild(ctx, buildId, opts)                      → { status, imageDigest, logs, … }
 *   stopBuild(ctx, buildId)                               → stop a build we gave up waiting for
 *
 * Errors: a request that must not be retried as-is (bad key, bad digest, a
 * project that is not this node's) throws `OperationRefused`; provider errors
 * propagate from the SDK unchanged so the activity can classify and retry.
 *
 * `startBuild` is idempotent per operation: the CodeBuild `idempotencyToken`
 * is derived from the operation id and the node address, so a retried
 * activity gets the SAME build back (CodeBuild honours a token for five
 * minutes; a retry after that would start a second build, which tags the same
 * source digest and is harmless). Without an operation id no token is sent.
 *
 * The image digest comes from the build's EXPORTED VARIABLES
 * (`ZENITH_IMAGE_DIGEST`, see the buildspec in codebuild-project.ts), an API
 * field, and is validated as `sha256:<64 hex>`; a successful build without one
 * is reported as `FAILED` with `failureReason: "no_image_digest"`, because a
 * deployment without a digest to verify must not proceed (ADR-0016).
 *
 * `waitForBuild` only reads. It polls BatchGetBuilds with a growing interval,
 * honours `ctx.signal` (an abort rejects), and gives up at its own deadline
 * with status `WAIT_TIMEOUT` — the build is left running; call `stopBuild` if
 * it should not continue.
 */
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand, StopBuildCommand, type Build } from "@aws-sdk/client-codebuild";
import type { AwsSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { hash6 } from "@/lib/providers/aws/drivers/shared";
import { OperationRefused, assertNodeTags, lowerTagMap, sleep } from "./support/sdk";
import { sourcePrefixFor, loadProject, sourceBucketOf } from "./codebuild-project";

type Ctx = DriverContext<AwsSession>;

const SOURCE_KEY = /^([A-Za-z0-9_.-]{1,128})\/([0-9a-f]{64})\.zip$/;
const HEX64 = /^(?:sha256:)?([0-9a-f]{64})$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface StartBuildInput {
  /** `zenith/<environment>/<service>/<digest>.zip` in the project's source bucket */
  sourceS3Key: string;
  /** sha256 of the source bundle (with or without the `sha256:` prefix); becomes the image tag `src-<hex>` */
  sourceDigest: string;
  /** the project's ARN, when known; otherwise it is found by tags */
  externalId?: string;
}

export interface StartBuildResult {
  buildId: string;
  status: string;
  buildNumber?: number;
  requestIds: string[];
}

export async function startBuild(ctx: Ctx, node: ResourceNode, input: StartBuildInput): Promise<StartBuildResult> {
  const key = input.sourceS3Key;
  const prefix = sourcePrefixFor(ctx.environmentId);
  if (!prefix) throw new OperationRefused("source environment must be a safe identifier without path or wildcard characters.");
  if (typeof key !== "string" || !key.startsWith(prefix)) throw new OperationRefused("sourceS3Key must be under this environment's zenith/ source prefix.");
  const parts = SOURCE_KEY.exec(key.slice(prefix.length));
  if (!parts || parts[0] !== key.slice(prefix.length) || [".", ".."].includes(parts[1])) throw new OperationRefused("sourceS3Key is not a valid digest-addressed ZIP object key.");
  const digestMatch = typeof input.sourceDigest === "string" ? HEX64.exec(input.sourceDigest) : null;
  const digest = digestMatch?.[0] === input.sourceDigest ? digestMatch?.[1] : undefined;
  if (!digest) throw new OperationRefused("sourceDigest must be a sha256 (64 hex characters).");
  if (parts[2] !== digest) throw new OperationRefused("sourceS3Key does not match sourceDigest.");

  const loaded = await loadProject(ctx, node, input.externalId);
  if (!loaded.project) throw new OperationRefused(`cannot find the build project of ${node.address}: ${loaded.failure?.summary ?? "unknown"}`);
  const project = loaded.project;
  assertNodeTags(ctx, node, lowerTagMap(project.tags), "the CodeBuild project");
  const bucket = sourceBucketOf(project);
  if (!bucket || !project.name || project.source?.type !== "S3") throw new OperationRefused("the project does not name an S3 source bucket.");

  const cb = ctx.session.client(CodeBuildClient);
  const token = ctx.operationId ? `zn-${ctx.operationId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100)}-${hash6(node.address)}` : undefined;
  const res = await cb.send(
    new StartBuildCommand({
      projectName: project.name,
      sourceLocationOverride: `${bucket}/${key}`,
      environmentVariablesOverride: [{ name: "ZENITH_SOURCE_DIGEST", value: digest, type: "PLAINTEXT" }],
      ...(token ? { idempotencyToken: token } : {}),
    }),
    { abortSignal: ctx.signal }
  );
  const build = res.build;
  if (!build?.id) throw new Error("StartBuild returned no build id.");
  ctx.log(`build started for ${node.address}: ${build.id}`);
  return { buildId: build.id, status: build.buildStatus ?? "IN_PROGRESS", ...(build.buildNumber !== undefined ? { buildNumber: build.buildNumber } : {}), requestIds: res.$metadata?.requestId ? [res.$metadata?.requestId] : [] };
}

/* ---------------------------------- waiting -------------------------------- */

export type BuildStatus = "SUCCEEDED" | "FAILED" | "FAULT" | "TIMED_OUT" | "STOPPED" | "IN_PROGRESS" | "WAIT_TIMEOUT";

export interface BuildOutcome {
  buildId: string;
  status: BuildStatus;
  /** set only for a successful build that exported a valid digest */
  imageDigest?: string;
  logs: { groupName?: string; streamName?: string; deepLink?: string };
  /** the first phase that did not succeed, e.g. `BUILD` */
  failedPhase?: string;
  failureReason?: string;
  durationSec?: number;
  polls: number;
}

export interface WaitOptions {
  /** give up waiting after this long (default 35 minutes: build timeout 30 + queue slack) */
  timeoutMs?: number;
  pollMs?: number;
  maxPollMs?: number;
  /** a successful build must export an image digest (registry output); default true */
  expectImageDigest?: boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function failedPhaseOf(build: Build): string | undefined {
  return (build.phases ?? []).find((p) => p.phaseStatus && p.phaseStatus !== "SUCCEEDED" && p.phaseStatus !== "IN_PROGRESS")?.phaseType;
}

function digestOf(build: Build): string | undefined {
  const v = (build.exportedEnvironmentVariables ?? []).find((e) => e.name === "ZENITH_IMAGE_DIGEST")?.value;
  return v !== undefined && IMAGE_DIGEST.test(v) ? v : undefined;
}

export async function waitForBuild(ctx: Ctx, buildId: string, opts: WaitOptions = {}): Promise<BuildOutcome> {
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) throw new OperationRefused("buildId is not a CodeBuild build id (<project>:<uuid>).");
  const timeoutMs = opts.timeoutMs ?? 35 * 60_000;
  const maxPollMs = opts.maxPollMs ?? 15_000;
  let pollMs = opts.pollMs ?? 5_000;
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const cb = ctx.session.client(CodeBuildClient);
  let polls = 0;

  for (;;) {
    polls += 1;
    const res = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }), { abortSignal: ctx.signal });
    const build = res.builds?.[0];
    if (!build) throw new OperationRefused(`build ${buildId} was not found.`);
    const logs = { ...(build.logs?.groupName ? { groupName: build.logs.groupName } : {}), ...(build.logs?.streamName ? { streamName: build.logs.streamName } : {}), ...(build.logs?.deepLink ? { deepLink: build.logs.deepLink } : {}) };
    if (build.buildComplete || (build.buildStatus && build.buildStatus !== "IN_PROGRESS")) {
      const status = (build.buildStatus ?? "FAILED") as BuildStatus;
      const durationSec = build.startTime && build.endTime ? Math.max(0, Math.round((build.endTime.getTime() - build.startTime.getTime()) / 1000)) : undefined;
      const base = { buildId, logs, polls, ...(durationSec !== undefined ? { durationSec } : {}) };
      if (status !== "SUCCEEDED") return { ...base, status, ...(failedPhaseOf(build) ? { failedPhase: failedPhaseOf(build) } : {}) };
      if (opts.expectImageDigest === false) return { ...base, status };
      const imageDigest = digestOf(build);
      if (!imageDigest) return { ...base, status: "FAILED", failureReason: "no_image_digest" };
      return { ...base, status, imageDigest };
    }
    if (now() + pollMs > deadline) return { buildId, status: "WAIT_TIMEOUT", logs, polls };
    await wait(pollMs, ctx.signal);
    pollMs = Math.min(maxPollMs, Math.round(pollMs * 1.5));
  }
}

/** Stop a build (for example after `WAIT_TIMEOUT`). Idempotent: stopping a finished build is an error the caller may ignore. */
export async function stopBuild(ctx: Ctx, buildId: string): Promise<{ status?: string; requestIds: string[] }> {
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) throw new OperationRefused("buildId is not a CodeBuild build id (<project>:<uuid>).");
  const cb = ctx.session.client(CodeBuildClient);
  const res = await cb.send(new StopBuildCommand({ id: buildId }), { abortSignal: ctx.signal });
  return { status: res.build?.buildStatus, requestIds: res.$metadata?.requestId ? [res.$metadata?.requestId] : [] };
}
