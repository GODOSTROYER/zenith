import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { CLOUDWATCH_LOGS_SOURCE_ID, createCloudWatchLogsSource, insightsQuery, parseEcsLogStream, type CloudWatchLogsSource } from "@/lib/observability/sources/aws-cloudwatch-logs";
import type { LogQuery, NormalizedLog } from "@/lib/observability/types";
import { ARN, CANARY, ENV, WS, fakeAwsSession, graph, node, scope } from "./_fixtures";

const cw = mockClient(CloudWatchLogsClient);
beforeEach(() => cw.reset());
afterEach(() => cw.reset());

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const at = (minAgo: number) => NOW - minAgo * 60_000;
const range = (minutes: number) => ({ from: new Date(at(minutes)).toISOString(), to: new Date(NOW).toISOString() });
const q = (over: Partial<LogQuery> = {}): LogQuery => ({ scope: scope(), range: range(60), limit: 200, ...over });
const signal = () => new AbortController().signal;

const web = node("service/web", "container_service", "aws", { spec: { logGroup: "/ecs/prod/web" } });
const worker = node("service/worker", "container_service", "aws");
const workerLogs = node("log_group/worker", "log_group", "aws", { spec: { name: "/ecs/prod/worker" } });
const db = node("resource/db", "postgres", "aws");

function source(nodes = [web], extra: Partial<Parameters<typeof createCloudWatchLogsSource>[0]> = {}): CloudWatchLogsSource {
  return createCloudWatchLogsSource({ session: fakeAwsSession(), graph: graph(nodes), ...extra });
}

function ev(minAgo: number, message: string, over: Partial<FilteredLogEvent> = {}): FilteredLogEvent {
  return { timestamp: at(minAgo), message, logStreamName: "ecs/web/0123456789abcdef0123456789abcdef", eventId: `e-${minAgo}-${message}`, ingestionTime: at(minAgo) + 1000, ...over };
}

/** A fake CloudWatch: serves `events` filtered by the request's start/end, `pageSize` at a time. */
function serve(events: FilteredLogEvent[], pageSize = 1000) {
  cw.on(FilterLogEventsCommand).callsFake((input: { startTime?: number; endTime?: number; nextToken?: string; logGroupName?: string }) => {
    const inWindow = events.filter((e) => e.timestamp! >= input.startTime! && e.timestamp! <= input.endTime!).sort((a, b) => a.timestamp! - b.timestamp!);
    const offset = input.nextToken ? Number(input.nextToken) : 0;
    const page = inWindow.slice(offset, offset + pageSize);
    return { events: page, ...(offset + pageSize < inWindow.length ? { nextToken: String(offset + pageSize) } : {}) };
  });
}

describe("log group resolution", () => {
  it("uses spec.logGroup on the service, a sibling log_group node, or a log_group node directly", async () => {
    serve([]);
    const s = source([web, worker, workerLogs]);
    await s.searchLogs!(q(), signal());
    const groups = cw.commandCalls(FilterLogEventsCommand).map((c) => c.args[0].input.logGroupName);
    expect(new Set(groups)).toEqual(new Set(["/ecs/prod/web", "/ecs/prod/worker"]));
  });

  it("reads a log group name from an ARN observation", async () => {
    serve([]);
    const n = node("log_group/api", "log_group", "aws");
    const s = source([n], { observations: [{ address: "log_group/api", externalId: ARN.logGroup("/ecs/prod/api"), presence: "present", attributes: {}, observedAt: "t", source: "x", simulated: false }] });
    await s.searchLogs!(q(), signal());
    expect(cw.commandCalls(FilterLogEventsCommand)[0].args[0].input.logGroupName).toBe("/ecs/prod/api");
  });

  it("reports nodes with no resolvable log group as unavailable and never guesses a name", async () => {
    serve([]);
    const r = await source([worker]).searchLogs!(q(), signal());
    expect(cw.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0].reason).toMatch(/service\/worker: no log group/);
    expect(r.sources).toEqual([]);
  });

  it("refuses log group names with unexpected characters", async () => {
    serve([]);
    const bad = node("service/x", "container_service", "aws", { spec: { logGroup: "/ecs/x; DROP" } });
    const r = await source([bad]).searchLogs!(q(), signal());
    expect(cw.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
    expect(r.unavailable).toHaveLength(1);
  });

  it("restricts to the addresses in scope and covers only relevant scopes", async () => {
    serve([]);
    const s = source([web, worker, workerLogs, db]);
    await s.searchLogs!(q({ scope: scope({ addresses: ["service/web"] }) }), signal());
    expect(new Set(cw.commandCalls(FilterLogEventsCommand).map((c) => c.args[0].input.logGroupName))).toEqual(new Set(["/ecs/prod/web"]));
    expect(s.covers!(scope({ addresses: ["resource/db"] }))).toBe(false);
    expect(s.covers!(scope({ addresses: ["service/web"] }))).toBe(true);
    expect(s.covers!(scope())).toBe(true);
    expect(s.covers!({ workspaceId: WS, environmentId: "env-other" })).toBe(false);
  });

  it("refuses a scope for another workspace when bound to one", async () => {
    serve([]);
    const s = source([web], { workspaceId: WS });
    expect(s.covers!({ workspaceId: "ws-other", environmentId: ENV })).toBe(false);
    const r = await s.searchLogs!(q({ scope: { workspaceId: "ws-other", environmentId: ENV } }), signal());
    expect(r.items).toEqual([]);
    expect(cw.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });

  it("caps the number of log groups searched and says so", async () => {
    serve([]);
    const nodes = Array.from({ length: 14 }, (_, i) => node(`service/s${i}`, "container_service", "aws", { spec: { logGroup: `/ecs/prod/s${i}` } }));
    const r = await source(nodes).searchLogs!(q(), signal());
    const groups = new Set(cw.commandCalls(FilterLogEventsCommand).map((c) => c.args[0].input.logGroupName));
    expect(groups.size).toBe(10);
    expect(r.notes?.join()).toMatch(/4 more log group/);
  });
});

describe("FilterLogEvents request", () => {
  it("passes startTime/endTime from the range and starts at the newest window", async () => {
    serve([]);
    await source().searchLogs!(q({ range: range(60) }), signal());
    const first = cw.commandCalls(FilterLogEventsCommand)[0].args[0].input;
    expect(first.endTime).toBe(NOW);
    expect(first.startTime).toBe(NOW - 15 * 60_000);
    expect(first.filterPattern).toBeUndefined();
  });

  it("builds the filter pattern as one escaped quoted term", async () => {
    serve([]);
    await source().searchLogs!(q({ text: 'timeout "db" \\ ?OR "x' }), signal());
    const pattern = cw.commandCalls(FilterLogEventsCommand)[0].args[0].input.filterPattern;
    expect(pattern).toBe('"timeout \\"db\\" \\\\ ?OR \\"x"');
  });

  it("neutralizes injection attempts in the text filter (quotes, backticks, pipes, braces, newlines)", async () => {
    for (const text of ['x" ?OR "y', "a`b`c", "a | b", '} { "level": "ERROR"', "line1\nline2 ?OR secret"]) {
      cw.reset();
      serve([]);
      await source().searchLogs!(q({ text }), signal());
      const pattern = cw.commandCalls(FilterLogEventsCommand)[0].args[0].input.filterPattern!;
      expect(pattern.startsWith('"') && pattern.endsWith('"')).toBe(true);
      // exactly one unescaped quote pair: the outer ones
      const unescapedQuotes = pattern.replace(/\\\\/g, "").replace(/\\"/g, "").split('"').length - 1;
      expect(unescapedQuotes).toBe(2);
      expect(pattern).not.toContain("\n");
    }
  });

  it("uses the injected session's client and the abort signal", async () => {
    serve([]);
    const ctl = new AbortController();
    await source().searchLogs!(q(), ctl.signal);
    const opts = (cw.commandCalls(FilterLogEventsCommand)[0].args as unknown as [unknown, { abortSignal?: AbortSignal }])[1];
    // a signal derived from the caller's: it fires when the caller's does
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(opts.abortSignal!.aborted).toBe(false);
    ctl.abort();
    expect(opts.abortSignal!.aborted).toBe(true);
  });
});

describe("normalization", () => {
  it("maps events to NormalizedLog with ECS task and container from the stream name", async () => {
    serve([ev(5, "level=error something failed")]);
    const r = await source().searchLogs!(q(), signal());
    expect(r.items).toHaveLength(1);
    const log = r.items[0];
    expect(log.timestamp).toBe(new Date(at(5)).toISOString());
    expect(log.address).toBe("service/web");
    expect(log.provider).toBe("aws");
    expect(log.environmentId).toBe(ENV);
    expect(log.severity).toBe("error");
    expect(log.native).toMatchObject({
      logGroup: "/ecs/prod/web",
      logStream: "ecs/web/0123456789abcdef0123456789abcdef",
      ecsContainer: "web",
      ecsTaskId: "0123456789abcdef0123456789abcdef",
      severityHeuristic: "level_kv",
    });
    expect(r.sources).toEqual([CLOUDWATCH_LOGS_SOURCE_ID]);
    expect(r.simulated).toBe(false);
  });

  it("infers severity heuristically and records which heuristic fired", async () => {
    serve([
      ev(1, '{"level":"warn","msg":"slow"}'),
      ev(2, "2026-09-30T11:58:00Z ERROR req=1 boom"),
      ev(3, "plain line with no level"),
      ev(4, '{"level":50,"msg":"pino error","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}'),
    ]);
    const r = await source().searchLogs!(q(), signal());
    const by = Object.fromEntries(r.items.map((l) => [l.message.slice(0, 12), l]));
    expect(by['{"level":"wa'].severity).toBe("warn");
    expect(by['{"level":"wa'].native.severityHeuristic).toBe("json_level");
    expect(by["2026-09-30T1"].severity).toBe("error");
    expect(by["2026-09-30T1"].native.severityHeuristic).toBe("keyword");
    expect(by["plain line w"].severity).toBe("unknown");
    expect(by["plain line w"].native).not.toHaveProperty("severityHeuristic");
    expect(by['{"level":50,'].severity).toBe("error");
    expect(by['{"level":50,'].traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("filters by minSeverity", async () => {
    serve([ev(1, "INFO fine"), ev(2, "WARN careful"), ev(3, "ERROR broken"), ev(4, "no level")]);
    const r = await source().searchLogs!(q({ minSeverity: "warn" }), signal());
    expect(r.items.map((l) => l.message)).toEqual(["WARN careful", "ERROR broken"]);
    expect(r.notes?.join()).toMatch(/severity could not be determined/);
  });

  it("redacts secrets in messages and stream names, never returning a canary", async () => {
    serve([ev(1, `login failed password=${CANARY.password} key=${CANARY.awsKeyId} Bearer ${CANARY.bearer}`, { logStreamName: `ecs/web/${"a".repeat(32)}` })]);
    const r = await source().searchLogs!(q(), signal());
    const json = JSON.stringify(r);
    for (const secret of [CANARY.password, CANARY.awsKeyId, CANARY.bearer]) expect(json).not.toContain(secret);
    expect(r.items[0].attributes.redacted).toBe(true);
  });

  it("skips events without a timestamp or message", async () => {
    serve([ev(1, "ok"), { message: "no ts" }, { timestamp: at(2) }]);
    expect((await source().searchLogs!(q(), signal())).items).toHaveLength(1);
  });

  it("parses ECS awslogs stream names and ignores other shapes", () => {
    expect(parseEcsLogStream("ecs/web/abcdef0123456789abcdef0123456789")).toEqual({ prefix: "ecs", container: "web", taskId: "abcdef0123456789abcdef0123456789" });
    expect(parseEcsLogStream("2026/09/30/[$LATEST]abc")).toBeUndefined();
    expect(parseEcsLogStream("single")).toBeUndefined();
    expect(parseEcsLogStream(undefined)).toBeUndefined();
  });
});

describe("newest-first search over bounded pages", () => {
  it("returns the newest `limit` lines even when the range holds far more", async () => {
    // 600 events over 5 hours, one every 30s
    const events = Array.from({ length: 600 }, (_, i) => ev((i * 30) / 60, `line-${i}`, { eventId: `id-${i}` }));
    serve(events, 100);
    const r = await source().searchLogs!(q({ range: range(300), limit: 50 }), signal());
    expect(r.items).toHaveLength(50);
    expect(r.items[0].message).toBe("line-0");
    expect(r.items[49].message).toBe("line-49");
    expect(r.truncated).toBe(true);
    // it did not read the whole 5 hours
    expect(cw.commandCalls(FilterLogEventsCommand).length).toBeLessThan(12);
  });

  it("walks backwards in growing windows until the range start", async () => {
    serve([ev(2, "recent"), ev(200, "old")]);
    const r = await source().searchLogs!(q({ range: range(300), limit: 10 }), signal());
    expect(r.items.map((l) => l.message)).toEqual(["recent", "old"]);
    expect(r.truncated).toBe(false);
    const windows = cw.commandCalls(FilterLogEventsCommand).map((c) => [c.args[0].input.startTime!, c.args[0].input.endTime!]);
    expect(windows[0][1]).toBe(NOW);
    for (let i = 1; i < windows.length; i++) expect(windows[i][1]).toBe(windows[i - 1][0] - 1);
    expect(windows[windows.length - 1][0]).toBe(at(300));
  });

  it("bounds pagination: an endless nextToken cannot make the source loop", async () => {
    cw.on(FilterLogEventsCommand).resolves({ events: [ev(1, "x", { eventId: "same" })], nextToken: "more" });
    const r = await source([web], { limits: { maxCallsPerGroup: 7, maxPagesPerWindow: 3 } }).searchLogs!(q({ range: range(300) }), signal());
    const calls = cw.commandCalls(FilterLogEventsCommand).length;
    expect(calls).toBeLessThanOrEqual(7);
    expect(r.truncated).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/page budget|call budget/);
  });

  it("says when a window could not be read fully", async () => {
    cw.on(FilterLogEventsCommand).callsFake((input: { nextToken?: string }) => ({ events: [ev(1, `p${input.nextToken ?? 0}`, { eventId: `p${input.nextToken ?? 0}` })], nextToken: `${Number(input.nextToken ?? 0) + 1}` }));
    const r = await source([web], { limits: { maxPagesPerWindow: 2, maxCallsPerGroup: 50 } }).searchLogs!(q({ limit: 1 }), signal());
    expect(r.truncated).toBe(true);
    expect(r.notes?.join(" ")).toMatch(/not fully read/);
  });

  it("soft time budget: a hung later window returns the newest lines already read, truncated, with a note", async () => {
    // newest 15-minute window answers; the next call never does
    cw.on(FilterLogEventsCommand).callsFake((input: { endTime?: number }) =>
      input.endTime === NOW ? Promise.resolve({ events: [ev(2, "newest", { eventId: "n1" })] }) : new Promise(() => undefined)
    );
    const r = await source([web], { limits: { softDeadlineMs: 250 } }).searchLogs!(q({ range: range(300), limit: 10 }), signal());
    expect(r.items.map((l) => l.message)).toEqual(["newest"]);
    expect(r.truncated).toBe(true);
    expect(r.unavailable).toEqual([]);
    expect(r.sources).toEqual([CLOUDWATCH_LOGS_SOURCE_ID]);
    expect(r.notes?.join(" ")).toMatch(/time budget \(250 ms\) reached; searched back to /);
  });

  it("soft time budget with nothing read at all is unavailable, not an empty answer", async () => {
    cw.on(FilterLogEventsCommand).callsFake(() => new Promise(() => undefined));
    const r = await source([web], { limits: { softDeadlineMs: 30 } }).searchLogs!(q(), signal());
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.unavailable).toEqual([{ source: CLOUDWATCH_LOGS_SOURCE_ID, reason: "log group /ecs/prod/web: timed out after 30 ms" }]);
  });

  it("the soft budget elapsing is not a caller abort: the caller's own abort still rejects", async () => {
    cw.on(FilterLogEventsCommand).callsFake(() => new Promise(() => undefined));
    const ctl = new AbortController();
    const pending = source([web], { limits: { softDeadlineMs: 60_000 } }).searchLogs!(q(), ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("deduplicates events by id", async () => {
    cw.on(FilterLogEventsCommand).resolves({ events: [ev(1, "dup", { eventId: "same" }), ev(1, "dup", { eventId: "same" })] });
    expect((await source().searchLogs!(q(), signal())).items).toHaveLength(1);
  });
});

describe("failures", () => {
  it("one failing log group is unavailable, the other is still returned", async () => {
    cw.on(FilterLogEventsCommand, { logGroupName: "/ecs/prod/web" }).rejects(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));
    cw.on(FilterLogEventsCommand, { logGroupName: "/ecs/prod/worker" }).resolves({ events: [ev(1, "worker ok")] });
    const r = await source([web, worker, workerLogs]).searchLogs!(q(), signal());
    expect(r.items.map((l) => l.message)).toEqual(["worker ok"]);
    expect(r.unavailable).toEqual([{ source: CLOUDWATCH_LOGS_SOURCE_ID, reason: "log group /ecs/prod/web: AccessDeniedException: not authorized" }]);
    expect(r.sources).toEqual([CLOUDWATCH_LOGS_SOURCE_ID]);
  });

  it("all groups failing yields no sources but never throws", async () => {
    cw.on(FilterLogEventsCommand).rejects(new Error("throttled"));
    const r = await source().searchLogs!(q(), signal());
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.unavailable).toHaveLength(1);
  });

  it("redacts secrets in SDK error messages", async () => {
    cw.on(FilterLogEventsCommand).rejects(new Error(`bad request password=${CANARY.password}`));
    const r = await source().searchLogs!(q(), signal());
    expect(JSON.stringify(r.unavailable)).not.toContain(CANARY.password);
  });

  it("an abort cancels an in-flight call promptly even if the SDK never settles", async () => {
    cw.on(FilterLogEventsCommand).callsFake(() => new Promise(() => undefined));
    const ctl = new AbortController();
    const pending = source().searchLogs!(q(), ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("works through the fabric: timeout on a hung CloudWatch is an unavailable entry", async () => {
    cw.on(FilterLogEventsCommand).callsFake(() => new Promise(() => undefined));
    const fabric = createObservabilityFabric([source()], { timeoutMs: 50, now: () => new Date(NOW) });
    const r = await fabric.searchLogs({ scope: scope(), range: range(60) });
    expect(r.unavailable).toEqual([{ source: CLOUDWATCH_LOGS_SOURCE_ID, reason: "timed out after 50 ms" }]);
  });
});

describe("Logs Insights aggregate", () => {
  const limits = { insightsPollMs: 2, insightsMaxWaitMs: 60 };
  beforeEach(() => {
    cw.on(StopQueryCommand).resolves({});
  });
  const aggregate = (s: CloudWatchLogsSource, text?: string, sig = signal()) => s.aggregate({ scope: scope(), range: range(60), text }, sig);

  it("builds the query from a fixed template with the text as one escaped literal", () => {
    expect(insightsQuery(undefined, 60)).toBe("stats count(*) as matches by bin(60s)");
    expect(insightsQuery('a"b\\c', 120)).toBe('filter @message like "a\\"b\\\\c" | stats count(*) as matches by bin(120s)');
    expect(insightsQuery("x", 5)).toContain("bin(60s)");
  });

  it("starts a query, polls until complete and maps rows to a series", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "q1" });
    cw.on(GetQueryResultsCommand)
      .resolvesOnce({ status: "Running" })
      .resolves({
        status: "Complete",
        results: [
          [{ field: "bin(60s)", value: "2026-09-30 11:02:00.000" }, { field: "matches", value: "4" }],
          [{ field: "bin(60s)", value: "2026-09-30 11:01:00.000" }, { field: "matches", value: "2" }],
          [{ field: "bin(60s)", value: "garbage" }, { field: "matches", value: "9" }],
        ],
        statistics: { recordsMatched: 6, recordsScanned: 100, bytesScanned: 2048 },
      });
    const r = await aggregate(source([web], { limits }), "timeout");
    const start = cw.commandCalls(StartQueryCommand)[0].args[0].input;
    expect(start.logGroupNames).toEqual(["/ecs/prod/web"]);
    expect(start.queryString).toBe('filter @message like "timeout" | stats count(*) as matches by bin(60s)');
    expect(start.startTime).toBe(Math.floor(at(60) / 1000));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].metric).toBe("logs.matching.count");
    expect(r.items[0].points).toEqual([
      { timestamp: "2026-09-30T11:01:00.000Z", value: 2 },
      { timestamp: "2026-09-30T11:02:00.000Z", value: 4 },
    ]);
    expect(r.items[0].native).toMatchObject({ source: "logs-insights", statistics: { recordsMatched: 6 } });
    expect(r.sources).toEqual([CLOUDWATCH_LOGS_SOURCE_ID]);
  });

  it("gives up after the bounded wait, stops the query and reports unavailable", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "q2" });
    cw.on(GetQueryResultsCommand).resolves({ status: "Running" });
    const r = await aggregate(source([web], { limits }));
    expect(r.items).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/did not finish within/);
    expect(cw.commandCalls(StopQueryCommand)[0].args[0].input.queryId).toBe("q2");
  });

  it("reports failed queries", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "q3" });
    cw.on(GetQueryResultsCommand).resolves({ status: "Failed" });
    const r = await aggregate(source([web], { limits }));
    expect(r.unavailable[0].reason).toMatch(/status Failed/);
  });

  it("an abort during polling rejects promptly and stops the query", async () => {
    cw.on(StartQueryCommand).resolves({ queryId: "q4" });
    cw.on(GetQueryResultsCommand).resolves({ status: "Running" });
    const ctl = new AbortController();
    const pending = aggregate(source([web], { limits: { insightsPollMs: 1000, insightsMaxWaitMs: 60_000 } }), undefined, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cw.commandCalls(StopQueryCommand)).toHaveLength(1);
  });

  it("with nothing resolvable, makes no calls", async () => {
    const r = await aggregate(source([worker], { limits }));
    expect(cw.commandCalls(StartQueryCommand)).toHaveLength(0);
    expect(r.unavailable).toHaveLength(1);
  });
});

describe("result shape", () => {
  it("returns logs sorted newest first across groups", async () => {
    cw.on(FilterLogEventsCommand, { logGroupName: "/ecs/prod/web" }).resolves({ events: [ev(10, "web10"), ev(2, "web2")] });
    cw.on(FilterLogEventsCommand, { logGroupName: "/ecs/prod/worker" }).resolves({ events: [ev(5, "worker5")] });
    const r = await source([web, worker, workerLogs]).searchLogs!(q(), signal());
    expect(r.items.map((l: NormalizedLog) => l.message)).toEqual(["web2", "worker5", "web10"]);
    expect(r.items.map((l) => l.address)).toEqual(["service/web", "service/worker", "service/web"]);
  });

  it("caps at the query limit and flags truncation", async () => {
    serve(Array.from({ length: 30 }, (_, i) => ev(i / 10, `m${i}`, { eventId: `i${i}` })));
    const r = await source().searchLogs!(q({ limit: 10 }), signal());
    expect(r.items).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });
});
