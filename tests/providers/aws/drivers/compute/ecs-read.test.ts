/**
 * `aws:ecs_service` observe / runtime / verify / discover against a mocked ECS
 * and Resource Groups Tagging API (aws-sdk-client-mock). Contract evidence
 * only: the responses are hand-written, not recorded from AWS.
 */
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, ListClustersCommand, ListServicesCommand, ListTasksCommand } from "@aws-sdk/client-ecs";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { classifyStop } from "@/lib/providers/aws/drivers/compute/ecs-read";
import { SECRET_CANARY, buildFixture, mkDriverContext, zenithTagList } from "./fixtures";
import { CLUSTER, CLUSTER_ARN, SERVICE_ARN, SERVICE_NAME, TD_ARN, TG_ARN, deployment, service, stoppedTask, taskDefinition } from "./ecs-mocks";

const ecs = mockClient(ECSClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => {
  ecs.restore();
  tagging.restore();
});

const fx = buildFixture();
const node = fx.service;
const driver = ecsServiceDriver;

function installHealthy(over: { service?: Parameters<typeof service>[0]; td?: Parameters<typeof taskDefinition>[0] } = {}) {
  ecs.on(DescribeServicesCommand).resolves({ services: [service(over.service)], failures: [] });
  ecs.on(DescribeTaskDefinitionCommand).resolves({ taskDefinition: taskDefinition(over.td) });
  ecs.on(ListTasksCommand).resolves({ taskArns: [] });
}
function installTagLookup(arns: string[] = [SERVICE_ARN]) {
  tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: arns.map((ResourceARN) => ({ ResourceARN, Tags: zenithTagList("container_service/web") })) });
}

beforeEach(() => {
  ecs.reset();
  tagging.reset();
});

describe("observe", () => {
  it("reads the configuration by externalId and reports only what it read", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(obs).toMatchObject({ address: "container_service/web", externalId: SERVICE_ARN, presence: "present", source: "aws.ecs_service@1", simulated: false });
    const v = (name: string) => (obs.attributes[name] as { state: string; value?: unknown }).value;
    expect(Object.fromEntries(Object.keys(obs.attributes).map((k) => [k, v(k)]))).toEqual({ replicas: 2, cpu: 512, memoryMb: 1024, launchType: "FARGATE", assignPublicIp: false, port: 8080 });
    for (const a of Object.values(obs.attributes)) expect(a.state).toBe("known");
    expect(ecs.commandCalls(DescribeServicesCommand)[0].args[0].input).toMatchObject({ cluster: CLUSTER, services: [SERVICE_NAME], include: ["TAGS"] });
  });

  it("observes exactly the attribute names expectedAttributes declares, in the same units", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(driver.expectedAttributes!(node)).sort());
    // a healthy, matching service verifies clean
    const verification = await driver.verify!(mkDriverContext(), node, obs);
    expect(verification.checks.filter((c) => c.id.startsWith("attr:")).every((c) => c.passed === true)).toBe(true);
  });

  it("gives observability the identifiers it resolves from: cluster, service, target groups, log group, tags", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(obs.native).toMatchObject({
      clusterName: CLUSTER,
      serviceName: SERVICE_NAME,
      targetGroupArns: [TG_ARN],
      logGroupName: "/zenith/web",
      taskDefinition: TD_ARN,
      tags: { "zenith:managed": "true", "zenith:environment": "env_1", "zenith:resource": "container_service/web" },
    });
    expect(JSON.stringify(obs.native).length).toBeLessThanOrEqual(4096);
  });

  it("never returns environment values or secret values, even when the task definition carries them", async () => {
    installHealthy({
      td: {
        containerDefinitions: [{ name: "web", image: "img", environment: [{ name: "API_TOKEN", value: SECRET_CANARY }], secrets: [{ name: "DB", valueFrom: `arn:...${SECRET_CANARY}` }], portMappings: [{ containerPort: 8080 }] }],
      },
    });
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(JSON.stringify(obs)).not.toContain(SECRET_CANARY);
  });

  it("finds the service by its Zenith tags when no externalId is known", async () => {
    installHealthy();
    installTagLookup();
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(SERVICE_ARN);
    const call = tagging.commandCalls(GetResourcesCommand)[0].args[0].input;
    expect(call.ResourceTypeFilters).toEqual(["ecs:service"]);
    expect(call.TagFilters).toEqual(expect.arrayContaining([{ Key: "zenith:resource", Values: ["container_service/web"] }, { Key: "zenith:environment", Values: ["env_1"] }, { Key: "zenith:workspace", Values: ["ws_1"] }]));
  });

  it("does not trust a tag-lookup hit that carries the wrong tags", async () => {
    installHealthy();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: SERVICE_ARN, Tags: zenithTagList("container_service/other") }] });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("missing");
  });

  describe("presence", () => {
    it("missing when the tag index has nothing", async () => {
      tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
      const obs = await driver.observe!(mkDriverContext(), node);
      expect(obs.presence).toBe("missing");
      expect(Object.values(obs.attributes).every((a) => a.state === "unknown")).toBe(true);
      expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
    });

    it("missing when DescribeServices reports MISSING, and when the service is INACTIVE", async () => {
      ecs.on(DescribeServicesCommand).resolves({ services: [], failures: [{ arn: SERVICE_ARN, reason: "MISSING" }] });
      expect((await driver.observe!(mkDriverContext(), node, SERVICE_ARN)).presence).toBe("missing");
      ecs.reset();
      ecs.on(DescribeServicesCommand).resolves({ services: [service({ status: "INACTIVE" })] });
      expect((await driver.observe!(mkDriverContext(), node, SERVICE_ARN)).presence).toBe("missing");
    });

    it("missing on ClusterNotFoundException", async () => {
      ecs.on(DescribeServicesCommand).rejects(Object.assign(new Error("Cluster not found."), { name: "ClusterNotFoundException" }));
      expect((await driver.observe!(mkDriverContext(), node, SERVICE_ARN)).presence).toBe("missing");
    });

    it("inaccessible on access denied, with every attribute unknown/access_denied", async () => {
      ecs.on(DescribeServicesCommand).rejects(Object.assign(new Error("not authorized to perform ecs:DescribeServices"), { name: "AccessDeniedException" }));
      const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
      expect(obs.presence).toBe("inaccessible");
      for (const a of Object.values(obs.attributes)) expect(a).toMatchObject({ state: "unknown", reason: "access_denied" });
    });

    it("unknown (not missing) when throttled", async () => {
      ecs.on(DescribeServicesCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException", $metadata: { httpStatusCode: 400 } }));
      const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
      expect(obs.presence).toBe("unknown");
      expect(obs.error).toMatch(/Throttling/);
    });

    it("unknown when two services carry the same node tags", async () => {
      installTagLookup([SERVICE_ARN, `${SERVICE_ARN}-2`]);
      const obs = await driver.observe!(mkDriverContext(), node);
      expect(obs.presence).toBe("unknown");
      expect(obs.error).toMatch(/2 ECS services carry the tags/);
    });

    it("unknown for an externalId that is not an ECS service ARN naming its cluster", async () => {
      for (const bad of ["web", "arn:aws:ecs:eu-west-1:123456789012:service/web", "arn:aws:s3:::bucket"]) {
        expect((await driver.observe!(mkDriverContext(), node, bad)).presence).toBe("unknown");
      }
      expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
    });
  });

  it("degrades only the task-definition attributes when DescribeTaskDefinition is denied", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [service()] });
    ecs.on(DescribeTaskDefinitionCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.replicas).toMatchObject({ state: "known", value: 2 });
    expect(obs.attributes.launchType).toMatchObject({ state: "known", value: "FARGATE" });
    for (const name of ["cpu", "memoryMb", "port"]) expect(obs.attributes[name]).toMatchObject({ state: "unknown", reason: "access_denied" });
    // and verify refuses to call those "matching"
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.checks.find((c) => c.id === "attr:cpu")!.passed).toBe("unknown");
    expect(v.status).not.toBe("passed");
  });

  it("re-throws an abort instead of reporting it as a missing or unknown object", async () => {
    const ac = new AbortController();
    ecs.on(DescribeServicesCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    await expect(driver.observe!(mkDriverContext({ signal: ac.signal }), node, SERVICE_ARN)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a public IP as drift-worthy observed state", async () => {
    installHealthy({ service: { networkConfiguration: { awsvpcConfiguration: { subnets: ["s"], assignPublicIp: "ENABLED" } } } });
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    expect(obs.attributes.assignPublicIp).toMatchObject({ state: "known", value: true });
    const v = await driver.verify!(mkDriverContext(), node, obs, { address: node.address, health: "healthy", counts: { running: 2, desired: 2, deployments: 1 }, signals: [], observedAt: "", source: "x", simulated: false });
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "attr:assignPublicIp")).toMatchObject({ passed: false });
  });

  it("fails verification when the live configuration differs from the spec", async () => {
    installHealthy({ service: { desiredCount: 5 }, td: { cpu: "256", memory: "512" } });
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("failed");
    const failed = v.checks.filter((c) => c.passed === false).map((c) => c.id).sort();
    expect(failed).toEqual(["attr:cpu", "attr:memoryMb", "attr:replicas", "steady_state"]); // 5 desired, 2 running: not steady either
  });
});

describe("runtime", () => {
  it("healthy when steady: running = desired and one completed deployment", async () => {
    installHealthy();
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r).toMatchObject({ health: "healthy", counts: { desired: 2, running: 2, pending: 0, deployments: 1, stoppedFailures: 0 }, signals: [], simulated: false });
  });

  it("degraded while a rollout is in progress, with pending tasks", async () => {
    installHealthy({ service: { runningCount: 2, pendingCount: 1, deployments: [deployment({ rolloutState: "IN_PROGRESS" }), deployment({ id: "old", status: "ACTIVE" })] } });
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r.health).toBe("degraded");
    expect(r.signals).toEqual(expect.arrayContaining(["rollout_in_progress", "pending_tasks:1"]));
    expect(r.counts.deployments).toBe(2);
  });

  it("unhealthy when the primary deployment's rollout FAILED", async () => {
    installHealthy({ service: { deployments: [deployment({ rolloutState: "FAILED", rolloutStateReason: "ECS deployment circuit breaker: tasks failed to start" })] } });
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r.health).toBe("unhealthy");
    expect(r.signals).toContain("rollout_failed");
    // the free-text reason is data, not a signal
    expect(r.signals.join()).not.toContain("circuit breaker");
  });

  it("unhealthy when nothing runs although tasks are desired; healthy and flagged when scaled to zero", async () => {
    installHealthy({ service: { runningCount: 0, pendingCount: 0 } });
    expect((await driver.runtime!(mkDriverContext(), node, SERVICE_ARN)).health).toBe("unhealthy");
    ecs.reset();
    installHealthy({ service: { desiredCount: 0, runningCount: 0 } });
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r.health).toBe("healthy");
    expect(r.signals).toContain("desired_zero");
  });

  it("turns recent stopped tasks into bounded failure signals, ignoring routine stops", async () => {
    installHealthy({ service: { runningCount: 1 } });
    const tasks = [
      stoppedTask({ stopCode: "EssentialContainerExited", stoppedReason: "Essential container in task exited", containers: [{ name: "web", exitCode: 137, reason: "OutOfMemoryError: Container killed due to memory usage" }] }),
      stoppedTask({ stopCode: "TaskFailedToStart", stoppedReason: "CannotPullContainerError: pull image manifest has been retried 5 time(s)" }),
      stoppedTask({ stopCode: "EssentialContainerExited", stoppedReason: "Essential container in task exited", containers: [{ name: "web", exitCode: 1 }] }),
      stoppedTask(), // routine: a deployment replaced it
      stoppedTask({ stopCode: "UserInitiated", stoppedReason: "Task stopped by user" }),
    ];
    ecs.on(ListTasksCommand).resolves({ taskArns: tasks.map((t) => t.taskArn!) });
    ecs.on(DescribeTasksCommand).resolves({ tasks });
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r.signals).toEqual(["task_stopped:CannotPullContainer", "task_stopped:EssentialContainerExited", "task_stopped:OutOfMemory", "exit_code:1", "exit_code:137"]);
    expect(r.counts.stoppedFailures).toBe(3);
    expect(r.health).toBe("degraded"); // running 1 < desired 2
    expect(ecs.commandCalls(ListTasksCommand)[0].args[0].input).toMatchObject({ cluster: CLUSTER, serviceName: SERVICE_NAME, desiredStatus: "STOPPED", maxResults: 10 });
  });

  it("asks about at most ten stopped tasks even when ECS returns more", async () => {
    installHealthy();
    const arns = Array.from({ length: 25 }, (_, i) => `arn:aws:ecs:eu-west-1:123456789012:task/${CLUSTER}/t${i}`);
    ecs.on(ListTasksCommand).resolves({ taskArns: arns });
    ecs.on(DescribeTasksCommand).resolves({ tasks: [] });
    await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(ecs.commandCalls(DescribeTasksCommand)[0].args[0].input.tasks).toHaveLength(10);
  });

  it("keeps the service verdict when the stopped-task reads are denied", async () => {
    installHealthy();
    ecs.on(ListTasksCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const r = await driver.runtime!(mkDriverContext(), node, SERVICE_ARN);
    expect(r.health).toBe("healthy");
    expect(r.signals).toContain("stopped_tasks_unreadable");
    expect(r.counts).not.toHaveProperty("stoppedFailures");
  });

  it("unhealthy with service_missing for a service that is gone; unknown when it cannot be read", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [], failures: [{ arn: SERVICE_ARN, reason: "MISSING" }] });
    expect(await driver.runtime!(mkDriverContext(), node, SERVICE_ARN)).toMatchObject({ health: "unhealthy", signals: ["service_missing"], counts: {} });
    ecs.reset();
    ecs.on(DescribeServicesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect(await driver.runtime!(mkDriverContext(), node, SERVICE_ARN)).toMatchObject({ health: "unknown", signals: ["access_denied"] });
    ecs.reset();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect(await driver.runtime!(mkDriverContext(), node)).toMatchObject({ health: "unhealthy", signals: ["service_missing"] });
  });
});

describe("classifyStop", () => {
  it("separates real failures from routine stops", () => {
    expect(classifyStop({ stopCode: "ServiceSchedulerInitiated", stoppedReason: "Scaling activity initiated by (deployment x)" })).toBeUndefined();
    expect(classifyStop({ stopCode: "UserInitiated", stoppedReason: "Task stopped by user" })).toBeUndefined();
    expect(classifyStop({ stopCode: "ServiceSchedulerInitiated", stoppedReason: "Task failed ELB health checks in (target-group arn)" })?.class).toBe("FailedHealthChecks");
    expect(classifyStop({ stopCode: "TaskFailedToStart", stoppedReason: "ResourceInitializationError: unable to pull secrets" })?.class).toBe("ResourceInitializationError");
    expect(classifyStop({ stopCode: "SpotInterruption" })?.class).toBe("Interrupted");
    expect(classifyStop({ stopCode: "EssentialContainerExited", containers: [{ exitCode: 0 }] })?.class).toBe("EssentialContainerExited");
  });

  it("treats a one-shot job's clean exit as success", () => {
    expect(classifyStop({ stopCode: "EssentialContainerExited", containers: [{ exitCode: 0 }] }, { oneShot: true })).toBeUndefined();
    expect(classifyStop({ stopCode: "EssentialContainerExited", containers: [{ exitCode: 2 }] }, { oneShot: true })?.exitCodes).toEqual([2]);
  });

  it("never copies the free-text reason into the class", () => {
    const c = classifyStop({ stopCode: "TaskFailedToStart", stoppedReason: `weird ${SECRET_CANARY}` });
    expect(JSON.stringify(c)).not.toContain(SECRET_CANARY);
  });
});

describe("verify", () => {
  const steady = { address: "container_service/web", health: "healthy" as const, counts: { desired: 2, running: 2, pending: 0, deployments: 1 }, signals: [], observedAt: "", source: "x", simulated: false };

  it("passes a matching, steady service and reads the runtime itself when none is given", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    const v = await driver.verify!(mkDriverContext(), node, obs, steady);
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(["exists", "attr:assignPublicIp", "attr:cpu", "attr:launchType", "attr:memoryMb", "attr:port", "attr:replicas", "steady_state"]);
    const v2 = await driver.verify!(mkDriverContext(), node, obs);
    expect(v2.status).toBe("passed");
  });

  it("fails steady state while a rollout runs or has failed, and when counts differ", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    for (const rt of [
      { ...steady, signals: ["rollout_in_progress"], counts: { ...steady.counts, deployments: 2 } },
      { ...steady, signals: ["rollout_failed"], health: "unhealthy" as const },
      { ...steady, counts: { desired: 2, running: 1, pending: 1, deployments: 1 }, health: "degraded" as const },
    ]) {
      const v = await driver.verify!(mkDriverContext(), node, obs, rt);
      expect(v.status).toBe("failed");
      expect(v.checks.find((c) => c.id === "steady_state")!.passed).toBe(false);
    }
  });

  it("is `failed` with only the exists check when the service is missing, and does not read runtime", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [], failures: [{ arn: SERVICE_ARN, reason: "MISSING" }] });
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v).toMatchObject({ status: "failed", checks: [{ id: "exists", passed: false }] });
  });

  it("is `unknown` for steady state when the runtime cannot be read", async () => {
    installHealthy();
    const obs = await driver.observe!(mkDriverContext(), node, SERVICE_ARN);
    ecs.reset();
    ecs.on(DescribeServicesCommand).rejects(Object.assign(new Error("boom"), { name: "ServerException" }));
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.checks.find((c) => c.id === "steady_state")!.passed).toBe("unknown");
    expect(v.status).toBe("unknown");
  });
});

describe("discover", () => {
  it("lists services across clusters as candidates, marks Zenith-tagged ones, never adopts", async () => {
    ecs.on(ListClustersCommand).resolves({ clusterArns: [CLUSTER_ARN, `arn:aws:ecs:eu-west-1:${"123456789012"}:cluster/other`] });
    ecs.on(ListServicesCommand).callsFake((input: { cluster: string }) => ({ serviceArns: input.cluster === CLUSTER_ARN ? [SERVICE_ARN] : [`arn:aws:ecs:eu-west-1:123456789012:service/other/legacy`] }));
    ecs.on(DescribeServicesCommand).callsFake((input: { services: string[] }) => ({
      services: input.services.map((arn) =>
        arn === SERVICE_ARN ? service() : service({ serviceArn: arn, serviceName: "legacy", tags: [{ key: "team", value: "x" }], launchType: "EC2" })
      ),
    }));
    const found = await driver.discover!(mkDriverContext());
    expect(found.map((f) => f.name).sort()).toEqual(["legacy", "zn-acme-web"]);
    for (const f of found) expect(f).toMatchObject({ provider: "aws", kind: "container_service", nativeType: "aws:ecs_service" });
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(byName["zn-acme-web"]).toMatchObject({ externalId: SERVICE_ARN, zenithTagged: true, region: "eu-west-1", attributes: { cluster: CLUSTER, desiredCount: 2, launchType: "FARGATE" } });
    expect(byName.legacy).toMatchObject({ zenithTagged: false });
  });

  it("is bounded: at most 100 candidates and three pages of clusters", async () => {
    let clusterPages = 0;
    ecs.on(ListClustersCommand).callsFake(() => {
      clusterPages += 1;
      return { clusterArns: [`arn:aws:ecs:eu-west-1:123456789012:cluster/c${clusterPages}`], nextToken: `page-${clusterPages}` };
    });
    ecs.on(ListServicesCommand).callsFake((input: { cluster: string }) => ({ serviceArns: Array.from({ length: 60 }, (_, i) => `${input.cluster.replace("cluster/", "service/")}/s${i}`) }));
    ecs.on(DescribeServicesCommand).callsFake((input: { services: string[] }) => ({ services: input.services.map((arn) => service({ serviceArn: arn, serviceName: arn.split("/").pop(), tags: [] })) }));
    const found = await driver.discover!(mkDriverContext());
    expect(found.length).toBeLessThanOrEqual(100);
    expect(clusterPages).toBe(3);
  });

  it("surfaces an access-denied listing as an error, not as an empty inventory", async () => {
    ecs.on(ListClustersCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(driver.discover!(mkDriverContext())).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});

