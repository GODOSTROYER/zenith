/**
 * Source builds in the customer's Azure Container Registry (ADR-0016, Azure
 * equivalent of the CodeBuild path).
 *
 *   1. POST  <registry>/listBuildSourceUploadUrl      → a one-time blob SAS URL
 *      in the REGISTRY's own storage, plus a `relativePath` naming the upload;
 *   2. PUT   <uploadUrl>                              → the source archive
 *      (.tar.gz). This request goes to `*.blob.core.windows.net` with the SAS
 *      signature in the URL and NO bearer token: it is sent with the plain
 *      `uploadFetch`, never through `authorizedFetch`, and only to a host that
 *      matches the expected blob endpoint shape over https;
 *   3. POST  <registry>/scheduleRun                   → a DockerBuildRequest
 *      (push enabled, Linux/amd64) sourced from that upload; the run executes
 *      inside ACR (ephemeral, isolated from Zenith, with the registry's own
 *      rights) — Zenith's control plane never runs customer code;
 *   4. GET   <registry>/runs/<runId>                  → poll (bounded) until
 *      Succeeded/Failed/…; the pushed image's DIGEST is returned so deploy can
 *      record and verify it.
 *
 * The image is pushed as `<login server>/<repository>:latest` by default so the
 * workload compile's `built` artifact rule finds it; pass explicit tags to add
 * more. The repository and tag are validated (no `..`, no uppercase in the
 * repository, bounded length), as is the Dockerfile path.
 *
 * Honest limits: contract-tested against a fake ARM and a fake blob endpoint;
 * the preview-surface REST shapes (api-version 2019-06-01-preview) are from
 * Microsoft's published references and were not run against a live registry.
 * Build logs are not fetched here (they can contain anything the build prints).
 */
import type { AzureSession } from "@/lib/credentials/types";
import { armClient, armTypeOf, inSubscription, safeText, sameArmType, type Json } from "@/lib/providers/azure/arm";
import { pick } from "@/lib/providers/azure/kit";
import { API } from "@/lib/providers/azure/platform";

export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;

const BLOB_HOST = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DOCKERFILE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

export type BuildFailure = "invalid_input" | "upload_url_rejected" | "upload_failed" | "schedule_failed" | "build_failed" | "timeout";

export class AcrBuildError extends Error {
  readonly code = "acr_build_failed";
  constructor(
    readonly reason: BuildFailure,
    message: string,
    readonly requestIds: string[] = []
  ) {
    super(message);
    this.name = "AcrBuildError";
  }
}

export interface AcrBuildInput {
  /** ARM id of the registry (from the registry node's observation) */
  registryId: string;
  /** the registry's login server, e.g. `acme.azurecr.io` (from the observation) */
  loginServer: string;
  /** repository within the registry, e.g. `web` */
  repository: string;
  /** extra tags besides `latest` */
  tags?: string[];
  dockerfilePath?: string;
  /** .tar.gz source archive */
  source: Uint8Array;
  /** plain fetch for the SAS upload; defaults to global fetch */
  uploadFetch?: typeof fetch;
  /** max wait for the run, ms (default 30 minutes) */
  timeoutMs?: number;
  pollIntervalMs?: number;
  clientRequestId?: string;
}

export interface AcrBuildResult {
  runId: string;
  status: "Succeeded";
  images: { image: string; digest?: string }[];
  requestIds: string[];
}

export function validateBuildInput(i: AcrBuildInput, subscriptionId: string): void {
  const t = armTypeOf(i.registryId);
  if (!t || !sameArmType(t, "Microsoft.ContainerRegistry/registries") || !inSubscription(i.registryId, subscriptionId)) throw new AcrBuildError("invalid_input", "registryId is not a container registry of this subscription.");
  if (!/^[a-z0-9]{5,50}\.azurecr\.io$/.test(i.loginServer)) throw new AcrBuildError("invalid_input", "loginServer is not an ACR login server.");
  if (i.repository.length > 200 || !REPOSITORY.test(i.repository)) throw new AcrBuildError("invalid_input", "repository is not a valid image repository name.");
  for (const tag of i.tags ?? []) if (!TAG.test(tag)) throw new AcrBuildError("invalid_input", "an image tag is not valid.");
  if (i.dockerfilePath !== undefined && !DOCKERFILE.test(i.dockerfilePath)) throw new AcrBuildError("invalid_input", "dockerfilePath must be a relative path without '..'.");
  if (!(i.source instanceof Uint8Array) || i.source.byteLength === 0) throw new AcrBuildError("invalid_input", "the source archive is empty.");
  if (i.source.byteLength > MAX_SOURCE_BYTES) throw new AcrBuildError("invalid_input", `the source archive exceeds ${MAX_SOURCE_BYTES / 1024 / 1024} MiB.`);
}

/** The SAS upload URL is network data: accept only a blob endpoint over https carrying a signature. */
export function assertUploadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AcrBuildError("upload_url_rejected", "The registry returned an upload URL that is not a URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !BLOB_HOST.test(url.hostname) || !url.searchParams.has("sig")) {
    throw new AcrBuildError("upload_url_rejected", "The registry returned an upload URL that is not a signed Azure blob URL.");
  }
  return url;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => (signal?.aborted ? r() : (setTimeout(r, ms), signal?.addEventListener("abort", () => r(), { once: true }))));

export async function runAcrBuild(session: AzureSession, input: AcrBuildInput, signal?: AbortSignal): Promise<AcrBuildResult> {
  validateBuildInput(input, session.subscriptionId);
  const arm = armClient(session, signal);
  const requestIds: string[] = [];
  const headers = input.clientRequestId ? { "x-ms-client-request-id": input.clientRequestId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) } : undefined;
  const api = API.containerRegistryRuns;

  const up = await arm.post<{ uploadUrl?: string; relativePath?: string }>(`${input.registryId}/listBuildSourceUploadUrl`, { apiVersion: api, headers });
  if (up.requestId) requestIds.push(up.requestId);
  const uploadUrl = assertUploadUrl(String(up.body.uploadUrl ?? ""));
  const relativePath = String(up.body.relativePath ?? "");
  if (!/^[A-Za-z0-9._\-/]{1,300}$/.test(relativePath) || relativePath.includes("..")) throw new AcrBuildError("upload_url_rejected", "The registry returned an unusable source path.", requestIds);

  const put = await (input.uploadFetch ?? fetch)(uploadUrl.toString(), {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" },
    body: input.source as unknown as BodyInit,
    signal,
    redirect: "error",
  }).catch(() => undefined);
  if (!put || !put.ok) throw new AcrBuildError("upload_failed", `Uploading the source archive failed${put ? ` (HTTP ${put.status})` : ""}.`, requestIds);

  const images = [`${input.repository}:latest`, ...(input.tags ?? []).map((t) => `${input.repository}:${t}`)];
  let scheduled;
  try {
    scheduled = await arm.post<Json>(`${input.registryId}/scheduleRun`, {
      apiVersion: api,
      headers,
      body: {
        type: "DockerBuildRequest",
        imageNames: images,
        isPushEnabled: true,
        noCache: false,
        dockerFilePath: input.dockerfilePath ?? "Dockerfile",
        platform: { os: "Linux", architecture: "amd64" },
        sourceLocation: relativePath,
        isArchiveEnabled: false,
        timeout: 3600,
      },
    });
  } catch (e) {
    throw new AcrBuildError("schedule_failed", e instanceof Error ? safeText(e.message) : "scheduling the build failed", requestIds);
  }
  if (scheduled.requestId) requestIds.push(scheduled.requestId);
  const runId = String(pick<string>(scheduled.body, "properties", "runId") ?? "");
  if (!/^[A-Za-z0-9]{1,32}$/.test(runId)) throw new AcrBuildError("schedule_failed", "The registry did not return a run id.", requestIds);

  const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const run = await arm.get<Json>(`${input.registryId}/runs/${runId}`, { apiVersion: api });
    if (run.requestId) requestIds.push(run.requestId);
    const status = String(pick<string>(run.body, "properties", "status") ?? "");
    if (status === "Succeeded") {
      const out = (pick<Json[]>(run.body, "properties", "outputImages") ?? []).slice(0, 10);
      return {
        runId,
        status: "Succeeded",
        images: out.map((o) => ({ image: `${String(o.registry ?? input.loginServer)}/${String(o.repository ?? input.repository)}:${String(o.tag ?? "latest")}`, digest: typeof o.digest === "string" ? o.digest : undefined })),
        requestIds,
      };
    }
    if (["Failed", "Canceled", "Error", "Timeout"].includes(status)) throw new AcrBuildError("build_failed", `The ACR build ${runId} ended as ${status}.`, requestIds);
    if (Date.now() >= deadline || signal?.aborted) throw new AcrBuildError("timeout", `The ACR build ${runId} did not finish in time (last status ${status || "unknown"}).`, requestIds);
    await sleep(input.pollIntervalMs ?? 5000, signal);
  }
}
