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
 * project that is not this node's) throws `OperationRefused`. Once dispatch is
 * claimed, provider/receipt errors become an unconfirmed launch and cannot replay.
 *
 * `startBuild` requires the canonical PostgreSQL launch authority. A permanent
 * operation/service claim commits before StartBuild; provider token expiry
 * never permits another dispatch. An accepted id is retained and read back;
 * a lost response without a receipt remains uncertain and refuses replay.
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
import { BatchGetBuildsCommand, BatchGetProjectsCommand, CodeBuildClient, StartBuildCommand, StopBuildCommand, type Build, type Project } from "@aws-sdk/client-codebuild";
import type { AwsSession } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import type { Broker } from "@/lib/capabilities/platform";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { digest as bindingDigest } from "@/lib/controlplane/digest";
import * as launches from "@/lib/controlplane/db/repos/build-launches";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { hash6 } from "@/lib/providers/aws/drivers/shared";
import { OperationRefused, assertNodeTags, lowerTagMap, sleep } from "./support/sdk";
import { sourcePrefixFor, loadProject, sourceBucketOf, dockerBuildspec } from "./codebuild-project";
import { contextDirFromBuildspec, hostsFromBuildspec } from "./codebuild-isolation";
import { allowlistDigest, BUILD_ISOLATION_PROFILES, type BuildAttestation } from "@/lib/execution/build-isolation";

type Ctx = DriverContext<AwsSession>;

const SOURCE_KEY = /^([A-Za-z0-9_.-]{1,128})\/([0-9a-f]{64})\.zip$/;
const HEX64 = /^(?:sha256:)?([0-9a-f]{64})$/;
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The durable inventory owns retries. Do not let an SDK resend an ambiguous StartBuild. */
class SingleAttemptCodeBuildClient extends CodeBuildClient {
  constructor(config: Record<string, unknown>) { super({ ...config, maxAttempts: 1 }); }
}

export interface StartBuildInput {
  /** `zenith/<environment>/<service>/<digest>.zip` in the project's source bucket */
  sourceS3Key: string;
  /** sha256 of the source bundle (with or without the `sha256:` prefix); becomes the image tag `src-<hex>` */
  sourceDigest: string;
  /** the project's ARN, when known; otherwise it is found by tags */
  externalId?: string;
  /** The canonical managed workload whose immutable launch identity this is. */
  service?: Pick<ResourceNode, "address" | "specDigest">;
}

export interface StartBuildResult {
  buildId: string;
  status: string;
  buildNumber?: number;
  requestIds: string[];
}

export async function startBuild(ctx: Ctx, node: ResourceNode, input: StartBuildInput, db?: Sql): Promise<StartBuildResult> {
  return launchBuild(ctx,node,input,db);
}

/** Isolated real-broker composition for authority acceptance, unavailable in production. */
export function createIsolatedBuildLauncherForTests(broker: Broker): typeof startBuild {
  launches.assertIsolatedBuildTestAdmission();
  const claim=launches.createIsolatedBuildClaimerForTests(broker);
  return (ctx,node,input,db) => {
    launches.assertIsolatedBuildTestAdmission();
    return launchBuild(ctx,node,input,db,claim);
  };
}

async function launchBuild(ctx: Ctx, node: ResourceNode, input: StartBuildInput, db?: Sql, claimLaunch: typeof launches.claim = launches.claim): Promise<StartBuildResult> {
  ctx.signal.throwIfAborted();
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
  if ((db as Sql & { kind?: string } | undefined)?.kind !== "postgres" || !ctx.operationId || !ctx.fence || !input.service) throw new launches.BuildLaunchError();
  const authority=db!;

  const loaded = await loadProject(ctx, node, input.externalId);
  if (!loaded.project) throw new OperationRefused(`cannot find the build project of ${node.address}: ${loaded.failure?.summary ?? "unknown"}`);
  const project = loaded.project;
  assertNodeTags(ctx, node, lowerTagMap(project.tags), "the CodeBuild project");
  const bucket = sourceBucketOf(project);
  if (!bucket || !project.name || project.source?.type !== "S3" || project.arn !== `arn:aws:codebuild:${ctx.region}:${ctx.session.accountId}:project/${project.name}`) throw new OperationRefused("the project does not name an S3 source bucket in this AWS account and region.");
  // Release images use NO_ARTIFACTS. ProjectArtifacts and BuildArtifacts expose
  // different output shapes; other artifact modes require their own contract.
  if(project.artifacts?.type!=="NO_ARTIFACTS" || project.secondaryArtifacts?.length) throw new OperationRefused("this release adapter requires NO_ARTIFACTS without secondary artifacts.");
  const executedSettings=executedSettingsDigest(project);
  // Verify stored bytes at preflight. Independent S3/CodeBuild reads are not
  // an atomic guarantee against a customer changing the object afterwards.
  const source=await ctx.session.client(S3Client).send(new HeadObjectCommand({Bucket:bucket,Key:key,ExpectedBucketOwner:ctx.session.accountId,ChecksumMode:"ENABLED"}),{abortSignal:ctx.signal});
  if(source.ChecksumSHA256!==Buffer.from(digest,"hex").toString("base64") || !source.ContentLength || source.ContentLength>32*1024*1024) throw new OperationRefused("the stored source bundle has no matching checksum or usable size.");

  const binding: launches.BuildLaunchBinding = { workspaceId:ctx.workspaceId, operationId:ctx.operationId, environmentId:ctx.environmentId,
    serviceAddress:input.service.address, serviceSpecDigest:input.service.specDigest, pipelineAddress:node.address, pipelineSpecDigest:node.specDigest,
    accountId:ctx.session.accountId, region:ctx.region, projectArn:project.arn, projectName:project.name,
    sourceBucket:bucket, sourceKey:key, sourceDigest:digest, settingsDigest:settingsDigest(project), executedSettingsDigest:executedSettings };
  ctx.signal.throwIfAborted();
  // The repository's paired canonical broker evaluates after all blocking
  // locks; no caller can supply a boolean, callback or stale dispatch proof.
  const claim=await claimLaunch(authority,binding,ctx.fence);
  if(!claim.claimed) {
    if(!claim.launch.build_id) throw new launches.BuildLaunchError();
    const readback=await readExactBuild(ctx,claim.launch,authority);
    return { buildId:claim.launch.build_id,status:readback.buildStatus ?? "IN_PROGRESS",requestIds:claim.launch.request_ids ?? [] };
  }

  const cb = ctx.session.client(SingleAttemptCodeBuildClient);
  // Provider idempotency is defence in depth. The durable claim supplies the no-replay rule.
  const token = `zn-${ctx.operationId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100)}-${hash6(input.service.address)}`;
  try {
    ctx.signal.throwIfAborted();
    const res = await cb.send(
    new StartBuildCommand({
      projectName: project.name,
      sourceLocationOverride: `${bucket}/${key}`,
      environmentVariablesOverride: [{ name: "ZENITH_SOURCE_DIGEST", value: digest, type: "PLAINTEXT" }],
      idempotencyToken: token,
      autoRetryLimitOverride: 0,
    }),
    { abortSignal: ctx.signal }
  );
    const build = res.build;
    if (!build?.id || build.projectName!==project.name || build.arn!==`arn:aws:codebuild:${ctx.region}:${ctx.session.accountId}:build/${build.id}` || !res.$metadata?.requestId) throw new launches.BuildLaunchError();
    await launches.acknowledge(authority,claim.launch,build.id,[res.$metadata.requestId]);
    ctx.log(`build started for ${node.address}: ${build.id}`);
    return { buildId: build.id, status: build.buildStatus ?? "IN_PROGRESS", ...(build.buildNumber !== undefined ? { buildNumber: build.buildNumber } : {}), requestIds: [res.$metadata.requestId] };
  } catch { throw new launches.BuildLaunchError(); }
}

/** Hash provider settings only; neither settings nor environment values enter the journal. */
function settingsDigest(project: Project): string {
  const keys = ["source","secondarySources","sourceVersion","secondarySourceVersions","artifacts","secondaryArtifacts","environment","serviceRole","vpcConfig","encryptionKey","timeoutInMinutes","queuedTimeoutInMinutes","cache","logsConfig","concurrentBuildLimit","projectVisibility","fileSystemLocations","autoRetryLimit"] as const;
  return bindingDigest(Object.fromEntries(keys.flatMap(key=>project[key]===undefined?[]:[[key,project[key]]])));
}

/**
 * Hash only configuration returned by BOTH Project and Build (AWS API_Build,
 * API_Project). Source location and the one digest variable are checked against
 * the launch binding separately. No other environment/source setting is omitted.
 */
function executedSettingsDigest(value: Project | Build): string {
  const environment=value.environment, variables=environment?.environmentVariables;
  if(!value.source || !environment || !environment.type || !environment.image || !environment.computeType
    || !Array.isArray(variables) || !value.serviceRole || value.timeoutInMinutes===undefined
    || value.queuedTimeoutInMinutes===undefined) throw new launches.BuildLaunchError();
  const names=new Set<string>();
  for(const variable of variables) {
    if(!variable.name || variable.value===undefined || !variable.type || names.has(variable.name)) throw new launches.BuildLaunchError();
    names.add(variable.name);
  }
  const {location:_location,...source}=value.source;
  const vars=variables.filter(v=>v.name!=="ZENITH_SOURCE_DIGEST").sort((a,b)=>a.name!<b.name! ? -1 : a.name!>b.name! ? 1 : 0);
  const artifact=value.artifacts;
  return bindingDigest({source,sourceVersion:value.sourceVersion ?? null,
    secondarySources:value.secondarySources ?? [],secondarySourceVersions:value.secondarySourceVersions ?? [],
    environment:{...environment,environmentVariables:vars},serviceRole:value.serviceRole,
    encryptionKey:value.encryptionKey ?? null,vpcConfig:value.vpcConfig ?? null,
    timeoutInMinutes:value.timeoutInMinutes,queuedTimeoutInMinutes:value.queuedTimeoutInMinutes,
    cache:value.cache ?? null,fileSystemLocations:value.fileSystemLocations ?? [],
    // NO_ARTIFACTS has no output location/checksum. These shared configuration
    // fields retain their API defaults; any actual output is refused below.
    artifact:{artifactIdentifier:artifact?.artifactIdentifier ?? null,encryptionDisabled:artifact?.encryptionDisabled ?? false,
      overrideArtifactName:artifact?.overrideArtifactName ?? false,bucketOwnerAccess:artifact?.bucketOwnerAccess ?? "NONE"},
  });
}

/** Exact provider acknowledgement + fresh independent terminal read. No terminal UI projection is consulted. */
async function readExactBuild(ctx: Ctx, launch: launches.BuildLaunch, db: Sql): Promise<Build> {
  try {
  const b=launch.binding;
  if(ctx.workspaceId!==b.workspaceId || ctx.operationId!==b.operationId || ctx.environmentId!==b.environmentId
    || ctx.session.accountId!==b.accountId || ctx.region!==b.region || !launch.build_id) throw new launches.BuildLaunchError();
  const cb=ctx.session.client(CodeBuildClient);
  const projectRead=await cb.send(new BatchGetProjectsCommand({names:[b.projectName]}),{abortSignal:ctx.signal});
  const project=projectRead.projects?.[0];
  if(projectRead.projects?.length!==1 || projectRead.projectsNotFound?.length || !project || project.arn!==b.projectArn || settingsDigest(project)!==b.settingsDigest) throw new launches.BuildLaunchError();
  const tags=lowerTagMap(project.tags);
  if(tags["zenith:workspace"]!==b.workspaceId || tags["zenith:environment"]!==b.environmentId || tags["zenith:managed"]!=="true" || tags["zenith:resource"]!==b.pipelineAddress) throw new launches.BuildLaunchError();
  const response=await cb.send(new BatchGetBuildsCommand({ids:[launch.build_id]}),{abortSignal:ctx.signal});
  const build=response.builds?.[0];
  if(response.builds?.length!==1 || response.buildsNotFound?.length || !build || build.id!==launch.build_id
    || build.arn!==`arn:aws:codebuild:${b.region}:${b.accountId}:build/${launch.build_id}` || build.projectName!==b.projectName
    || build.source?.type!=="S3" || build.source.location!==`${b.sourceBucket}/${b.sourceKey}`) throw new launches.BuildLaunchError();
  const sourceVars=build.environment?.environmentVariables?.filter(v=>v.name==="ZENITH_SOURCE_DIGEST");
  if(sourceVars?.length!==1 || sourceVars[0].value!==b.sourceDigest || sourceVars[0].type!=="PLAINTEXT"
    || build.artifacts?.location || build.artifacts?.md5sum || build.artifacts?.sha256sum || build.secondaryArtifacts?.length
    || executedSettingsDigest(build)!==b.executedSettingsDigest) throw new launches.BuildLaunchError();
  const retry=build.autoRetryConfig;
  if((retry?.autoRetryLimit!==undefined && retry.autoRetryLimit!==0)
    || (retry?.autoRetryNumber!==undefined && retry.autoRetryNumber!==0)
    || retry?.nextAutoRetry || retry?.previousAutoRetry) throw new launches.BuildLaunchError();
  if(launch.phase==="terminal" && (build.buildStatus!==launch.terminal_status || build.buildComplete!==true
    || !build.endTime || build.endTime.getTime()!==Date.parse(launch.provider_finished_at ?? ""))) throw new launches.BuildLaunchError();
  if(build.buildStatus!=="IN_PROGRESS" && build.buildComplete!==true) throw new launches.BuildLaunchError();
  if(build.buildComplete===true) {
    if(!build.endTime || !["SUCCEEDED","FAILED","FAULT","TIMED_OUT","STOPPED"].includes(build.buildStatus ?? "") || !response.$metadata?.requestId) throw new launches.BuildLaunchError();
    await launches.observeTerminal(db,launch,{status:build.buildStatus as launches.BuildTerminalStatus,finishedAt:build.endTime,requestId:response.$metadata.requestId});
  }
  return build;
  } catch { throw new launches.BuildLaunchError(); }
}

/**
 * The isolation the EXECUTED build carried, read from the build record the
 * provider returned (never from the request). The egress/metadata guard is
 * admitted only when the executed buildspec is byte-for-byte what Zenith
 * generates for the allowlist it declares; any other buildspec is reported as
 * unrestricted, which release admission refuses.
 */
export function awsBuildAttestation(build: Build): BuildAttestation {
  const profile = BUILD_ISOLATION_PROFILES.aws;
  const spec = build.source?.buildspec;
  const hosts = hostsFromBuildspec(spec);
  const guarded = hosts !== undefined && spec !== undefined && spec.trimEnd() === dockerBuildspec(hosts, contextDirFromBuildspec(spec)).trimEnd();
  const role = build.serviceRole ?? "";
  const dedicated = !!profile.identityPattern && profile.identityPattern.test(role);
  return {
    builderId: build.projectName && build.arn ? build.arn.replace(/:build\/.*$/, `:project/${build.projectName}`) : "unknown",
    invocationId: build.id ?? "unknown",
    ...(build.environment?.image ? { builderImage: build.environment.image } : {}),
    ...(build.startTime ? { startedOn: build.startTime.toISOString() } : {}),
    ...(build.endTime ? { finishedOn: build.endTime.toISOString() } : {}),
    isolation: {
      profileId: profile.id,
      identity: { principal: role, dedicated, deployCredentials: dedicated && build.environment?.type === "LINUX_CONTAINER" ? "absent" : "unknown" },
      metadata: { exposes: guarded ? "build_identity_only" : "unknown", mechanism: profile.mechanisms.metadata },
      network: guarded && hosts ? { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: allowlistDigest(hosts), mechanism: profile.mechanisms.network } : { egress: "unrestricted", mechanism: "the executed buildspec is not the Zenith generated guarded buildspec" },
      dependencies: { downloads: guarded ? "allowlisted" : "direct" },
      filesystem: { sourceMount: build.source?.type === "S3" && !build.secondarySources?.length ? "read_only" : "read_write" },
      resources: { timeoutSec: (build.timeoutInMinutes ?? 0) * 60, computeClass: build.environment?.computeType ?? "unknown" },
    },
  };
}

/* ---------------------------------- waiting -------------------------------- */

export type BuildStatus = "SUCCEEDED" | "FAILED" | "FAULT" | "TIMED_OUT" | "STOPPED" | "IN_PROGRESS" | "WAIT_TIMEOUT";

export interface BuildOutcome {
  buildId: string;
  status: BuildStatus;
  /** set only for a successful build that exported a valid digest */
  imageDigest?: string;
  /** Present only after canonical executed-config readback, never a fresh mutable Project lookup. */
  repositoryUri?: string;
  logs: { groupName?: string; streamName?: string; deepLink?: string };
  /** the first phase that did not succeed, e.g. `BUILD` */
  failedPhase?: string;
  failureReason?: string;
  durationSec?: number;
  /** What the executed build carried (PROD-LIFE-09); present on the canonical read-back path. */
  attestation?: BuildAttestation;
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

export async function waitForBuild(ctx: Ctx, buildId: string, opts: WaitOptions = {}, db?: Sql): Promise<BuildOutcome> {
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) throw new OperationRefused("buildId is not a CodeBuild build id (<project>:<uuid>).");
  const timeoutMs = opts.timeoutMs ?? 35 * 60_000;
  const maxPollMs = opts.maxPollMs ?? 15_000;
  let pollMs = opts.pollMs ?? 5_000;
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const cb = ctx.session.client(CodeBuildClient);
  const launch=db && ctx.operationId ? await launches.get(db,ctx.workspaceId,ctx.operationId,buildId) : undefined;
  if(db && !launch) throw new launches.BuildLaunchError();
  let polls = 0;

  for (;;) {
    polls += 1;
    const build = launch && db ? await readExactBuild(ctx,launch,db) : (await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }), { abortSignal: ctx.signal })).builds?.[0];
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
      const repositories=build.environment?.environmentVariables?.filter(v=>v.name==="ZENITH_REPO_URL" && v.type==="PLAINTEXT");
      const repositoryUri=launch && db && repositories?.length===1 ? repositories[0].value : undefined;
      return { ...base, status, imageDigest, ...(repositoryUri ? {repositoryUri} : {}), ...(launch && db ? { attestation: awsBuildAttestation(build) } : {}) };
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
