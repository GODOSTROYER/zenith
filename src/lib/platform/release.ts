/** Provider-selected release ports. AWS behavior is unchanged; sessions never leave a call. */
import { ECRClient, DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import { ECSClient, DescribeTaskDefinitionCommand, DescribeTasksCommand, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { AwsSession } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ArtifactSpec } from "@/lib/resources/specs";
import { digest } from "@/lib/controlplane/digest";
import { StepFailedError, type BuildPort, type MigrationsPort, type WorkloadsPort } from "@/lib/execution";
import { startBuild, waitForBuild, deployImage, waitForServiceSteady } from "@/lib/providers/aws/drivers/compute";
import { describeService, locateService } from "@/lib/providers/aws/drivers/compute/ecs-read";
import { assertNodeTags, lowerTagMap, sleep } from "@/lib/providers/aws/drivers/compute/support/sdk";
import { nodeName } from "@/lib/providers/aws/drivers/shared";
import { createGcpBuildPort, createGcpWorkloadsPort, createGcpMigrationsPort } from "./release-gcp";
import { createOciBuildPort, createOciWorkloadsPort, createOciMigrationsPort } from "./release-oci";
import { createAzureBuildPort, createAzureWorkloadsPort, createAzureMigrationsPort, createAzureReleaseLaunchJournal, type AzureBuildOptions } from "./release-azure";
import { createKubernetesBuildPort, createKubernetesWorkloadsPort, createKubernetesMigrationsPort } from "./release-k8s";

/** Dispatch on the environment's driver context, then each adapter verifies its broker session. */
export function createReleasePorts(options: { db?: Sql; azure?: AzureBuildOptions } = {}): { build: BuildPort; workloads: WorkloadsPort; migrations: MigrationsPort } {
  const azure = { ...options.azure, launches: options.azure?.launches ?? (options.db ? createAzureReleaseLaunchJournal(options.db) : undefined) };
  const ports = {
    aws: { build: createAwsBuildPort(), workloads: createAwsWorkloadsPort(), migrations: createAwsMigrationsPort() },
    gcp: { build: createGcpBuildPort(), workloads: createGcpWorkloadsPort(), migrations: createGcpMigrationsPort() },
    azure: { build: createAzureBuildPort(azure), workloads: createAzureWorkloadsPort(), migrations: createAzureMigrationsPort(azure.launches) },
    kubernetes: { build: createKubernetesBuildPort(), workloads: createKubernetesWorkloadsPort(), migrations: createKubernetesMigrationsPort() },
    oci: { build: createOciBuildPort(), workloads: createOciWorkloadsPort(), migrations: createOciMigrationsPort() },
  };
  const select = (ctx: DriverContext) => {
    if (ctx.provider !== "aws" && ctx.provider !== "gcp" && ctx.provider !== "azure" && ctx.provider !== "kubernetes" && ctx.provider !== "oci") throw new StepFailedError("Release ports are unavailable for this provider.");
    if ((ctx.session as { provider?: string } | undefined)?.provider !== ctx.provider) throw new StepFailedError("Release provider does not match the broker session.");
    return ports[ctx.provider];
  };
  return {
    build: { startBuild: async (ctx, input) => select(ctx).build.startBuild(ctx, input), waitForBuild: async (ctx, handle, opts) => select(ctx).build.waitForBuild(ctx, handle, opts) },
    workloads: { deployImage: async (ctx, node, image, opts) => select(ctx).workloads.deployImage(ctx, node, image, opts), waitSteady: async (ctx, node, opts) => select(ctx).workloads.waitSteady(ctx, node, opts) },
    migrations: { runOneOffTask: async (ctx, node, command, opts) => select(ctx).migrations.runOneOffTask(ctx, node, command, opts) },
  };
}

const awsContext = (ctx: DriverContext): DriverContext<AwsSession> => {
  const session = ctx.session as Partial<AwsSession> | undefined;
  if (session?.provider !== "aws") throw new StepFailedError("This release helper requires an AWS session.");
  return { ...ctx, session: session as AwsSession };
};

export function createAwsBuildPort(): BuildPort {
  // Metadata only, keyed by build id. The CodeBuild project is authoritative;
  // a wait on a different worker recovers its output repository from AWS.
  return {
    async startBuild(ctx, input) {
      return startBuild(awsContext(ctx), input.pipeline, { sourceS3Key: input.source.s3Key, sourceDigest: input.source.digest, externalId: input.pipeline.externalRef });
    },
    async waitForBuild(ctx, handle, opts) {
      const aws = awsContext(ctx);
      const result = await waitForBuild(aws, handle.buildId, opts);
      if (result.status !== "SUCCEEDED") return { status: result.status === "STOPPED" ? "stopped" : ["TIMED_OUT", "WAIT_TIMEOUT"].includes(result.status) ? "timed_out" : "failed", detail: result.failureReason ?? result.failedPhase ?? result.status };
      // CodeBuild's export contains the digest; its project pins the registry
      // URI. Read that identifier, never arbitrary exported environment values.
      const { CodeBuildClient, BatchGetBuildsCommand, BatchGetProjectsCommand } = await import("@aws-sdk/client-codebuild");
      const cb = aws.session.client(CodeBuildClient);
      const build = (await cb.send(new BatchGetBuildsCommand({ ids: [handle.buildId] }), { abortSignal: ctx.signal })).builds?.[0];
      if (!build?.projectName) throw new StepFailedError("Build project metadata is unavailable.");
      const project = (await cb.send(new BatchGetProjectsCommand({ names: [build.projectName] }), { abortSignal: ctx.signal })).projects?.[0];
      const projectTags = lowerTagMap(project?.tags);
      if (projectTags["zenith:workspace"] !== ctx.workspaceId || projectTags["zenith:environment"] !== ctx.environmentId || projectTags["zenith:managed"] !== "true" || !projectTags["zenith:resource"]?.startsWith("build_pipeline/")) throw new StepFailedError("Build output project is outside this environment.");
      const uri = project?.environment?.environmentVariables?.find((v) => v.name === "ZENITH_REPO_URL" && v.type === "PLAINTEXT")?.value;
      if (!uri || !result.imageDigest) throw new StepFailedError("Build finished without an output repository and digest.");
      const match = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9._/-]+)$/.exec(uri);
      if (!match || match[1] !== aws.session.accountId || match[2] !== aws.region) throw new StepFailedError("Build output registry is outside this AWS session.");
      const repos = await aws.session.client(ECRClient).send(new DescribeRepositoriesCommand({ repositoryNames: [match[3]] }), { abortSignal: ctx.signal });
      if (!repos.repositories?.some((r) => r.repositoryUri === uri)) throw new StepFailedError("Build output repository could not be verified.");
      return { status: "succeeded", digest: result.imageDigest, imageUri: `${uri}@${result.imageDigest}` };
    },
  };
}

export function createAwsWorkloadsPort(): WorkloadsPort {
  return {
    async deployImage(ctx, service, image) {
      const artifact = service.spec.artifact as ArtifactSpec | undefined;
      if (artifact?.type === "image") {
        // These task definitions belong to tofu, rather than the built-image
        // pointer. A build step can still return their already pinned image.
        if (artifact.ref !== image.uri || !/@sha256:[a-f0-9]{64}$/.test(image.uri)) throw new StepFailedError("Pin this image digest in the manifest before deploying it.");
        return { detail: "The manifest's pinned image was applied by OpenTofu; waiting for ECS steady state." };
      }
      const result = await deployImage(awsContext(ctx), service, { image: image.uri, externalId: service.externalRef });
      if (!result.ok) throw new StepFailedError(result.summary);
      return { detail: result.summary };
    },
    async waitSteady(ctx, service, opts) {
      const result = await waitForServiceSteady(awsContext(ctx), service, opts);
      return { steady: result.state === "steady", detail: result.state };
    },
  };
}

/**
 * The compute group has no run-one-off helper at this integration base.
 * Use its tag-scoped service resolver and the service's OWN task/network.
 * A stable ECS clientToken prevents duplicate launches; unknown exits refuse
 * to claim success. This adapter has contract evidence only.
 */
export function createAwsMigrationsPort(): MigrationsPort {
  return {
    async runOneOffTask(ctx, node, command, opts) {
      const aws = awsContext(ctx);
      if (!command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new StepFailedError("Migration command must be a nonempty argv vector.");
      const loc = await locateService(aws, node, node.externalRef);
      if (!loc.ok) throw new StepFailedError("Migration service could not be located.");
      const ecs = aws.session.client(ECSClient);
      const service = await describeService(aws, ecs, loc.value);
      if (!service?.taskDefinition || !service.networkConfiguration?.awsvpcConfiguration) throw new StepFailedError("Migration service has no task definition or VPC configuration.");
      assertNodeTags(aws, node, lowerTagMap(service.tags), "Migration service");
      const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition }), { abortSignal: ctx.signal })).taskDefinition;
      const container = td?.containerDefinitions?.find((c) => c.name === nodeName(node.address)) ?? td?.containerDefinitions?.[0];
      if (!container?.name) throw new StepFailedError("Migration container could not be identified.");
      const launched = await ecs.send(new RunTaskCommand({ cluster: loc.value.cluster, taskDefinition: service.taskDefinition, launchType: "FARGATE", count: 1, clientToken: digest(opts.idempotencyKey), networkConfiguration: service.networkConfiguration, overrides: { containerOverrides: [{ name: container.name, command: [...command] }] }, tags: Object.entries(ctx.tags ?? {}).map(([key, value]) => ({ key, value })) }), { abortSignal: ctx.signal });
      const task = launched.tasks?.[0]?.taskArn;
      if (!task || launched.tasks?.length !== 1 || launched.failures?.length) throw new Error("Migration launch did not return a single task; its outcome must be reconciled.");
      const deadline = Date.now() + opts.timeoutMs;
      for (;;) {
        const res = await ecs.send(new DescribeTasksCommand({ cluster: loc.value.cluster, tasks: [task] }), { abortSignal: ctx.signal });
        const observed = res.tasks?.[0];
        if (!observed || res.failures?.length) throw new Error("Migration task state is unknown.");
        if (observed.lastStatus === "STOPPED") {
          const exitCode = observed.containers?.find((c) => c.name === container.name)?.exitCode;
          if (exitCode === undefined) throw new Error("Migration task stopped without an observed exit code.");
          return { exitCode };
        }
        if (Date.now() + 1000 > deadline) throw new Error("Migration task timed out; outcome is unknown.");
        await sleep(1000, ctx.signal);
      }
    },
  };
}
