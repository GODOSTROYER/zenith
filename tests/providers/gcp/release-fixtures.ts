/** Synthetic Google REST responses only. These fixtures never contact GCP. */
import { vi } from "vitest";
import type { DriverContext } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, gcpLabels, tagDescription } from "@/lib/providers/gcp/naming";
import { sha256Hex } from "@/lib/controlplane/digest";

export const PROJECT = "acme-prod-123456", REGION = "asia-south1", WS = "ws-1", ENV = "env-1";
export const DIGEST = `sha256:${"a".repeat(64)}`;
export const bundle = { s3Key: "sources/web.tar.gz", digest: sha256Hex("bundle") };
export const node = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown> = {}): ResourceNode => ({ address, kind, nativeType: `gcp:${kind}`, provider: "gcp", region: REGION, ownership: "managed", spec, labels: {}, origin: [], dependsOn: [], specDigest: "0".repeat(64) });
export const pipeline = node("build_pipeline/web", "build_pipeline", { location: "customer_account", source: { repo: "https://example.com/web", ref: "main", dockerfile: "docker/Dockerfile" }, output: { registry: "container_registry/web" } });
export const registry = node("container_registry/web", "container_registry");
export const service = node("container_service/web", "container_service", { artifact: { type: "built", pipeline: pipeline.address, registry: registry.address } });
export const tagged = (n: ResourceNode) => gcpLabels({ "zenith:workspace": WS, "zenith:environment": ENV, "zenith:managed": "true", "zenith:resource": n.address });
export const bucket = cloudName(`zenith-${ENV}`, pipeline.address, { max: 63, min: 3, suffix: "src", unique: ENV });
export const sa = `${cloudName(`zenith-${ENV}`, pipeline.address, { max: 30, min: 6, suffix: "bld" })}@${PROJECT}.iam.gserviceaccount.com`;
export const repoName = `projects/${PROJECT}/locations/${REGION}/repositories/zenith-env-1-web`;
export const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/zenith-env-1-web/web@${DIGEST}`;
export const serviceName = `projects/${PROJECT}/locations/${REGION}/services/zenith-env-1-web`;
export const revisionName = `${serviceName}/revisions/zenith-env-1-web-00002`;
export const BUILD_ID = "12345678-1234-1234-1234-123456789abc";

export function world() {
  const state = {
    repository: { name: repoName, format: "DOCKER", labels: tagged(registry) } as Record<string, unknown>,
    bucket: { name: bucket, labels: tagged(pipeline) } as Record<string, unknown>,
    account: { email: sa, description: tagDescription({ "zenith:environment": ENV, "zenith:resource": pipeline.address }, pipeline, "build identity", 256) } as Record<string, unknown>,
    metadata: { bucket, name: bundle.s3Key, generation: "7" } as Record<string, unknown>,
    build: undefined as Record<string, unknown> | undefined,
    buildStatus: "SUCCESS",
    buildOutputs: undefined as unknown[] | undefined,
    registryImage: undefined as Record<string, unknown> | undefined,
    service: { name: serviceName, labels: tagged(service), etag: "etag-1", generation: "2", observedGeneration: "2", reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" }, latestCreatedRevision: revisionName, latestReadyRevision: revisionName, template: { serviceAccount: `web@${PROJECT}.iam.gserviceaccount.com`, containers: [{ name: "web", image: IMAGE, env: [{ name: "DB", valueSource: { secretKeyRef: { secret: "db", version: "latest" } } }], resources: { limits: { cpu: "1", memory: "512Mi" } }, ports: [{ containerPort: 8080 }], livenessProbe: { httpGet: { path: "/health" } } }], vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ network: "private", subnetwork: "apps" }] } } } as Record<string, unknown>,
    revision: { name: revisionName, containers: [{ name: "web", image: IMAGE }] } as Record<string, unknown>,
    jobs: new Map<string, Record<string, unknown>>(),
    executions: new Map<string, Record<string, unknown>>(),
    tasks: new Map<string, Record<string, unknown>>(),
    starts: 0,
    patchStatus: 200,
    launchStatus: 200,
    taskExit: 0 as number | undefined,
    before: undefined as ((url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) | undefined,
  };
  state.service.traffic = [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }];
  state.service.trafficStatuses = [{ revision: revisionName, percent: 100 }];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const u = new URL(raw); const override = await state.before?.(u, init); if (override) return override;
    const path = decodeURIComponent(u.pathname); const method = init?.method ?? "GET";
    if (u.hostname === "storage.googleapis.com") return json(path.includes("/o/") ? state.metadata : state.bucket);
    if (u.hostname === "iam.googleapis.com") return json(state.account);
    if (u.hostname === "artifactregistry.googleapis.com") {
      if (path.includes("/dockerImages/")) {
        const image = state.build?.images as string[];
        const imageUri = `${image[0].replace(/:[^:/]+$/, "")}@${DIGEST}`;
        return json(state.registryImage ?? { name: path.slice(4), uri: imageUri });
      }
      return json(state.repository);
    }
    if (u.hostname === "cloudbuild.googleapis.com") {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        state.build = { ...body, id: BUILD_ID, status: state.buildStatus, results: { images: state.buildOutputs ?? [{ name: (body.images as string[])[0], digest: DIGEST }] } };
        return json({ name: "projects/p/locations/r/operations/b", metadata: { build: { id: BUILD_ID } } });
      }
      if (path.endsWith("/builds")) {
        const tag = /tags="([^"]+)"/.exec(u.searchParams.get("filter") ?? "")?.[1];
        return json({ builds: state.build && (state.build.tags as string[]).includes(tag ?? "") ? [state.build] : [] });
      }
      return json(state.build ?? {}, state.build ? 200 : 404);
    }
    if (u.hostname === "run.googleapis.com") {
      const name = path.slice(4);
      if (path.endsWith("/services")) return json({ services: [state.service] });
      if (name === serviceName && method === "PATCH") {
        if (state.patchStatus !== 200) return json({ error: { message: "opaque-secret-sentinel" } }, state.patchStatus);
        const body = JSON.parse(String(init?.body)); state.service.template = body.template; state.service.traffic = body.traffic;
        return json({ done: true, name: "projects/p/locations/r/operations/update" });
      }
      if (name === serviceName) return json(state.service);
      if (name === revisionName) return json(state.revision);
      if (method === "PATCH" && state.jobs.has(name)) {
        const body = JSON.parse(String(init?.body)); state.jobs.get(name)!.template = body.template;
        return json({ done: true });
      }
      if (method === "POST" && path.endsWith("/jobs")) {
        const body = JSON.parse(String(init?.body));
        if (state.jobs.has(body.name)) return json({}, 409);
        state.jobs.set(body.name, { ...body, reconciling: false, terminalCondition: { state: "CONDITION_SUCCEEDED" } });
        return json({ done: true });
      }
      if (method === "POST" && name.endsWith(":run")) {
        state.starts++;
        if (state.launchStatus !== 200) return json({ error: { message: "opaque-secret-sentinel" } }, state.launchStatus);
        const job = name.slice(0, -4); const execution = `${job}/executions/zn-exec-1`; const template = state.jobs.get(job)?.template;
        state.executions.set(execution, { name: execution, job, taskCount: 1, succeededCount: state.taskExit === 0 ? 1 : 0, failedCount: state.taskExit === 0 ? 0 : 1, completionTime: "2026-10-01T00:00:00Z", template });
        state.tasks.set(execution, { name: `${execution}/tasks/task-0`, job, execution, completionTime: "2026-10-01T00:00:00Z", lastAttemptResult: state.taskExit === undefined ? {} : { exitCode: state.taskExit } });
        return json({ done: true });
      }
      if (name.endsWith("/tasks")) return json({ tasks: state.tasks.has(name.slice(0, -6)) ? [state.tasks.get(name.slice(0, -6))] : [] });
      if (name.endsWith("/executions")) return json({ executions: [...state.executions.values()].filter((e) => e.job === name.slice(0, -11)) });
      if (state.executions.has(name)) return json(state.executions.get(name));
      if (state.jobs.has(name)) return json(state.jobs.get(name));
      return json({}, 404);
    }
    throw new Error("Unexpected fake Google request.");
  });
  const ctx: DriverContext<GcpSession> = { provider: "gcp", workspaceId: WS, environmentId: ENV, region: REGION, operationId: "op-1", session: { provider: "gcp", projectId: PROJECT, region: REGION, expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: fetcher, childProcessEnv: () => { throw new Error("No child processes in this fixture."); } }, signal: new AbortController().signal, tags: { "zenith:workspace": WS, "zenith:environment": ENV, "zenith:resource": service.address, "zenith:managed": "true" }, now: () => new Date("2026-10-01T00:00:00Z"), log: vi.fn() };
  return { state, ctx, fetcher, json };
}
