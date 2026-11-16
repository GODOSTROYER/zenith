import { CoreV1Api } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { KUBERNETES_SOURCE_ID, createKubernetesSource, parseLogLines, type KubeEventLike, type KubePodLike, type KubernetesCoreApi, type KubernetesSourceConfig } from "@/lib/observability/sources/kubernetes";
import type { EventQuery, LogQuery } from "@/lib/observability/types";
import { CANARY, ENV, fakeKubeSession, graph, node, scope } from "./_fixtures";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const now = () => new Date(NOW);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const range = (minutes = 60) => ({ from: new Date(NOW - minutes * 60_000).toISOString(), to: new Date(NOW).toISOString() });
const lq = (over: Partial<LogQuery> = {}): LogQuery => ({ scope: scope(), range: range(), limit: 100, ...over });
const eq = (over: Partial<EventQuery> = {}): EventQuery => ({ scope: scope(), range: range(), limit: 100, ...over });
const signal = () => new AbortController().signal;

const web = node("service/web", "container_service", "kubernetes", {
  spec: { namespace: "prod", selector: { app: "web", "app.kubernetes.io/part-of": "shop" }, workloadName: "web", workloadKind: "Deployment" },
});
const nsNode = node("namespace/prod", "kubernetes_namespace", "kubernetes", { spec: { name: "prod" } });

const pod = (name: string, containers: string[] = ["app"]): KubePodLike => ({ metadata: { name }, spec: { containers: containers.map((c) => ({ name: c })) } });

interface FakeOptions {
  pods?: KubePodLike[];
  logs?: Record<string, string | Error | (() => Promise<string>)>;
  events?: KubeEventLike[] | ((fieldSelector: string | undefined) => KubeEventLike[]);
  listPodsError?: Error;
}

/** A fake CoreV1Api recording every call's parameters. */
function fakeApi(opts: FakeOptions = {}) {
  const calls = { listPods: [] as Record<string, unknown>[], logs: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[] };
  const api: KubernetesCoreApi = {
    async listNamespacedPod(p) {
      calls.listPods.push(p);
      if (opts.listPodsError) throw opts.listPodsError;
      return { items: opts.pods ?? [] };
    },
    async readNamespacedPodLog(p) {
      calls.logs.push(p);
      const entry = opts.logs?.[`${p.name}/${p.container ?? ""}`] ?? "";
      if (entry instanceof Error) throw entry;
      return typeof entry === "function" ? entry() : entry;
    },
    async listNamespacedEvent(p) {
      calls.events.push(p);
      const e = typeof opts.events === "function" ? opts.events(p.fieldSelector) : (opts.events ?? []);
      return { items: e };
    },
  };
  return { api, calls };
}

function make(opts: FakeOptions = {}, nodes = [web], extra: Partial<KubernetesSourceConfig> = {}) {
  const fake = fakeApi(opts);
  const source = createKubernetesSource({
    session: fakeKubeSession({ makeApiClient: () => fake.api }),
    graph: graph(nodes),
    now,
    ...extra,
  });
  return { source, ...fake };
}

const line = (msAgo: number, text: string) => `${iso(msAgo).replace("Z", "123456Z")} ${text}`;

describe("client-node v2 contract", () => {
  it("the installed CoreV1Api exposes the three object-parameter methods this source calls", () => {
    for (const m of ["listNamespacedPod", "readNamespacedPodLog", "listNamespacedEvent"] as const) {
      expect(typeof CoreV1Api.prototype[m]).toBe("function");
    }
  });

  it("builds the API through kubeConfig().makeApiClient(CoreV1Api) by default", async () => {
    const { api } = fakeApi({ pods: [pod("web-1")], logs: { "web-1/app": line(1000, "hello") } });
    let received: unknown;
    const source = createKubernetesSource({
      session: fakeKubeSession({
        makeApiClient: (cls: unknown) => {
          received = cls;
          return api;
        },
      }),
      graph: graph([web]),
      now,
    });
    const r = await source.searchLogs!(lq(), signal());
    expect(received).toBe(CoreV1Api);
    expect(r.items).toHaveLength(1);
  });

  it("a session whose kubeConfig is not a KubeConfig is unavailable, not a crash", async () => {
    const source = createKubernetesSource({ session: fakeKubeSession({ nothing: true }), graph: graph([web]), now });
    const r = await source.searchLogs!(lq(), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/did not return a KubeConfig/);
  });
});

describe("pod logs", () => {
  it("lists pods with the graph's label selector, then reads each container with bounded parameters", async () => {
    const { source, calls } = make({
      pods: [pod("web-2", ["app", "sidecar"]), pod("web-1")],
      logs: { "web-1/app": line(3000, "one"), "web-2/app": line(2000, "two"), "web-2/sidecar": line(1000, "three") },
    });
    const r = await source.searchLogs!(lq({ limit: 50 }), signal());
    expect(calls.listPods).toEqual([{ namespace: "prod", labelSelector: "app=web,app.kubernetes.io/part-of=shop", limit: 50 }]);
    expect(calls.logs).toHaveLength(3);
    for (const c of calls.logs) {
      expect(c).toMatchObject({ namespace: "prod", sinceSeconds: 3600, tailLines: 50, limitBytes: 1024 * 1024, timestamps: true });
    }
    expect(calls.logs.map((c) => `${c.name}/${c.container}`).sort()).toEqual(["web-1/app", "web-2/app", "web-2/sidecar"]);
    expect(r.items.map((l) => l.message)).toEqual(["three", "two", "one"]);
    expect(r.sources).toEqual([KUBERNETES_SOURCE_ID]);
  });

  it("maps pod and container into native and address/provider into the log", async () => {
    const { source } = make({ pods: [pod("web-1")], logs: { "web-1/app": line(1000, "level=error upstream failed") } });
    const [log] = (await source.searchLogs!(lq(), signal())).items;
    expect(log).toMatchObject({ address: "service/web", provider: "kubernetes", environmentId: ENV, severity: "error" });
    expect(log.native).toMatchObject({ namespace: "prod", pod: "web-1", container: "app", severityHeuristic: "level_kv" });
    expect(log.timestamp).toBe(iso(1000));
  });

  it("applies the text filter as a case-sensitive substring, in process", async () => {
    const { source, calls } = make({ pods: [pod("web-1")], logs: { "web-1/app": [line(3000, 'has "quote" and | pipe'), line(2000, "Other"), line(1000, "other")].join("\n") } });
    const r = await source.searchLogs!(lq({ text: '"quote" and |' }), signal());
    expect(r.items.map((l) => l.message)).toEqual(['has "quote" and | pipe']);
    expect((await source.searchLogs!(lq({ text: "other" }), signal())).items).toHaveLength(1);
    // the text never reaches the API — there is nothing to inject into
    expect(JSON.stringify(calls)).not.toContain("quote");
  });

  it("filters by range (the API only takes a relative sinceSeconds) and by severity", async () => {
    const body = [line(90 * 60_000, "ERROR too old"), line(30 * 60_000, "ERROR in range"), line(20 * 60_000, "INFO fine"), line(10 * 60_000, "no level")].join("\n");
    const { source, calls } = make({ pods: [pod("web-1")], logs: { "web-1/app": body } });
    const r = await source.searchLogs!(lq({ range: range(60), minSeverity: "warn" }), signal());
    expect(r.items.map((l) => l.message)).toEqual(["ERROR in range"]);
    expect(calls.logs[0].sinceSeconds).toBe(3600);
    expect(r.notes?.join()).toMatch(/severity could not be determined/);
  });

  it("flags truncation when a container returns a full tail", async () => {
    const body = Array.from({ length: 5 }, (_, i) => line(1000 * (i + 1), `m${i}`)).join("\n");
    const { source } = make({ pods: [pod("web-1")], logs: { "web-1/app": body } });
    expect((await source.searchLogs!(lq({ limit: 5 }), signal())).truncated).toBe(true);
    expect((await source.searchLogs!(lq({ limit: 50 }), signal())).truncated).toBe(false);
  });

  it("redacts secrets in log lines", async () => {
    const { source } = make({ pods: [pod("web-1")], logs: { "web-1/app": line(1000, `connect postgres://u:${CANARY.dbUrlPassword}@db/x token=${CANARY.bearer} ${CANARY.awsKeyId}`) } });
    const r = await source.searchLogs!(lq(), signal());
    const text = JSON.stringify(r);
    for (const secret of [CANARY.dbUrlPassword, CANARY.bearer, CANARY.awsKeyId]) expect(text).not.toContain(secret);
    expect(r.items[0].attributes.redacted).toBe(true);
  });

  it("a namespace node reads every pod in the namespace (no label selector)", async () => {
    const { source, calls } = make({ pods: [pod("a-1"), pod("b-1")], logs: { "a-1/app": line(1000, "a"), "b-1/app": line(2000, "b") } }, [nsNode]);
    const r = await source.searchLogs!(lq(), signal());
    expect(calls.listPods).toEqual([{ namespace: "prod", limit: 50 }]);
    expect(r.items.map((l) => l.address)).toEqual(["namespace/prod", "namespace/prod"]);
  });

  it("caps pods per resource, containers per pod and total container reads", async () => {
    const pods = Array.from({ length: 30 }, (_, i) => pod(`web-${String(i).padStart(2, "0")}`, ["a", "b", "c", "d", "e", "f", "g"]));
    const { source, calls } = make({ pods });
    const r = await source.searchLogs!(lq(), signal());
    expect(calls.logs.length).toBe(30);
    expect(new Set(calls.logs.map((c) => c.name)).size).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true);
    expect(r.notes?.join()).toMatch(/container log\(s\) not read/);
  });

  it("one container failing is unavailable while the others answer", async () => {
    const { source } = make({ pods: [pod("web-1"), pod("web-2")], logs: { "web-1/app": Object.assign(new Error(`container is waiting to start; token=${CANARY.bearer}`), { name: "ApiException" }), "web-2/app": line(1000, "ok") } });
    const r = await source.searchLogs!(lq(), signal());
    expect(r.items.map((l) => l.message)).toEqual(["ok"]);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0].reason).toMatch(/service\/web web-1\/app: ApiException/);
    expect(JSON.stringify(r)).not.toContain(CANARY.bearer);
  });

  it("listing pods failing is unavailable", async () => {
    const { source } = make({ listPodsError: new Error("forbidden: pods is forbidden") });
    const r = await source.searchLogs!(lq(), signal());
    expect(r.unavailable[0].reason).toMatch(/listing pods failed: forbidden/);
    expect(r.sources).toEqual([]);
  });

  it("no pods matching is a note, not an error", async () => {
    const { source } = make({ pods: [] });
    const r = await source.searchLogs!(lq(), signal());
    expect(r.items).toEqual([]);
    expect(r.notes?.join()).toMatch(/no pods matched in namespace prod/);
    expect(r.unavailable).toEqual([]);
  });

  it("an abort cancels an in-flight read even if the API never settles", async () => {
    const { source } = make({ pods: [pod("web-1")], logs: { "web-1/app": () => new Promise(() => undefined) } });
    const ctl = new AbortController();
    const pending = source.searchLogs!(lq(), ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a hung read fails that pod after the per-call timeout while other pods still answer", async () => {
    const { source } = make(
      { pods: [pod("web-1"), pod("web-2")], logs: { "web-1/app": () => new Promise(() => undefined), "web-2/app": line(1000, "ok") } },
      [web],
      { callTimeoutMs: 300 }
    );
    const t0 = Date.now();
    const r = await source.searchLogs!(lq(), signal());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.items.map((l) => l.message)).toEqual(["ok"]);
    expect(r.unavailable).toHaveLength(1);
    expect(r.unavailable[0].reason).toMatch(/service\/web web-1\/app: timed out after 300 ms/);
  });

  it("through the fabric a hung API server is an unavailable entry after the timeout", async () => {
    const { source } = make({ pods: [pod("web-1")], logs: { "web-1/app": () => new Promise(() => undefined) } });
    const r = await createObservabilityFabric([source], { timeoutMs: 60, now }).searchLogs({ scope: scope(), range: range() });
    expect(r.unavailable).toEqual([{ source: KUBERNETES_SOURCE_ID, reason: "timed out after 60 ms" }]);
  });
});

describe("selector safety", () => {
  it("refuses selector labels outside the Kubernetes label grammar instead of splicing them", async () => {
    for (const selector of [{ app: "web,tier=admin" }, { app: "a=b" }, { "app!": "x" }, { app: "" }, { app: "x y" }, { "a b": "x" }, {}]) {
      const bad = node("service/bad", "container_service", "kubernetes", { spec: { namespace: "prod", selector } });
      const { source, calls } = make({ pods: [pod("p")] }, [bad]);
      const r = await source.searchLogs!(lq(), signal());
      expect(calls.listPods).toEqual([]);
      expect(r.unavailable[0].reason).toMatch(/no usable pod selector/);
    }
  });

  it("refuses an invalid namespace", async () => {
    for (const ns of ["Prod", "a b", "x,y", "../etc", "", "a".repeat(64)]) {
      const bad = node("service/bad", "container_service", "kubernetes", { spec: { namespace: ns, selector: { app: "x" } } });
      const { source, calls } = make({ pods: [pod("p")] }, [bad]);
      const r = await source.searchLogs!(lq(), signal());
      expect(calls.listPods).toEqual([]);
      expect(r.unavailable[0].reason).toMatch(/no valid Kubernetes namespace/);
    }
  });

  it("enforces the connection's allowed namespaces", async () => {
    const { source, calls } = make({ pods: [pod("web-1")] }, [web], { allowedNamespaces: ["staging"] });
    const r = await source.searchLogs!(lq(), signal());
    expect(calls.listPods).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/namespace "prod" is not in this connection's allowed namespaces/);
    const ok = make({ pods: [pod("web-1")] }, [web], { allowedNamespaces: ["prod", "staging"] });
    await ok.source.searchLogs!(lq(), signal());
    expect(ok.calls.listPods).toHaveLength(1);
  });

  it("skips pods whose names are not DNS-1123 (they would be spliced into event field selectors)", async () => {
    const { source, calls } = make({ pods: [pod("web-1"), pod("evil,involvedObject.kind=Secret")] });
    await source.searchEvents!(eq(), signal());
    const selectors = calls.events.map((e) => e.fieldSelector);
    expect(selectors).toContain("involvedObject.kind=Pod,involvedObject.name=web-1");
    expect(selectors.join()).not.toContain("Secret");
  });

  it("covers only Kubernetes workload and namespace nodes in its environment", () => {
    const { source } = make({}, [web, node("resource/db", "postgres", "kubernetes"), node("service/aws", "container_service", "aws")]);
    expect(source.covers!(scope())).toBe(true);
    expect(source.covers!(scope({ addresses: ["resource/db"] }))).toBe(false);
    expect(source.covers!(scope({ addresses: ["service/aws"] }))).toBe(false);
    expect(source.covers!({ workspaceId: "ws-1", environmentId: "other" })).toBe(false);
  });
});

describe("events", () => {
  const ev = (msAgo: number, over: Partial<KubeEventLike> = {}): KubeEventLike => ({
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container app in pod web-1",
    count: 7,
    lastTimestamp: iso(msAgo),
    firstTimestamp: iso(msAgo + 60_000),
    reportingComponent: "kubelet",
    involvedObject: { kind: "Pod", name: "web-1", namespace: "prod" },
    ...over,
  });

  it("queries one involvedObject field selector per pod and for the workload", async () => {
    const { source, calls } = make({ pods: [pod("web-1"), pod("web-2")], events: [] });
    await source.searchEvents!(eq({ limit: 30 }), signal());
    expect(calls.events.map((e) => e.fieldSelector).sort()).toEqual([
      "involvedObject.kind=Deployment,involvedObject.name=web",
      "involvedObject.kind=Pod,involvedObject.name=web-1",
      "involvedObject.kind=Pod,involvedObject.name=web-2",
    ]);
    for (const c of calls.events) expect(c).toMatchObject({ namespace: "prod", limit: 30 });
  });

  it("maps events: type, severity, native fields", async () => {
    const { source } = make({
      pods: [pod("web-1")],
      events: (sel) =>
        sel?.includes("Pod")
          ? [ev(5000), ev(9000, { type: "Normal", reason: "Pulled", message: "Successfully pulled image", count: 1 }), ev(7000, { type: "Warning", reason: "FailedScheduling", message: "0/3 nodes are available" })]
          : [],
    });
    const r = await source.searchEvents!(eq(), signal());
    expect(r.items.map((e) => [e.type, e.severity])).toEqual([
      ["k8s.pod.backoff", "error"],
      ["k8s.pod.failedscheduling", "warn"],
      ["k8s.pod.pulled", "info"],
    ]);
    expect(r.items[0]).toMatchObject({ address: "service/web", provider: "kubernetes", environmentId: ENV, timestamp: iso(5000) });
    expect(r.items[0].native).toMatchObject({ namespace: "prod", reason: "BackOff", type: "Warning", count: 7, reportingComponent: "kubelet", involvedObject: { kind: "Pod", name: "web-1" } });
    expect(r.sources).toEqual([KUBERNETES_SOURCE_ID]);
    expect(r.notes?.join()).toMatch(/retains events for a limited time/);
  });

  it("accepts Date objects (client-node v2 models) as well as strings, falls back through timestamps, filters by range", async () => {
    const { source } = make({
      pods: [pod("web-1")],
      events: (sel) =>
        sel?.includes("Pod")
          ? [
              ev(1000, { lastTimestamp: new Date(NOW - 1000) }),
              ev(0, { lastTimestamp: undefined, eventTime: new Date(NOW - 2000), reason: "Created" }),
              ev(0, { lastTimestamp: undefined, eventTime: undefined, firstTimestamp: new Date(NOW - 3000), reason: "Started" }),
              ev(0, { lastTimestamp: undefined, eventTime: undefined, firstTimestamp: undefined, metadata: { creationTimestamp: new Date(NOW - 4000) }, reason: "Scheduled" }),
              ev(3 * 3600_000, { reason: "TooOld" }),
              { type: "Normal", reason: "NoTime", message: "x" },
            ]
          : [],
    });
    const r = await source.searchEvents!(eq(), signal());
    expect(r.items.map((e) => e.native.reason)).toEqual(["BackOff", "Created", "Started", "Scheduled"]);
  });

  it("a namespace node queries the whole namespace's events", async () => {
    const { source, calls } = make({ events: [ev(1000)] }, [nsNode]);
    const r = await source.searchEvents!(eq(), signal());
    expect(calls.events).toEqual([{ namespace: "prod", limit: 100 }]);
    expect(r.items).toHaveLength(1);
  });

  it("redacts secrets in event messages", async () => {
    const { source } = make({ pods: [pod("web-1")], events: (sel) => (sel?.includes("Pod") ? [ev(1000, { message: `Liveness probe failed: token=${CANARY.bearer}` })] : []) });
    const r = await source.searchEvents!(eq(), signal());
    expect(JSON.stringify(r)).not.toContain(CANARY.bearer);
  });

  it("an API failure is unavailable, not a throw", async () => {
    const fake = fakeApi({ pods: [pod("web-1")] });
    fake.api.listNamespacedEvent = async () => {
      throw new Error("events is forbidden");
    };
    const source = createKubernetesSource({ session: fakeKubeSession({ makeApiClient: () => fake.api }), graph: graph([web]), now });
    const r = await source.searchEvents!(eq(), signal());
    expect(r.items).toEqual([]);
    expect(r.unavailable[0].reason).toMatch(/events is forbidden/);
  });
});

describe("parseLogLines", () => {
  it("parses RFC3339Nano timestamps and skips lines without one", () => {
    const body = ["2026-09-30T11:59:59.123456789Z hello world", "no timestamp here", "2026-09-30T11:59:58+00:00 second"].join("\n");
    const r = parseLogLines(body, { fromMs: NOW - 60_000, toMs: NOW });
    expect(r.total).toBe(2);
    expect(r.lines.map((l) => l.message)).toEqual(["hello world", "second"]);
    expect(r.lines[0].timestamp).toBe("2026-09-30T11:59:59.123Z");
  });

  it("handles CRLF and empty bodies", () => {
    expect(parseLogLines("", { fromMs: 0, toMs: NOW }).lines).toEqual([]);
    expect(parseLogLines("2026-09-30T11:59:59Z x\r\n", { fromMs: 0, toMs: NOW }).lines[0].message).toBe("x");
  });
});
