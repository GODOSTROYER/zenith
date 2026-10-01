/** Image rollout and migration behavior over the existing fake HTTP API, never a live cluster. */
import { afterEach, describe, expect, it } from "vitest";
import { StepFailedError } from "@/lib/execution/errors";
import { ANNOTATION, LABEL } from "@/lib/providers/kubernetes/types";
import { NS, OTHER_ENV, sessionFor } from "./helpers";
import { COMMAND, DIGEST, IMAGE, NEXT_DIGEST, NEXT_IMAGE, OPTIONS, finishJobs, releaseWorld, type World } from "./release-fixtures";

const worlds: World[] = [];
const world = async (over: Record<string, unknown> = {}, kind: "Deployment" | "StatefulSet" = "Deployment") => { const w = await releaseWorld(over, kind); worlds.push(w); return w; };
afterEach(async () => { await Promise.all(worlds.splice(0).map((w) => w.fake.close())); });

describe("Kubernetes release image rollout", () => {
  it.each(["Deployment", "StatefulSet"] as const)("applies a digest to %s with zenith SSA and preserves its other fields and other managers", async (kind) => {
    const w = await world({}, kind);
    w.fake.foreignUpdate(kind, NS, "web", "custom-operator", { metadata: { annotations: { custom: "retained" } }, spec: { template: { metadata: { annotations: { custom: "pod" } } } } });
    const before = w.fake.get(kind, NS, "web")!;
    await w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy-key" });
    const after = w.fake.get(kind, NS, "web")!;
    expect(after.spec.replicas).toBe(before.spec.replicas);
    expect(after.spec.selector).toEqual(before.spec.selector);
    expect(after.spec.template.spec.containers[0]).toEqual({ ...before.spec.template.spec.containers[0], image: NEXT_IMAGE });
    expect(after.metadata.annotations.custom).toBe("retained");
    expect(after.spec.template.metadata.annotations.custom).toBe("pod");
    expect(after.metadata.annotations[ANNOTATION.fenceToken]).toBe("7");
    const patch = w.fake.writes().at(-1)!;
    expect(patch.query).toMatchObject({ fieldManager: "zenith", force: "false" });
    expect(patch.contentType).toBe("application/apply-patch+yaml");
    expect(patch.body.metadata).toMatchObject({ uid: before.metadata.uid, resourceVersion: before.metadata.resourceVersion });
    const count = w.fake.writes().length;
    await w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy-key" });
    expect(w.fake.writes()).toHaveLength(count);
    expect(await w.ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 1000 })).toMatchObject({ steady: true });
  });

  it.each([{ uri: "ghcr.io/acme/web:latest", digest: DIGEST }, { uri: IMAGE, digest: NEXT_DIGEST }, { uri: "https://secret@registry.invalid/image", digest: DIGEST }])("refuses an unpinned or mismatched image before API calls", async (image) => {
    const w = await world(); const count = w.fake.requests.length;
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, image, { idempotencyKey: "deploy" })).rejects.toThrow("pre-built");
    expect(w.fake.requests).toHaveLength(count);
  });

  it.each(["environment", "resource", "workspace", "unmanaged"])("refuses foreign %s ownership without a write", async (scope) => {
    const w = await world();
    const annotations = { ...(scope === "environment" ? { [ANNOTATION.environment]: OTHER_ENV } : {}), ...(scope === "resource" ? { [ANNOTATION.resource]: "container_service/other" } : {}), ...(scope === "workspace" ? { "zenith.dev/workspace": "other" } : {}) };
    w.fake.foreignUpdate("Deployment", NS, "web", "other", { metadata: { annotations, ...(scope === "unmanaged" ? { labels: { [LABEL.managedBy]: "other" } } : {}) } });
    const count = w.fake.writes().length;
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow(/outside/);
    await expect(w.ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 1000 })).rejects.toThrow(/outside/);
    expect(w.fake.writes()).toHaveLength(count);
  });

  it("honors namespace allowlists, node ownership and supported native types", async () => {
    const w = await world();
    w.fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } });
    const emptySession = await sessionFor(w.fake, []);
    await expect(w.ports.workloads.waitSteady({ ...w.ctx, session: emptySession }, w.node, { timeoutMs: 1000 })).rejects.toThrow("namespace_forbidden");
    await expect(w.ports.workloads.waitSteady(w.ctx, { ...w.node, ownership: "referenced" }, { timeoutMs: 1000 })).rejects.toThrow("managed");
    await expect(w.ports.workloads.waitSteady(w.ctx, { ...w.node, nativeType: "k8s:CronJob" }, { timeoutMs: 1000 })).rejects.toThrow("Deployment and StatefulSet");
  });

  it("refuses missing SSA ownership", async () => {
    const w = await world();
    const live = w.fake.get("Deployment", NS, "web")!;
    w.fake.remove("Deployment", NS, "web");
    delete live.metadata.managedFields; delete live.metadata.uid; delete live.metadata.resourceVersion;
    w.fake.seed(live);
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow("SSA ownership");
  });

  it("refuses ambiguous containers and unknown or unpinned steady state", async () => {
    const w = await world();
    w.fake.foreignUpdate("Deployment", NS, "web", "sidecar", { spec: { template: { spec: { containers: [{ name: "metrics", image: IMAGE }] } } } });
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow("ambiguous");
    const unpinned = await world({ artifact: { type: "image", ref: "ghcr.io/acme/web:latest" } });
    await expect(unpinned.ports.workloads.waitSteady(unpinned.ctx, unpinned.node, { timeoutMs: 1000 })).rejects.toThrow("pre-built");
    const unknown = await world();
    unknown.fake.setStatus("Deployment", NS, "web", { observedGeneration: undefined });
    expect(await unknown.ports.workloads.waitSteady(unknown.ctx, unknown.node, { timeoutMs: 30 })).toMatchObject({ steady: false });
  });

  it("refuses a stale image apply when resourceVersion or workload UID changes after its read", async () => {
    const w = await world();
    let changed = false;
    w.fake.inject({ match: (r) => {
      if (!changed && r.method === "PATCH" && r.path.endsWith("/deployments/web")) {
        changed = true;
        w.fake.foreignUpdate("Deployment", NS, "web", "other", { metadata: { annotations: { unrelated: "update" } } });
      }
      return false;
    }, status: 200, message: "" });
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow("field_conflict");
    expect(w.fake.get("Deployment", NS, "web")!.spec.template.spec.containers[0].image).toBe(IMAGE);
  });

  it("retries controller status races with fresh preconditions, with a three-attempt bound", async () => {
    for (const races of [1, 3]) {
      const w = await world();
      let updates = 0;
      w.fake.inject({ match: (request) => {
        if (request.method === "PATCH" && request.path.endsWith("/deployments/web") && updates < races) {
          w.fake.setStatus("Deployment", NS, "web", { readyReplicas: ++updates });
        }
        return false;
      }, status: 200, message: "" });
      const apply = w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" });
      if (races === 1) await expect(apply).resolves.toBeDefined();
      else await expect(apply).rejects.toThrow("field_conflict");
      expect(updates).toBe(races);
      expect(w.fake.get("Deployment", NS, "web")!.spec.template.spec.containers[0].image).toBe(races === 1 ? NEXT_IMAGE : IMAGE);
      const patches = w.fake.requests.filter((request) => request.method === "PATCH" && request.path.endsWith("/deployments/web")).slice(1);
      expect(patches).toHaveLength(races === 1 ? 2 : 3);
      for (const patch of patches) expect(patch.query.force).toBe("false");
      expect(new Set(patches.map((patch) => patch.body.metadata.resourceVersion)).size).toBe(patches.length);
    }
  });

  it("never retries against a replacement workload after a precondition conflict", async () => {
    const w = await world();
    let replaced = false;
    w.fake.inject({ match: (request) => {
      if (!replaced && request.method === "PATCH" && request.path.endsWith("/deployments/web")) {
        replaced = true;
        const replacement = w.fake.get("Deployment", NS, "web")!;
        replacement.metadata.uid = "replacement-uid";
        delete replacement.metadata.resourceVersion;
        delete replacement.metadata.managedFields;
        w.fake.remove("Deployment", NS, "web");
        w.fake.seed(replacement);
      }
      return false;
    }, status: 200, message: "" });
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow("field_conflict");
    expect(w.fake.get("Deployment", NS, "web")!.spec.template.spec.containers[0].image).toBe(IMAGE);
    expect(w.fake.requests.filter((request) => request.method === "PATCH" && request.path.endsWith("/deployments/web"))).toHaveLength(2);
  });

  it("does not force an image owned by another manager or echo API secrets", async () => {
    const w = await world();
    w.fake.foreignUpdate("Deployment", NS, "web", "other", { spec: { template: { spec: { containers: [{ name: "app", image: "ghcr.io/acme/web:other" }] } } } });
    await expect(w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" })).rejects.toThrow("field_conflict");
    w.fake.inject({ match: (r) => r.method === "GET" && r.path.endsWith("/deployments/web"), status: 403, message: "unlabelled-secret-canary" });
    await expect(w.ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 1000 })).rejects.toThrow("Kubernetes release refused (forbidden).");
    expect(w.logs.join("")).not.toContain("unlabelled-secret-canary");
  });

  it("reports timeout and controller failure without claiming steady state, and honors cancellation", async () => {
    const w = await world();
    w.fake.setRolloutMode("manual");
    w.fake.setStatus("Deployment", NS, "web", { availableReplicas: 0 });
    expect(await w.ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 30 })).toMatchObject({ steady: false, detail: expect.stringContaining("unknown") });
    w.fake.setStatus("Deployment", NS, "web", { conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] });
    expect(await w.ports.workloads.waitSteady(w.ctx, w.node, { timeoutMs: 1000 })).toMatchObject({ steady: false, detail: expect.stringContaining("progress deadline") });
    await expect(w.ports.workloads.waitSteady({ ...w.ctx, signal: AbortSignal.abort() }, w.node, { timeoutMs: 1000 })).rejects.not.toBeInstanceOf(StepFailedError);
  });
});

describe("Kubernetes migration Jobs", () => {
  it("uses owned pod settings, argv, TTL and bounded reads; recovers the same Job on retry", async () => {
    const w = await world({ env: [{ key: "DB", secretRef: "vault:test/db" }] });
    finishJobs(w);
    const result = await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS);
    expect(result).toMatchObject({ exitCode: 0, logsRef: expect.stringContaining("k8s-job:shop/zenith-migrate-") });
    const claim = w.fake.requests.find((r) => r.method === "PATCH" && r.query.fieldManager === "zenith-release")!;
    expect(claim.contentType).toBe("application/merge-patch+json");
    expect(claim.query).not.toHaveProperty("force");
    const job = w.fake.list("Job", NS)[0];
    const source = w.fake.get("Deployment", NS, "web")!.spec.template.spec;
    expect(job.spec).toMatchObject({ ttlSecondsAfterFinished: 3600, activeDeadlineSeconds: 2, backoffLimit: 0, completions: 1, parallelism: 1 });
    expect(job.spec.template.spec).toMatchObject({ restartPolicy: "Never", securityContext: source.securityContext, volumes: source.volumes, automountServiceAccountToken: source.automountServiceAccountToken });
    expect(job.spec.template.spec.containers[0]).toMatchObject({ command: COMMAND, args: [], image: IMAGE, env: source.containers[0].env, resources: source.containers[0].resources });
    expect(job.spec.template.spec.containers[0]).not.toHaveProperty("livenessProbe");
    expect(job.spec.template.metadata.labels).not.toHaveProperty("app.kubernetes.io/name", "web");
    expect(job.metadata.annotations).toMatchObject({ "zenith.dev/workspace": w.ctx.workspaceId, [ANNOTATION.environment]: w.ctx.environmentId, [ANNOTATION.resource]: w.node.address });
    expect(job.metadata.ownerReferences[0].uid).toBe(w.fake.get("Deployment", NS, "web")!.metadata.uid);
    expect(await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).toEqual(result);
    expect(w.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/jobs"))).toHaveLength(1);
    expect(w.fake.requests.find((r) => r.path.endsWith("/log"))?.query).toMatchObject({ tailLines: "40", limitBytes: "4096", container: "app" });
    expect(w.fake.get("Deployment", NS, "web")!.metadata.annotations).not.toEqual(expect.objectContaining({ command: COMMAND }));
  });

  it("retains launch receipts across a subsequent image SSA apply and refuses relaunch after TTL", async () => {
    const w = await world(); finishJobs(w);
    await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS);
    await w.ports.workloads.deployImage(w.ctx, w.node, { uri: NEXT_IMAGE, digest: NEXT_DIGEST }, { idempotencyKey: "deploy" });
    w.fake.remove("Job", NS, w.fake.list("Job", NS)[0].metadata.name as string);
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.not.toBeInstanceOf(StepFailedError);
    expect(w.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/jobs"))).toHaveLength(1);
  });

  it("rejects key reuse with different argv without another launch", async () => {
    const w = await world(); finishJobs(w);
    await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS);
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, ["different"], OPTIONS)).rejects.toThrow("different input");
    expect(w.fake.list("Job", NS)).toHaveLength(1);
  });

  it("records an observed nonzero exit and redacts credential patterns, argv and inline env values", async () => {
    const secret = "opaque-canary-value";
    const w = await world({ env: [{ key: "PLAIN", value: secret }] });
    finishJobs(w, { exitCode: 13, log: `password=hidden-value Bearer abcdefghijklmnop ${secret} ${COMMAND[2]}\nnormal diagnostics` });
    expect(await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).toMatchObject({ exitCode: 13 });
    const log = w.logs.join("\n");
    expect(log).toContain("normal diagnostics");
    for (const hidden of ["hidden-value", "abcdefghijklmnop", secret, COMMAND[2]]) expect(log).not.toContain(hidden);
  });

  it.each([{ missingExit: true }, { foreignPod: true }])("keeps missing exit or foreign pod state unknown (%j)", async (over) => {
    const w = await world(); finishJobs(w, over);
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.not.toBeInstanceOf(StepFailedError);
    expect(w.logs).toEqual([]);
  });

  it("keeps a hung Job or an interrupted launch unknown and never automatically launches again", async () => {
    const w = await world();
    const opts = { ...OPTIONS, timeoutMs: 80 };
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, opts)).rejects.not.toBeInstanceOf(StepFailedError);
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, opts)).rejects.not.toBeInstanceOf(StepFailedError);
    expect(w.fake.list("Job", NS)).toHaveLength(1);
  });

  it("claims concurrent retries atomically and launches at most one Job", async () => {
    const w = await world(); finishJobs(w);
    const results = await Promise.allSettled([w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS), w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(w.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/jobs"))).toHaveLength(1);
    expect(w.fake.list("Job", NS)).toHaveLength(1);
  });

  it("does not relaunch after an uncertain POST response and never echoes its body", async () => {
    const w = await world();
    w.fake.inject({ match: (r) => r.method === "POST" && r.path.endsWith("/jobs"), status: 500, message: "raw-sensitive-server-text" });
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.toThrow("Kubernetes release outcome is unknown (api_error).");
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.not.toBeInstanceOf(StepFailedError);
    expect(w.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/jobs"))).toHaveLength(1);
    expect(w.logs).toEqual([]);
  });

  it("refuses foreign workloads, Jobs and exhausted launch receipts without creating another Job", async () => {
    const w = await world(); finishJobs(w);
    await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS);
    const job = w.fake.list("Job", NS)[0];
    w.fake.foreignUpdate("Job", NS, job.metadata.name as string, "foreign", { metadata: { annotations: { "zenith.dev/workspace": "foreign-workspace" } } });
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.not.toBeInstanceOf(StepFailedError);
    const exhausted = await world();
    const annotations = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`zenith.dev/migration-${i}`, "receipt"]));
    exhausted.fake.foreignUpdate("Deployment", NS, "web", "zenith-release", { metadata: { annotations } });
    await expect(exhausted.ports.migrations.runOneOffTask(exhausted.ctx, exhausted.node, COMMAND, OPTIONS)).rejects.toThrow("receipt limit");
    expect(exhausted.fake.list("Job", NS)).toEqual([]);
    const foreign = await world();
    foreign.fake.foreignUpdate("Deployment", NS, "web", "other", { metadata: { annotations: { [ANNOTATION.environment]: OTHER_ENV } } });
    const count = foreign.fake.writes().length;
    await expect(foreign.ports.migrations.runOneOffTask(foreign.ctx, foreign.node, COMMAND, OPTIONS)).rejects.toThrow("outside");
    expect(foreign.fake.writes()).toHaveLength(count);
  });

  it("preserves custom pod settings as raw JSON and tolerates unavailable logs after a known exit", async () => {
    const w = await world(); finishJobs(w);
    w.fake.foreignUpdate("Deployment", NS, "web", "admission", { spec: { template: { spec: { serviceAccountName: "owned-identity", hostname: "migration-host", customPodExtension: { enabled: true } } } } });
    w.fake.inject({ match: (r) => r.path.endsWith("/log"), status: 403, message: "raw-log-secret" });
    expect(await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).toMatchObject({ exitCode: 0 });
    const posted = w.fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/jobs"))!;
    expect(posted.body.spec.template.spec).toMatchObject({ serviceAccountName: "owned-identity", hostname: "migration-host", customPodExtension: { enabled: true } });
    expect(w.logs).toEqual(["Kubernetes migration log tail unavailable."]);
  });

  it("scrubs very short known values and a secret cut by the API's log byte limit", async () => {
    const w = await world({ env: [{ key: "OPAQUE", value: "xy" }, { key: "VALUE", value: "sensitive-cutoff-value" }] });
    const log = `xy${"z".repeat(4088)}sensitive-cutoff-value`;
    finishJobs(w, { log });
    await w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS);
    expect(w.logs.join("")).not.toContain("sensit");
    expect(w.logs.join("")).not.toContain("xy");
  });

  it.each([[], [""], ["node", "bad\0arg"]].map((command) => ({ command })))("rejects invalid argv before reading the API (%j)", async ({ command }) => {
    const w = await world(); const count = w.fake.requests.length;
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, command, OPTIONS)).rejects.toThrow("argv");
    expect(w.fake.requests).toHaveLength(count);
  });

  it("refuses an unpinned migration image and caps timeouts before a launch", async () => {
    const w = await world({ artifact: { type: "image", ref: "ghcr.io/acme/web:mutable" } }); const count = w.fake.writes().length;
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, OPTIONS)).rejects.toThrow("pre-built");
    await expect(w.ports.migrations.runOneOffTask(w.ctx, w.node, COMMAND, { ...OPTIONS, timeoutMs: NaN })).rejects.toThrow("timeout");
    expect(w.fake.writes()).toHaveLength(count);
  });
});
