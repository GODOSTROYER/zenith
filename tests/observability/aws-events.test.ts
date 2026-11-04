import { DescribeServicesCommand, ECSClient, type Service } from "@aws-sdk/client-ecs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AWS_EVENTS_SOURCE_ID, AWS_EVENT_NOTES, classifyEcsMessage, createAwsEventsSource } from "@/lib/observability/sources/aws-events";
import type { EventQuery } from "@/lib/observability/types";
import { ARN, CANARY, ENV, fakeAwsSession, graph, node, scope } from "./_fixtures";

const ecs = mockClient(ECSClient);
beforeEach(() => ecs.reset());

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000);
const signal = () => new AbortController().signal;
const eq = (over: Partial<EventQuery> = {}): EventQuery => ({ scope: scope(), range: { from: at(120).toISOString(), to: at(0).toISOString() }, limit: 200, ...over });

const web = node("service/web", "container_service", "aws", { externalRef: ARN.ecsService("prod", "web") });
const api = node("service/api", "container_service", "aws", { externalRef: ARN.ecsService("prod", "api") });
const other = node("service/other", "container_service", "aws", { externalRef: ARN.ecsService("staging", "other") });

const source = (nodes = [web]) => createAwsEventsSource({ session: fakeAwsSession(), graph: graph(nodes) });

const svc = (name: string, over: Partial<Service> = {}): Service => ({ serviceName: name, events: [], deployments: [], ...over });

describe("ECS service events", () => {
  it("maps events and deployments to NormalizedEvent with classified types", async () => {
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        svc("web", {
          events: [
            { id: "e1", createdAt: at(10), message: "(service web) has reached a steady state." },
            { id: "e2", createdAt: at(20), message: "(service web) was unable to place a task because no container instance met all of its requirements." },
            { id: "e3", createdAt: at(30), message: "(service web) failed to launch a task with (error ResourceInitializationError: unable to pull secrets)." },
          ],
          deployments: [{ id: "ecs-svc/1", status: "PRIMARY", rolloutState: "FAILED", rolloutStateReason: "ECS deployment circuit breaker: tasks failed to start.", updatedAt: at(5), taskDefinition: "arn:td", desiredCount: 2, runningCount: 0, pendingCount: 0, failedTasks: 3 }],
        }),
      ],
    });
    const r = await source().searchEvents!(eq(), signal());
    expect(r.items.map((e) => [e.type, e.severity])).toEqual([
      ["ecs.deployment.failed", "error"],
      ["ecs.service.steady_state", "info"],
      ["ecs.service.placement_failed", "warn"],
      ["ecs.service.task_failed", "error"],
    ]);
    const first = r.items[0];
    expect(first).toMatchObject({ address: "service/web", provider: "aws", environmentId: ENV, message: "ECS deployment circuit breaker: tasks failed to start." });
    expect(first.native).toMatchObject({ cluster: "prod", service: "web", deploymentId: "ecs-svc/1", rolloutState: "FAILED", failedTasks: 3 });
    expect(r.items[1].native).toMatchObject({ ecsEventId: "e1" });
    expect(r.sources).toEqual([AWS_EVENTS_SOURCE_ID]);
    expect(r.simulated).toBe(false);
  });

  it("filters to the requested range and applies the limit", async () => {
    ecs.on(DescribeServicesCommand).resolves({
      services: [svc("web", { events: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, createdAt: at(i * 30), message: `(service web) has started ${i + 1} tasks: (task x).` })) })],
    });
    const r = await source().searchEvents!(eq({ range: { from: at(100).toISOString(), to: at(0).toISOString() }, limit: 3 }), signal());
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.items.every((e) => Date.parse(e.timestamp) >= NOW - 100 * 60_000)).toBe(true);
  });

  it("batches services by cluster, ten at a time", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [] });
    const many = Array.from({ length: 12 }, (_, i) => node(`service/s${i}`, "container_service", "aws", { externalRef: ARN.ecsService("prod", `s${i}`) }));
    await source([...many, other]).searchEvents!(eq(), signal());
    const calls = ecs.commandCalls(DescribeServicesCommand).map((c) => c.args[0].input);
    expect(calls.filter((c) => c.cluster === "prod").map((c) => c.services!.length).sort((a, b) => a - b)).toEqual([2, 10]);
    expect(calls.filter((c) => c.cluster === "staging")).toHaveLength(1);
  });

  it("always carries the honest notes: 100-event retention, no CloudTrail, target health is not an event", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [svc("web")] });
    const r = await source().searchEvents!(eq(), signal());
    expect(r.notes).toEqual([...AWS_EVENT_NOTES]);
    expect(r.notes!.join(" ")).toMatch(/latest 100 events/);
    expect(r.notes!.join(" ")).toMatch(/CloudTrail/);
    expect(r.notes!.join(" ")).toMatch(/target health/);
  });

  it("redacts secrets an event message may carry", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [svc("web", { events: [{ id: "e", createdAt: at(1), message: `(service web) failed to start: DB_URL=postgres://a:${CANARY.dbUrlPassword}@db/x password=${CANARY.password}` }] })] });
    const r = await source().searchEvents!(eq(), signal());
    expect(JSON.stringify(r)).not.toContain(CANARY.dbUrlPassword);
    expect(JSON.stringify(r)).not.toContain(CANARY.password);
    expect(r.items[0].native.redacted).toBe(true);
  });

  it("reports DescribeServices failures (MISSING services) as unavailable", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [svc("api", { events: [{ id: "e", createdAt: at(1), message: "(service api) has reached a steady state." }] })], failures: [{ arn: ARN.ecsService("prod", "web"), reason: "MISSING" }] });
    const r = await source([web, api]).searchEvents!(eq(), signal());
    expect(r.items).toHaveLength(1);
    expect(r.unavailable[0].reason).toMatch(/MISSING/);
  });

  it("a failing cluster is unavailable while another cluster still answers", async () => {
    ecs.on(DescribeServicesCommand, { cluster: "prod" }).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    ecs.on(DescribeServicesCommand, { cluster: "staging" }).resolves({ services: [svc("other", { events: [{ id: "e", createdAt: at(1), message: "(service other) has reached a steady state." }] })] });
    const r = await source([web, other]).searchEvents!(eq(), signal());
    expect(r.items.map((e) => e.address)).toEqual(["service/other"]);
    expect(r.unavailable).toEqual([{ source: AWS_EVENTS_SOURCE_ID, reason: "cluster prod: AccessDeniedException: denied" }]);
    expect(r.sources).toEqual([AWS_EVENTS_SOURCE_ID]);
  });

  it("unresolvable services are unavailable and cause no call", async () => {
    ecs.on(DescribeServicesCommand).resolves({ services: [] });
    const r = await source([node("service/bare", "container_service", "aws")]).searchEvents!(eq(), signal());
    expect(ecs.commandCalls(DescribeServicesCommand)).toHaveLength(0);
    expect(r.unavailable[0].reason).toMatch(/service\/bare/);
    expect(r.sources).toEqual([]);
  });

  it("covers only ECS services in the right environment", () => {
    const s = source([web, node("resource/db", "postgres", "aws")]);
    expect(s.covers!(scope())).toBe(true);
    expect(s.covers!(scope({ addresses: ["resource/db"] }))).toBe(false);
    expect(s.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
  });

  it("an abort cancels in-flight calls promptly", async () => {
    ecs.on(DescribeServicesCommand).callsFake(() => new Promise(() => undefined));
    const ctl = new AbortController();
    const pending = source().searchEvents!(eq(), ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("classifyEcsMessage", () => {
  it.each([
    ["(service web) has reached a steady state.", "ecs.service.steady_state", "info"],
    ["(service web) was unable to place a task because no container instance met all of its requirements.", "ecs.service.placement_failed", "warn"],
    ["(service web) has started 2 tasks: (task a) (task b).", "ecs.service.tasks_started", "info"],
    ["(service web) has stopped 1 running tasks: (task a).", "ecs.service.tasks_stopped", "info"],
    ["(service web) (instance i-1) (port 8080) is unhealthy in (target-group tg) due to (reason Health checks failed).", "ecs.service.target_unhealthy", "warn"],
    ["(service web) is unable to consistently start tasks successfully.", "ecs.service.unstable", "error"],
    ["(service web) (deployment ecs-svc/1) deployment completed.", "ecs.service.deployment_completed", "info"],
    ["(service web) has begun draining connections on 1 tasks.", "ecs.service.draining", "info"],
    ["(service web) deregistered 1 targets in (target-group tg)", "ecs.service.target_registration", "info"],
    ["CannotPullContainerError: image not found", "ecs.service.task_failed", "error"],
    ["something entirely new", "ecs.service.event", "info"],
  ])("%s", (message, type, severity) => {
    expect(classifyEcsMessage(message)).toEqual({ type, severity });
  });
});
