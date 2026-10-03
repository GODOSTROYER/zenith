/** C3 + real binding SQL + mocked GitHub HTTP. No cloud upload or live build. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { BatchGetProjectsCommand, CodeBuildClient } from "@aws-sdk/client-codebuild";
import { GetBucketTaggingCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { StoredResource } from "@/lib/execution/ports";
import { sha256Hex } from "@/lib/controlplane/digest";
import type { PlatformDb } from "@/lib/controlplane/types";
import { openPlatformDb } from "@/lib/controlplane/db";
import { installGithubSourceSchema } from "@/lib/sources/github/schema";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { api, binding, INSTALL_TOKEN, keys } from "../sources/fixtures";
import { writeTar } from "../_support/tar";

const capture = vi.hoisted(() => ({ db: undefined as PlatformDb | undefined }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => capture.db! }));
let material: Awaited<ReturnType<typeof keys>>;
beforeAll(async () => {
  material = await keys(); capture.db = await openPlatformDb({ kind: "pglite" }); await installGithubSourceSchema(capture.db);
  const fence = await captureGithubWebhookFence(capture.db, binding.appId, binding.installationId);
  await createGithubSourceStore(capture.db).bind({ ...binding, actorId: "human", expectedVersion: 0, installationGeneration: fence.generation });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await capture.db?.close(); await material.close(); });

describe("C3 default GitHub App acquisition", () => {
  const source = { repo: "acme/app", ref: "a".repeat(40) };
  function configured() {
    vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
  }
  function download() {
    return vi.fn<typeof fetch>(async (_url, options) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization === `Bearer ${INSTALL_TOKEN}`).toBe(true);
      return new Response(new Uint8Array(gzipSync(writeTar([{ path: "app-ref/Dockerfile", bytes: Buffer.from("FROM scratch\n") }]))));
    });
  }
  it("uses the default connector in the existing composition hook and returns archive identifiers only", async () => {
    configured(); const fetchImpl = download(); const githubApi = api(); vi.stubGlobal("fetch", githubApi);
    const s3 = mockClient(S3Client); const cb = mockClient(CodeBuildClient);
    try {
      const region = "us-east-1"; const accountId = "123456789012"; const bucket = "zenith-env-a-web-src";
      const node = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown>): ResourceNode => ({ address, kind, provider: "aws", region, spec, specDigest: sha256Hex(JSON.stringify(spec)), ownership: "managed", nativeType: "aws:fixture", origin: [], dependsOn: [], labels: {} });
      const service = node("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web" } });
      const pipeline = { ...node("build_pipeline/web", "build_pipeline", { source, location: "customer_account" }), externalRef: `arn:aws:codebuild:${region}:${accountId}:project/zenith-env-a-web` };
      const rows: StoredResource[] = [service, pipeline].map((item) => ({ ...item, id: item.address, workspaceId: "ws-a", environmentId: "env-a", status: "active", externalId: item.externalRef }));
      const session: AwsSession = { provider: "aws", accountId, region, transport: "direct", expiresAt: "2099-01-01T00:00:00Z", client: (ctor) => new ctor({ region }), childProcessEnv: () => { throw new Error("Unused accessor."); } };
      const ctx: DriverContext = { provider: "aws", region, workspaceId: "ws-a", environmentId: "env-a", session, signal: new AbortController().signal, log: vi.fn(), tags: {}, now: () => new Date() };
      const tags = { "zenith:workspace": "ws-a", "zenith:environment": "env-a", "zenith:managed": "true", "zenith:resource": pipeline.address };
      cb.on(BatchGetProjectsCommand).resolves({ projects: [{ name: "zenith-env-a-web", arn: pipeline.externalRef, source: { type: "S3", location: `${bucket}/bootstrap.zip` }, tags: Object.entries(tags).map(([key, value]) => ({ key, value })) }] });
      s3.on(GetBucketTaggingCommand).resolves({ TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }); s3.on(PutObjectCommand).resolves({});
      const result = await createSourceBundles({ fetchImpl, resources: { list: async () => rows } }).port.prepare(ctx, { service, source });
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(result).includes(INSTALL_TOKEN)).toBe(false);
      expect(githubApi).toHaveBeenCalledTimes(2); expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes(INSTALL_TOKEN))).toBe(true);
    } finally { s3.restore(); cb.restore(); }
  });
  it("refuses a different repository before downloading any bytes", async () => {
    configured(); const githubApi = api(); vi.stubGlobal("fetch", githubApi); const fetchImpl = download();
    const { defaultGithubAccess } = await import("@/lib/sources/github/runtime");
    const bundler = createSourceBundles({ fetchImpl, withGithubAccess: (input, fn) => defaultGithubAccess({ ...input, workspaceId: "ws-a" }, fn) });
    await expect(bundler.read({ ...source, repo: "foreign/private" })).rejects.toThrow("acquisition failed");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(githubApi).not.toHaveBeenCalled();
  });
  it("keeps standalone public archive reads anonymous when the App is configured", async () => {
    configured(); const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      expect((options?.headers as Record<string, string>).Authorization === undefined).toBe(true);
      return new Response(new Uint8Array(gzipSync(writeTar([{ path: "app-ref/a", bytes: Buffer.from("public") }]))));
    });
    const githubApi = api(); vi.stubGlobal("fetch", githubApi);
    expect((await createSourceBundles({ fetchImpl }).read(source)).bytes).toBeGreaterThan(0); expect(githubApi).not.toHaveBeenCalled();
  });
  it("does not leak an authenticated download failure or retry anonymously", async () => {
    configured(); vi.stubGlobal("fetch", api()); const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(INSTALL_TOKEN); });
    const { defaultGithubAccess } = await import("@/lib/sources/github/runtime");
    const error = await createSourceBundles({ fetchImpl, withGithubAccess: (input, fn) => defaultGithubAccess({ ...input, workspaceId: "ws-a" }, fn) }).read(source).catch((error: unknown) => error);
    expect(String(error).includes(INSTALL_TOKEN)).toBe(false); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
