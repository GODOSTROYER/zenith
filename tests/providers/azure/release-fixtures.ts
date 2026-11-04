/** Synthetic ARM/blob transports and an IN-MEMORY test journal; no live Azure evidence. */
import { vi } from "vitest";
import type { DriverContext } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { LaunchJournal, LaunchScope } from "@/lib/providers/azure/release/support";
import { sha256Hex } from "@/lib/controlplane/digest";

export const SUB = "11111111-2222-3333-4444-555555555555", REGION = "westeurope", WS = "ws-1", ENV = "env-1";
export const ROOT = `/subscriptions/${SUB}/resourceGroups/zenith-env-1/providers`;
export const registryId = `${ROOT}/Microsoft.ContainerRegistry/registries/zenithregistry`;
export const appId = `${ROOT}/Microsoft.App/containerApps/web`;
export const environmentId = `${ROOT}/Microsoft.App/managedEnvironments/zenith-env-1`;
export const DIGEST = `sha256:${"a".repeat(64)}`, IMAGE = `zenithregistry.azurecr.io/web@${DIGEST}`;
export const source = new Uint8Array([1, 2, 3, 4]);
export const bundle = { s3Key: "bundles/web.tar.gz", bucket: "source-account/source-container", digest: sha256Hex(source) };
export const node = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown> = {}): ResourceNode => ({ address, kind, nativeType: `azure:${kind}`, provider: "azure", region: REGION, ownership: "managed", spec, labels: {}, origin: [], dependsOn: [], specDigest: "0".repeat(64) });
export const pipeline = node("build_pipeline/web", "build_pipeline", { location: "customer_account", source: { repo: "https://example.com/web", ref: "main", dockerfile: "docker/Dockerfile" }, output: { registry: "container_registry/web" } });
export const registry = { ...node("container_registry/web", "container_registry"), externalRef: registryId };
export const service = { ...node("container_service/web", "container_service", { artifact: { type: "built", pipeline: pipeline.address, registry: registry.address } }), externalRef: appId };
export const tagged = (n: ResourceNode) => ({ "zenith:workspace": WS, "zenith:environment": ENV, "zenith:managed": "true", "zenith:resource": n.address });

export function journal() {
  const claims = new Set<string>(); const references = new Map<string, string>();
  const key = (s: LaunchScope) => JSON.stringify([s.workspaceId, s.environmentId, s.key]);
  const port: LaunchJournal = {
    claim: vi.fn(async (s) => { const k = key(s); if (claims.has(k)) return false; claims.add(k); return true; }),
    record: vi.fn(async (s, reference) => { references.set(key(s), reference); }),
    read: vi.fn(async (s) => references.get(key(s))),
  };
  return { port, claims, references };
}
export function world() {
  const receipts = journal();
  const state = {
    registry: { id: registryId, name: "zenithregistry", type: "Microsoft.ContainerRegistry/registries", location: REGION, tags: tagged(registry), properties: { loginServer: "zenithregistry.azurecr.io", provisioningState: "Succeeded" } } as Record<string, unknown>,
    app: { id: appId, name: "web", type: "Microsoft.App/containerApps", location: REGION, tags: tagged(service), etag: "etag-1", identity: { type: "UserAssigned", userAssignedIdentities: { [`${ROOT}/Microsoft.ManagedIdentity/userAssignedIdentities/web`]: {} } }, properties: { environmentId, workloadProfileName: "Consumption", provisioningState: "Succeeded", latestRevisionName: "web--zn-ready", latestReadyRevisionName: "web--zn-ready", template: { revisionSuffix: "zn-ready", scale: { minReplicas: 1, maxReplicas: 1 }, containers: [{ name: "web", image: IMAGE, resources: { cpu: 0.5, memory: "1Gi" }, env: [{ name: "DB", secretRef: "database" }], probes: [{ type: "Readiness", httpGet: { path: "/health", port: 8080 } }] }] }, configuration: { activeRevisionsMode: "Single", ingress: { external: false, traffic: [{ latestRevision: true, weight: 100 }] }, registries: [{ server: "zenithregistry.azurecr.io", identity: `${ROOT}/Microsoft.ManagedIdentity/userAssignedIdentities/web` }], secrets: [{ name: "database", keyVaultUrl: "https://zenithvault.vault.azure.net/secrets/database", identity: `${ROOT}/Microsoft.ManagedIdentity/userAssignedIdentities/web` }] } } } as Record<string, unknown>,
    revision: { id: `${appId}/revisions/web--zn-ready`, name: "web--zn-ready", properties: { provisioningState: "Provisioned", healthState: "Healthy", runningState: "Running", active: true, template: { containers: [{ name: "web", image: IMAGE }] } } } as Record<string, unknown>,
    run: undefined as Record<string, unknown> | undefined,
    runStatus: "Succeeded",
    runDigest: DIGEST as string | undefined,
    jobs: new Map<string, Record<string, unknown>>(),
    executions: new Map<string, Record<string, unknown>[]>(),
    schedules: 0,
    starts: 0,
    executionStatus: "Succeeded",
    launchStatus: 200,
    patchStatus: 200,
    before: undefined as ((url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) | undefined,
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const u = new URL(raw); const override = await state.before?.(u, init); if (override) return override;
    const path = decodeURIComponent(u.pathname); const method = init?.method ?? "GET";
    if (path === registryId) return json(state.registry);
    if (path.endsWith("/resources")) return json({ value: [state.registry, state.app] });
    if (path === `${registryId}/listBuildSourceUploadUrl`) return json({ uploadUrl: "https://acrsource.blob.core.windows.net/source/upload?sig=secret-sas-sentinel", relativePath: "source/upload.tar.gz" });
    if (path === `${registryId}/scheduleRun`) {
      state.schedules++; const body = JSON.parse(String(init?.body));
      state.run = { id: `${registryId}/runs/run1`, name: "run1", properties: { runId: "run1", status: state.runStatus, outputImages: body.imageNames.map((name: string) => ({ registry: "zenithregistry.azurecr.io", repository: name.split(":")[0], tag: name.split(":")[1], digest: state.runDigest })) } };
      return json(state.run);
    }
    if (path === `${registryId}/runs/run1`) return json(state.run ?? {}, state.run ? 200 : 404);
    if (path === appId && method === "PATCH") {
      if (state.patchStatus !== 200) return json({ error: { message: "opaque-secret-sentinel" } }, state.patchStatus);
      const body = JSON.parse(String(init?.body)); (state.app.properties as Record<string, unknown>).template = body.properties.template;
      return json(state.app);
    }
    if (path === appId) return json(state.app);
    if (path.startsWith(`${appId}/revisions/`)) return json(state.revision);
    if (method === "PUT" && path.includes("/Microsoft.App/jobs/")) {
      const body = JSON.parse(String(init?.body)); const job = { ...body, id: path, name: path.split("/").pop(), type: "Microsoft.App/jobs", properties: { ...body.properties, provisioningState: "Succeeded" } };
      state.jobs.set(path, job); return json(job);
    }
    if (method === "POST" && path.endsWith("/start")) {
      state.starts++;
      if (state.launchStatus !== 200) return json({ error: { message: "opaque-secret-sentinel" } }, state.launchStatus);
      const jobId = path.slice(0, -6); const job = state.jobs.get(jobId)!; const name = "zn-execution-1";
      state.executions.set(jobId, [{ id: `${jobId}/executions/${name}`, name, properties: { status: state.executionStatus, endTime: state.executionStatus === "Running" ? undefined : "2026-10-01T00:00:00Z", template: (job.properties as Record<string, unknown>).template } }]);
      return json({ id: `${jobId}/executions/${name}`, name });
    }
    if (path.endsWith("/executions")) return json({ value: state.executions.get(path.slice(0, -11)) ?? [] });
    if (method === "PATCH" && state.jobs.has(path)) {
      const body = JSON.parse(String(init?.body)); (state.jobs.get(path)!.properties as Record<string, unknown>).template = body.properties.template;
      return json(state.jobs.get(path));
    }
    if (state.jobs.has(path)) return json(state.jobs.get(path));
    return json({}, 404);
  });
  const uploadFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("", { status: 201 })) as unknown as typeof fetch;
  const ctx: DriverContext<AzureSession> = { provider: "azure", region: REGION, workspaceId: WS, environmentId: ENV, operationId: "op-1", session: { provider: "azure", subscriptionId: SUB, region: REGION, expiresAt: "2099-01-01T00:00:00Z", authorizedFetch: fetcher, childProcessEnv: () => { throw new Error("No child process in fixture."); } }, signal: new AbortController().signal, tags: tagged(service), now: () => new Date("2026-10-01T00:00:00Z"), log: vi.fn() };
  const readSource = vi.fn(async () => source);
  return { ctx, fetcher, state, json, receipts, uploadFetch, readSource, options: { readSource, launches: receipts.port, uploadFetch } };
}
