/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { evaluateRollout, rollback, waitForRollout } from "@/lib/providers/kubernetes/rollout";
import { ANNOTATION } from "@/lib/providers/kubernetes/types";
import { restartWorkload } from "@/lib/providers/kubernetes/ops";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, inNs, networkNode, serviceNode, sessionFor } from "./helpers";

let fake: FakeK8s;
beforeEach(async () => {
  fake = await startFakeK8s();
});
afterEach(async () => {
  await fake.close();
});

const target = { namespace: NS, name: "web" };
const deploy = async (over: Record<string, unknown> = {}) => {
  const { objects } = renderGraph([networkNode(), serviceNode(over)], { environmentId: ENV_ID });
  const r = await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID });
  expect(r.ok).toBe(true);
};
const fast = { pollIntervalMs: 5 };

describe("evaluateRollout", () => {
  const dep = (status: Record<string, unknown>, spec: Record<string, unknown> = { replicas: 3 }, generation = 2) => ({ metadata: { generation }, spec, status });
  it("follows kubectl rollout status", () => {
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 1 })).reason).toMatch(/observe/);
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 2, updatedReplicas: 1, replicas: 3 })).reason).toBe("1 of 3 replicas updated");
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 2, updatedReplicas: 3, replicas: 4 })).reason).toMatch(/old replicas/);
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 2, updatedReplicas: 3, replicas: 3, availableReplicas: 2 })).reason).toBe("2 of 3 updated replicas available");
    const done = evaluateRollout("Deployment", dep({ observedGeneration: 2, updatedReplicas: 3, replicas: 3, availableReplicas: 3, readyReplicas: 3 }));
    expect(done.done).toBe(true);
    expect(done.snapshot).toMatchObject({ desiredReplicas: 3, availableReplicas: 3 });
  });
  it("treats a missing spec.replicas as 1 and a zero-replica deployment as done when nothing remains", () => {
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 2, updatedReplicas: 1, replicas: 1, availableReplicas: 1 }, {})).done).toBe(true);
    expect(evaluateRollout("Deployment", dep({ observedGeneration: 2, replicas: 0 }, { replicas: 0 })).done).toBe(true);
  });
  it("reports ProgressDeadlineExceeded as a failure", () => {
    const r = evaluateRollout("Deployment", dep({ observedGeneration: 2, conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] }));
    expect(r.failed).toBe("ProgressDeadlineExceeded");
  });
  it("evaluates a StatefulSet by ready/updated counts and revisions", () => {
    const sts = (status: Record<string, unknown>) => ({ metadata: { generation: 1 }, spec: { replicas: 2 }, status });
    expect(evaluateRollout("StatefulSet", sts({ observedGeneration: 1, readyReplicas: 1, updatedReplicas: 2 })).reason).toMatch(/1 of 2 replicas ready/);
    expect(evaluateRollout("StatefulSet", sts({ observedGeneration: 1, readyReplicas: 2, updatedReplicas: 2, currentRevision: "a", updateRevision: "b" })).reason).toMatch(/update revision/);
    expect(evaluateRollout("StatefulSet", sts({ observedGeneration: 1, readyReplicas: 2, updatedReplicas: 2, currentRevision: "a", updateRevision: "a" })).done).toBe(true);
  });
});

describe("waitForRollout", () => {
  it("returns complete when the rollout is already finished", async () => {
    await deploy();
    const r = await waitForRollout(target, await sessionFor(fake, []), { ...fast, environmentId: ENV_ID });
    expect(r.state).toBe("complete");
    expect(r.snapshot).toMatchObject({ desiredReplicas: 2, availableReplicas: 2 });
  });

  it("polls until replicas become available", async () => {
    fake.setRolloutMode("manual");
    await deploy();
    const available: number[] = [];
    fake.inject({
      match: (request) => {
        if (request.method === "GET" && request.path.endsWith("/deployments/web")) {
          // Advance only when a poll reads the Deployment, regardless of how
          // long session setup or discovery takes on a loaded machine.
          const replicas = Math.min(available.length, 2);
          fake.setStatus("Deployment", NS, "web", { replicas: 2, updatedReplicas: replicas, availableReplicas: replicas, readyReplicas: replicas });
          available.push(replicas);
        }
        return false;
      },
      status: 200, message: "",
    });
    const r = await waitForRollout(target, await sessionFor(fake, []), { ...fast, timeoutMs: 3000 });
    expect(r.state).toBe("complete");
    expect(r.polls).toBeGreaterThan(2);
    expect(r.polls).toBe(available.length);
    expect(available).toEqual([0, 1, 2]);
    expect(r.snapshot).toMatchObject({ desiredReplicas: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2 });
  });

  it("times out with the last reason, without throwing", async () => {
    fake.setRolloutMode("manual");
    await deploy();
    const r = await waitForRollout(target, await sessionFor(fake, []), { ...fast, timeoutMs: 60 });
    expect(r.state).toBe("timeout");
    expect(r.reason).toMatch(/timed out after 60 ms: 0 of 2 replicas updated/);
  });

  it("fails fast on ProgressDeadlineExceeded", async () => {
    fake.setRolloutMode("manual");
    await deploy();
    fake.setStatus("Deployment", NS, "web", { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] });
    const r = await waitForRollout(target, await sessionFor(fake, []), { ...fast, timeoutMs: 5000 });
    expect(r.state).toBe("failed");
    expect(r.reason).toMatch(/ProgressDeadlineExceeded/);
  });

  it("reports a deleted or never-created Deployment as not_found", async () => {
    const r = await waitForRollout({ namespace: NS, name: "nope" }, await sessionFor(fake, [NS]), fast);
    expect(r.state).toBe("not_found");
  });

  it("stops when aborted, mid-wait or up front", async () => {
    fake.setRolloutMode("manual");
    await deploy();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const r = await waitForRollout(target, await sessionFor(fake, []), { ...fast, timeoutMs: 5000, signal: ac.signal });
    expect(r.state).toBe("aborted");
    const done = new AbortController();
    done.abort();
    await expect(waitForRollout(target, await sessionFor(fake, []), { signal: done.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("retries transient API errors a few times, then surfaces them; auth errors surface immediately", async () => {
    await deploy();
    const session = await sessionFor(fake, []);
    fake.inject({ match: (r) => r.method === "GET" && r.path.endsWith("/deployments/web"), status: 500, message: "flaky", times: 2 });
    expect((await waitForRollout(target, session, fast)).state).toBe("complete");
    fake.clearInjections();
    fake.inject({ match: (r) => r.method === "GET" && r.path.endsWith("/deployments/web"), status: 500, message: "down" });
    await expect(waitForRollout(target, session, fast)).rejects.toMatchObject({ code: "api_error" });
    fake.clearInjections();
    fake.inject({ match: (r) => r.method === "GET" && r.path.endsWith("/deployments/web"), status: 403, message: "no" });
    await expect(waitForRollout(target, session, fast)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("enforces the namespace allowlist", async () => {
    await deploy();
    await expect(waitForRollout({ namespace: "kube-system", name: "coredns" }, await sessionFor(fake, [NS]), fast)).rejects.toMatchObject({ code: "not_found" });
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system" } });
    await expect(waitForRollout({ namespace: "kube-system", name: "coredns" }, await sessionFor(fake, [NS]), fast)).rejects.toMatchObject({ code: "namespace_forbidden" });
  });

  it("waits on a StatefulSet too", async () => {
    fake.seed({ apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "db", namespace: NS }, spec: { replicas: 1 } });
    const r = await waitForRollout({ namespace: NS, name: "db" }, await sessionFor(fake, [NS]), { ...fast, kind: "StatefulSet" });
    expect(r.state).toBe("complete");
  });
});

describe("rollback", () => {
  const image = (tag: string) => ({ artifact: { type: "image", ref: `ghcr.io/acme/web:${tag}` } });
  const live = () => fake.get("Deployment", NS, "web") as any;
  const revision = () => live().metadata.annotations[ANNOTATION.revision];
  const sessionP = () => sessionFor(fake, []);
  const opts = { environmentId: ENV_ID };

  it("restores the previous revision's pod template and keeps everything else Zenith owns", async () => {
    await deploy({ ...image("1.0.0"), replicas: 2, healthPath: "/healthz" });
    await deploy({ ...image("2.0.0"), replicas: 4, healthPath: "/ready" });
    expect(revision()).toBe("2");
    const before = fake.writes().length;

    const r = await rollback(target, await sessionP(), opts);
    expect(r).toMatchObject({ status: "rolled_back", fromRevision: 2, toRevision: 1 });

    const d = live();
    expect(d.spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:1.0.0");
    expect(d.spec.template.spec.containers[0].readinessProbe.httpGet.path).toBe("/healthz");
    // what rollback must NOT touch: the replica count Zenith last applied (4), selector, strategy, labels
    expect(d.spec.replicas).toBe(4);
    expect(d.spec.selector.matchLabels["app.kubernetes.io/name"]).toBe("web");
    expect(d.spec.strategy.rollingUpdate).toEqual({ maxUnavailable: 0, maxSurge: 1 });
    expect(d.metadata.labels["app.kubernetes.io/managed-by"]).toBe("zenith");
    expect(revision()).toBe("3"); // the old ReplicaSet was reused and took the next revision, as kubectl rollout undo does
    expect(fake.list("ReplicaSet", NS)).toHaveLength(2);

    const writes = fake.writes().slice(before);
    expect(writes).toHaveLength(1);
    expect(writes[0].query).toMatchObject({ fieldManager: "zenith", force: "false" });
    expect(writes[0].contentType).toBe("application/apply-patch+yaml");
    const sent = writes[0].body;
    expect(sent.spec.template.metadata.labels["pod-template-hash"]).toBeUndefined();
    expect(sent.spec.replicas).toBe(4);
    expect(sent.spec.selector).toBeDefined();
  });

  it("is idempotent per operation id and does not roll back a second revision on replay", async () => {
    await deploy(image("1.0.0"));
    await deploy(image("2.0.0"));
    const session = await sessionP();
    const first = await rollback(target, session, { ...opts, operationId: "op-1" });
    expect(first.status).toBe("rolled_back");
    const writes = fake.writes().length;
    const replay = await rollback(target, session, { ...opts, operationId: "op-1" });
    expect(replay.status).toBe("already_applied");
    expect(fake.writes().length).toBe(writes);
    expect(live().spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:1.0.0");
    // the marker belongs to what zenith owns: the next declarative apply drops it
    expect(live().metadata.annotations[ANNOTATION.lastRollback]).toBe("op-1");
    await deploy(image("1.0.0"));
    expect(live().metadata.annotations[ANNOTATION.lastRollback]).toBeUndefined();
  });

  it("rolls back to an explicit revision, and is a no-op when already there", async () => {
    await deploy(image("1.0.0"));
    await deploy(image("2.0.0"));
    await deploy(image("3.0.0"));
    const session = await sessionP();
    expect(await rollback(target, session, { ...opts, toRevision: 1 })).toMatchObject({ status: "rolled_back", fromRevision: 3, toRevision: 1 });
    expect(live().spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:1.0.0");
    expect(await rollback(target, session, { ...opts, toRevision: 4 })).toMatchObject({ status: "already_applied" });
  });

  it("refuses when there is nothing to roll back to or the revision is gone", async () => {
    await deploy(image("1.0.0"));
    const session = await sessionP();
    await expect(rollback(target, session, opts)).rejects.toMatchObject({ code: "rollback_unavailable" });
    await deploy(image("2.0.0"));
    await expect(rollback(target, session, { ...opts, toRevision: 9 })).rejects.toMatchObject({ code: "rollback_unavailable" });
    await expect(rollback({ namespace: NS, name: "missing" }, session, opts)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a Deployment Zenith does not own for this environment and writes nothing", async () => {
    await deploy(image("1.0.0"));
    await deploy(image("2.0.0"));
    const before = fake.writes().length;
    // the namespace is allowlisted for this connection, so the refusal is about the object, not the namespace
    await expect(rollback(target, await sessionFor(fake, [NS]), { environmentId: OTHER_ENV })).rejects.toMatchObject({ code: "ownership_conflict" });
    await expect(rollback(target, await sessionP(), { environmentId: OTHER_ENV })).rejects.toMatchObject({ code: "namespace_forbidden" });
    expect(fake.writes().length).toBe(before);
  });

  it("refuses to rewrite a Deployment that has no apply-ownership record for zenith", async () => {
    await deploy(image("1.0.0"));
    const d = live();
    // a Zenith-labeled object created by another tool (client-side), with a revision and history
    fake.remove("Deployment", NS, "web");
    fake.seed({ ...d, metadata: { name: "web", namespace: NS, labels: d.metadata.labels, annotations: { ...d.metadata.annotations, [ANNOTATION.revision]: "2" } } }, "kubectl");
    await expect(rollback(target, await sessionP(), opts)).rejects.toMatchObject({ code: "rollback_unavailable" });
  });

  it("reports a field-manager conflict instead of forcing", async () => {
    await deploy(image("1.0.0"));
    await deploy(image("2.0.0"));
    fake.foreignUpdate("Deployment", NS, "web", "kubectl-set-image", { spec: { template: { spec: { containers: [{ name: "app", image: "hotfix:9" }] } } } });
    const before = fake.writes().length;
    const err = await rollback(target, await sessionP(), opts).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "field_conflict" });
    expect((err as Error).message).toMatch(/does not force/);
    const sent = fake.writes().slice(before);
    expect(sent.every((w) => w.query.force === "false")).toBe(true);
    expect(live().spec.template.spec.containers[0].image).toBe("hotfix:9");
  });

  it("works after a restart and does not fight the operations manager over restartedAt", async () => {
    await deploy(image("1.0.0"));
    await deploy(image("2.0.0"));
    const session = await sessionP();
    const node = inNs(serviceNode());
    const res = await restartWorkload({ provider: "kubernetes", region: "local", workspaceId: "w", environmentId: ENV_ID, operationId: "restart-1", session, signal: new AbortController().signal, log: () => {}, tags: {}, now: () => new Date() }, node);
    expect(res.summary).toMatch(/Restarted/);
    expect(res.ok).toBe(true);
    // like kubectl rollout undo, "previous" after a restart is the pre-restart revision (same image, no marker)
    const prev = await rollback(target, session, opts);
    expect(prev).toMatchObject({ status: "rolled_back", fromRevision: 3, toRevision: 2 });
    expect(live().spec.template.metadata.annotations[ANNOTATION.restartedAt]).toBe("restart-1"); // owned by zenith-ops, untouched
    // an explicit older revision restores that template and still does not contend for the restart marker
    const out = await rollback(target, session, { ...opts, toRevision: 1 });
    expect(out.status).toBe("rolled_back");
    const tpl = live().spec.template;
    expect(tpl.spec.containers[0].image).toBe("ghcr.io/acme/web:1.0.0");
    expect(tpl.metadata.annotations[ANNOTATION.restartedAt]).toBe("restart-1");
  });

  it("enforces the namespace allowlist", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "other" } });
    await expect(rollback({ namespace: "other", name: "web" }, await sessionFor(fake, [NS]), opts)).rejects.toMatchObject({ code: "namespace_forbidden" });
  });
});
