/**
 * Launch an ACR DockerBuildRequest with only the operation tag; never :latest.
 * Upload SAS remains local and goes only to the plain blob transport. Customer
 * source runs inside ACR, never on the worker. Returns identifiers immediately
 * so a durable receipt can precede polling. No live Azure evidence.
 * https://learn.microsoft.com/en-us/rest/api/container-registry-tasks/registries/schedule-run?view=rest-container-registry-tasks-2019-04-01
 */
import { armClient } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import { assertUploadUrl, validateBuildInput, type AcrBuildInput } from "@/lib/providers/azure/acr-build";
import { rec, type Ctx } from "./support";

export const ACR_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export async function scheduleBuild(ctx: Ctx, input: AcrBuildInput & { tag: string }): Promise<string> {
  validateBuildInput(input, ctx.session.subscriptionId);
  if (!/^zn-[a-f0-9]{64}$/.test(input.tag)) throw new Error("Invalid Azure build operation tag.");
  const arm = armClient(ctx.session, ctx.signal);
  const headers = { "x-ms-client-request-id": input.tag.slice(3) };
  const apiVersion = API.containerRegistryRuns;
  const up = await arm.post(`${input.registryId}/listBuildSourceUploadUrl`, { apiVersion, headers });
  if (typeof up.body.uploadUrl !== "string" || typeof up.body.relativePath !== "string") throw new Error("Azure build source upload location is unknown.");
  const url = assertUploadUrl(up.body.uploadUrl);
  const relativePath = up.body.relativePath;
  if (url.hash || !url.searchParams.get("sig") || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,299}$/.test(relativePath) || relativePath.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("Azure build source upload location is invalid.");
  ctx.signal.throwIfAborted();
  const uploaded = await (input.uploadFetch ?? fetch)(url.toString(), {
    method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" },
    body: input.source as unknown as BodyInit, signal: ctx.signal, redirect: "error",
  });
  if (!uploaded.ok) throw new Error("Azure build source upload failed.");
  ctx.signal.throwIfAborted();
  const run = await arm.post(`${input.registryId}/scheduleRun`, {
    apiVersion, headers,
    body: { type: "DockerBuildRequest", imageNames: [`${input.repository}:${input.tag}`], isPushEnabled: true, noCache: false,
      dockerFilePath: input.dockerfilePath ?? "Dockerfile", platform: { os: "Linux", architecture: "amd64" },
      sourceLocation: relativePath, isArchiveEnabled: false, timeout: 3600 },
  });
  const runId = rec(run.body.properties).runId;
  if (typeof runId !== "string" || !ACR_RUN_ID.test(runId) || (run.body.name !== undefined && run.body.name !== runId) || (run.body.id !== undefined && run.body.id !== `${input.registryId}/runs/${runId}`)) throw new Error("Azure build run identity is unknown.");
  return runId;
}
