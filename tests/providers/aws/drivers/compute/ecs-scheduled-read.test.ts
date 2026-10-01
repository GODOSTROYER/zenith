/**
 * `aws:ecs_scheduled_task` read side: the task definition through ECS, the
 * EventBridge rule / cluster through the tagging API (no EventBridge client is
 * installed, so the schedule itself is never claimed to match).
 */
import { DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ecsScheduledTaskDriver as driver } from "@/lib/providers/aws/drivers/compute/ecs-scheduled-task";
import { buildFixture, mkDriverContext, zenithTagList } from "./fixtures";
import { ACCOUNT, stoppedTask, taskDefinition } from "./ecs-mocks";

const ecs = mockClient(ECSClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => {
  ecs.restore();
  tagging.restore();
});
beforeEach(() => {
  ecs.reset();
  tagging.reset();
});

const fx = buildFixture();
const node = fx.job;
const RULE_ARN = `arn:aws:events:eu-west-1:${ACCOUNT}:rule/zn-acme-nightly`;
const CLUSTER_ARN = `arn:aws:ecs:eu-west-1:${ACCOUNT}:cluster/zn-acme-nightly`;
const td = (rev: number) => `arn:aws:ecs:eu-west-1:${ACCOUNT}:task-definition/zn-acme-nightly:${rev}`;
const tags = () => zenithTagList("scheduled_job/nightly");

function installFound(over: { rule?: boolean; revisions?: number[]; cluster?: boolean } = {}) {
  tagging.on(GetResourcesCommand).callsFake((input: { ResourceTypeFilters?: string[] }) => {
    const type = input.ResourceTypeFilters?.[0];
    const arns =
      type === "events:rule" ? (over.rule === false ? [] : [RULE_ARN]) : type === "ecs:task-definition" ? (over.revisions ?? [3, 12, 9]).map(td) : type === "ecs:cluster" ? (over.cluster === false ? [] : [CLUSTER_ARN]) : [];
    return { ResourceTagMappingList: arns.map((ResourceARN) => ({ ResourceARN, Tags: tags() })) };
  });
  ecs.on(DescribeTaskDefinitionCommand).callsFake((input: { taskDefinition: string }) => ({
    taskDefinition: taskDefinition({
      taskDefinitionArn: input.taskDefinition,
      family: "zn-acme-nightly",
      cpu: "256",
      memory: "512",
      containerDefinitions: [{ name: "nightly", image: "ghcr.io/acme/job:1.4.2", logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/zenith/nightly" } } }],
    }),
  }));
}

describe("observe", () => {
  it("externalId is the EventBridge rule ARN; the newest task-definition revision is read; ids and tags are in native", async () => {
    installFound();
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs).toMatchObject({ presence: "present", externalId: RULE_ARN, source: "aws.ecs_scheduled_task@1", simulated: false });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({ cpu: 256, memoryMb: 512, image: "ghcr.io/acme/job:1.4.2" });
    expect(ecs.commandCalls(DescribeTaskDefinitionCommand)[0].args[0].input.taskDefinition).toBe(td(12));
    expect(obs.native).toMatchObject({ ruleArn: RULE_ARN, taskDefinitionArn: td(12), clusterArn: CLUSTER_ARN, clusterName: "zn-acme-nightly", logGroupName: "/zenith/nightly", tags: expect.objectContaining({ "zenith:managed": "true" }) });
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(driver.expectedAttributes!(node)).sort());
    const types = tagging.commandCalls(GetResourcesCommand).map((c) => c.args[0].input.ResourceTypeFilters![0]);
    expect(types).toEqual(["events:rule", "ecs:task-definition", "ecs:cluster"]);
  });

  it("uses a rule ARN given as externalId without a tag lookup for the rule", async () => {
    installFound();
    await driver.observe!(mkDriverContext(), node, RULE_ARN);
    const types = tagging.commandCalls(GetResourcesCommand).map((c) => c.args[0].input.ResourceTypeFilters![0]);
    expect(types).not.toContain("events:rule");
  });

  it("a job with no schedule is identified by its task definition", async () => {
    installFound();
    const unscheduled = { ...node, spec: { ...node.spec, schedule: undefined } };
    const obs = await driver.observe!(mkDriverContext(), unscheduled);
    expect(obs).toMatchObject({ presence: "present", externalId: td(12) });
  });

  it("missing when the rule or the task definition is not found", async () => {
    installFound({ rule: false });
    const noRule = await driver.observe!(mkDriverContext(), node);
    expect(noRule.presence).toBe("missing");
    expect(noRule.error).toMatch(/EventBridge rule/);
    tagging.reset();
    installFound({ revisions: [] });
    const noTd = await driver.observe!(mkDriverContext(), node);
    expect(noTd.presence).toBe("missing");
    expect(noTd.error).toMatch(/task definition/);
  });

  it("degrades the task-definition attributes when DescribeTaskDefinition is denied", async () => {
    installFound();
    ecs.on(DescribeTaskDefinitionCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("present");
    for (const a of Object.values(obs.attributes)) expect(a).toMatchObject({ state: "unknown", reason: "access_denied" });
  });

  it("classifies tag-lookup failures and re-throws an abort", async () => {
    tagging.on(GetResourcesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await driver.observe!(mkDriverContext(), node)).presence).toBe("inaccessible");
    const ac = new AbortController();
    tagging.on(GetResourcesCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(driver.observe!(mkDriverContext({ signal: ac.signal }), node)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("two rules with the node's tags is ambiguous, not a guess", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: RULE_ARN, Tags: tags() }, { ResourceARN: `${RULE_ARN}-2`, Tags: tags() }] });
    expect((await driver.observe!(mkDriverContext(), node)).presence).toBe("unknown");
  });
});

describe("verify", () => {
  it("never passes: the rule's schedule cannot be read, so that check stays unknown", async () => {
    installFound();
    const obs = await driver.observe!(mkDriverContext(), node);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("unknown");
    expect(v.checks.find((c) => c.id === "schedule_observable")).toMatchObject({ passed: "unknown", detail: expect.stringMatching(/client-eventbridge is not installed/) });
    expect(v.checks.filter((c) => c.id !== "schedule_observable").every((c) => c.passed === true)).toBe(true);
  });

  it("fails when the task definition is the wrong size, and when the rule is missing", async () => {
    installFound();
    ecs.on(DescribeTaskDefinitionCommand).resolves({ taskDefinition: taskDefinition({ cpu: "1024", memory: "4096", containerDefinitions: [{ name: "nightly", image: "ghcr.io/acme/job:9" }] }) });
    const obs = await driver.observe!(mkDriverContext(), node);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:cpu", "attr:image", "attr:memoryMb"]);
    tagging.reset();
    installFound({ rule: false });
    const missing = await driver.observe!(mkDriverContext(), node);
    expect(await driver.verify!(mkDriverContext(), node, missing)).toMatchObject({ status: "failed", checks: [{ id: "exists", passed: false }] });
  });
});

describe("runtime", () => {
  const install = (stopped: ReturnType<typeof stoppedTask>[], running = 0) => {
    installFound();
    ecs.on(ListTasksCommand).callsFake((input: { desiredStatus?: string }) => ({
      taskArns: input.desiredStatus === "STOPPED" ? stopped.map((t) => t.taskArn!) : Array.from({ length: running }, (_, i) => `arn:aws:ecs:eu-west-1:${ACCOUNT}:task/zn-acme-nightly/r${i}`),
    }));
    ecs.on(DescribeTasksCommand).resolves({ tasks: stopped });
  };
  const clean = () => stoppedTask({ stopCode: "EssentialContainerExited", stoppedReason: "Essential container in task exited", containers: [{ name: "nightly", exitCode: 0 }] });
  const failed = () => stoppedTask({ stopCode: "EssentialContainerExited", stoppedReason: "Essential container in task exited", containers: [{ name: "nightly", exitCode: 1 }] });

  it("a job whose recent runs exited 0 is healthy (a clean exit is success, not a failure)", async () => {
    install([clean(), clean()], 0);
    const r = await driver.runtime!(mkDriverContext(), node);
    expect(r).toMatchObject({ health: "healthy", counts: { running: 0, stoppedSampled: 2, stoppedFailures: 0 }, signals: [] });
    const list = ecs.commandCalls(ListTasksCommand).map((c) => c.args[0].input);
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ cluster: "zn-acme-nightly", family: "zn-acme-nightly", desiredStatus: "STOPPED" }), expect.objectContaining({ desiredStatus: "RUNNING" })]));
  });

  it("degraded when some runs failed, unhealthy when all did, with exit codes as signals", async () => {
    install([clean(), failed()]);
    expect(await driver.runtime!(mkDriverContext(), node)).toMatchObject({ health: "degraded", signals: ["task_stopped:EssentialContainerExited", "exit_code:1"] });
    ecs.reset();
    tagging.reset();
    install([failed(), failed()]);
    expect((await driver.runtime!(mkDriverContext(), node)).health).toBe("unhealthy");
  });

  it("unknown health with no_recent_runs when nothing has run yet", async () => {
    install([], 0);
    expect(await driver.runtime!(mkDriverContext(), node)).toMatchObject({ health: "unknown", signals: ["no_recent_runs"] });
  });

  it("counts running executions and keeps going when the stopped-task read is denied", async () => {
    installFound();
    ecs.on(ListTasksCommand).callsFake((input: { desiredStatus?: string }) => {
      if (input.desiredStatus === "STOPPED") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      return { taskArns: ["a", "b"] };
    });
    const r = await driver.runtime!(mkDriverContext(), node);
    expect(r.counts.running).toBe(2);
    expect(r.signals).toContain("stopped_tasks_unreadable");
    expect(r.health).toBe("unknown");
  });

  it("unknown with job_not_found when the cluster or task definition cannot be located", async () => {
    installFound({ cluster: false });
    expect(await driver.runtime!(mkDriverContext(), node)).toMatchObject({ health: "unknown", signals: ["job_not_found"] });
  });
});
