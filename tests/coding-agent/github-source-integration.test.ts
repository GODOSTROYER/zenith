/** Real SQL -> GitHub authority -> archive intake -> durable worker integration. No live providers. */
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createGithubSource } from "@/lib/coding-agent/github-source";
import { createRun, executeRunStep, type AgentWorkerDeps } from "@/lib/coding-agent/service";
import { platformRunStore } from "@/lib/coding-agent/store";
import type { AgentSourceRef, ModelProvider, ModelRequest, ModelResponse } from "@/lib/coding-agent/types";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { captureGithubWebhookFence } from "@/lib/sources/github/webhook-store";
import { api, binding, keys } from "../sources/fixtures";
import { writeTar } from "../_support/tar";

const SHA = "a".repeat(40);
let db: PlatformDbHandle, material: Awaited<ReturnType<typeof keys>>, sequence = 0;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite", migrate: true }); material = await keys(); }, 60_000);
afterAll(async () => { await db?.close(); await material?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

async function world(mode: "static" | "model" = "model") {
  const workspaceId = `source-integration-${++sequence}`;
  const grants = createGithubSourceStore(db), fence = await captureGithubWebhookFence(db, "42", 7);
  await grants.bind({ ...binding, workspaceId, actorId: "admin", expectedVersion: 0, installationGeneration: fence.generation });
  const grant = (await grants.getState(workspaceId, { repositoryId: 99 }))!;
  const archive = gzipSync(writeTar([
    { path: "repo/", type: "dir" },
    { path: "repo/package.json", bytes: Buffer.from('{"name":"app","scripts":{"start":"node server.js"},"dependencies":{"express":"4"}}') },
    { path: "repo/server.js", bytes: Buffer.from('const app = require("express")();\napp.listen(3000);\n') },
  ]));
  const fetchImpl = api(), delegate = fetchImpl.getMockImplementation()!;
  fetchImpl.mockImplementation(async (url, init) => {
    if (String(url) === `https://api.github.com/repos/acme/app/commits/${SHA}`) return new Response(SHA);
    if (String(url) === `https://codeload.github.com/acme/app/tar.gz/${SHA}`) return new Response(new Uint8Array(archive));
    return delegate(url, init);
  });
  const adapter = createGithubSource({ db: async () => db, fetchImpl, env: {
    ZENITH_GITHUB_APP_ID: "42", ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: material.config.privateKeyFile,
  } });
  const request = { workspaceId, repository: "acme/app", ref: SHA, repositoryId: 99, bindingId: grant.bindingId, bindingVersion: 1, accessKind: "installed" as const };
  const original = await adapter.resolve(request);
  const store = platformRunStore(db);
  const row = await createRun({ store, resolveSource: adapter.resolve, launcher: { start: async () => undefined, cancel: async () => undefined } },
    { workspaceId, userId: "admin" }, { task: "Analyze deployment requirements", source: request, mode });
  const worker = (provider: ModelProvider): AgentWorkerDeps => ({ store, readSource: adapter.read, authorizeSource: adapter.resolve,
    authorizeCaller: async () => undefined, provider: () => provider });
  return { workspaceId, grants, grant, adapter, request, original, store, row, worker, fetchImpl };
}

function deferredModel() {
  let entered!: (request: ModelRequest) => void, release!: (response: ModelResponse) => void;
  const started = new Promise<ModelRequest>(resolve => { entered = resolve; });
  const response = new Promise<ModelResponse>(resolve => { release = resolve; });
  const complete = vi.fn(async (request: ModelRequest) => { entered(request); return response; });
  const finish = () => release({ content: [{ type: "text", text: "Deployment review complete." }], stopReason: "end_turn", usage: { inputTokens: 23, outputTokens: 17 } });
  return { provider: { id: "controlled-model", complete }, started, finish };
}

describe("persisted GitHub authority and model lifetime", () => {
  it("accepts JSONB-reordered authority through static execution and saved-source authorization, while rejecting changed values", async () => {
    const w = await world("static");
    const persisted = w.row.source as AgentSourceRef;
    expect(persisted.sourceIdentity).toEqual(w.original.sourceIdentity);
    // This is the actual SQL serialization that exposed the regression.
    expect(JSON.stringify(persisted.sourceIdentity!.binding)).not.toBe(JSON.stringify(w.original.sourceIdentity!.binding));
    await expect(w.adapter.resolve({ ...w.request, expected: persisted.sourceIdentity })).resolves.toEqual(w.original);
    const provider = { id: "forbidden-static-model", complete: vi.fn(async () => { throw new Error("Static mode must not invoke a model."); }) };
    await expect(executeRunStep(w.worker(provider), { workspaceId: w.workspaceId, runId: w.row.id })).resolves.toEqual({ status: "completed" });
    expect(provider.complete).not.toHaveBeenCalled();
    const saved = (await w.store.get(w.workspaceId, w.row.id))!;
    expect(saved.result).toMatchObject({ finalText: expect.stringContaining("Static source analysis completed") });
    await expect(w.adapter.resolve({ ...w.request, expected: (saved.source as AgentSourceRef).sourceIdentity })).resolves.toEqual(w.original);
    const before = w.fetchImpl.mock.calls.length;
    for (const changed of [{ appId: "43" }, { installationId: 8 }, { repositoryId: 100 }, { version: 2 }]) {
      await expect(w.adapter.resolve({ ...w.request, expected: { ...persisted.sourceIdentity!, binding: { ...persisted.sourceIdentity!.binding!, ...changed } } }))
        .rejects.toMatchObject({ name: "GithubSourceError" });
    }
    expect(w.fetchImpl).toHaveBeenCalledTimes(before);
  });

  it("lets the model outlive the completed source deadline and persists its usage exactly once", async () => {
    const w = await world(), model = deferredModel();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal), sourceDeadlines: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      if (ms !== 60_000) return originalTimeout(ms);
      const controller = new AbortController(); sourceDeadlines.push(controller); return controller.signal;
    });
    const saved = vi.spyOn(w.store, "save");
    const options = { workspaceId: w.workspaceId, runId: w.row.id };
    const pending = executeRunStep(w.worker(model.provider), options);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      const modelRequest = await model.started;
      expect(sourceDeadlines.length).toBeGreaterThan(0);
      for (const deadline of sourceDeadlines) deadline.abort();
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(modelRequest.signal?.aborted).toBe(false);
      expect(saved).not.toHaveBeenCalled();
      model.finish();
      await expect(pending).resolves.toEqual({ status: "completed" });
      expect(saved).toHaveBeenCalledOnce();
      expect((await w.store.get(w.workspaceId, w.row.id))?.usage).toMatchObject({ inputTokens: 23, outputTokens: 17 });
      await expect(executeRunStep(w.worker(model.provider), options)).resolves.toEqual({ status: "completed" });
      expect(model.provider.complete).toHaveBeenCalledOnce();
    } finally { model.finish(); await pending.catch(() => undefined); }
  });

  it("blocks checkpoint publication when source access is revoked during a model call", async () => {
    const w = await world(), model = deferredModel(), saved = vi.spyOn(w.store, "save");
    const pending = executeRunStep(w.worker(model.provider), { workspaceId: w.workspaceId, runId: w.row.id });
    const rejected = expect(pending).rejects.toMatchObject({ name: "GithubSourceError" });
    try {
      await model.started;
      await w.grants.revoke({ workspaceId: w.workspaceId, actorId: "admin", bindingId: w.grant.bindingId, expectedVersion: 1 });
      model.finish(); await rejected;
      expect(saved).not.toHaveBeenCalled();
      expect((await w.store.get(w.workspaceId, w.row.id))?.result).toBeUndefined();
    } finally { model.finish(); await pending.catch(() => undefined); }
  });

  it("preserves the worker's cancellation/supersession result across the source callback boundary", async () => {
    const w = await world(), model = deferredModel(), saved = vi.spyOn(w.store, "save");
    const pending = executeRunStep(w.worker(model.provider), { workspaceId: w.workspaceId, runId: w.row.id });
    try {
      await model.started;
      await w.store.cancel({ workspaceId: w.workspaceId, id: w.row.id });
      model.finish();
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(saved).not.toHaveBeenCalled();
      expect(model.provider.complete).toHaveBeenCalledOnce();
    } finally { model.finish(); await pending.catch(() => undefined); }
  });

  it("local public-access rechecks detect a renamed repository's revoked stable ID without another provider request", async () => {
    const w = await world("static");
    await w.grants.revoke({ workspaceId: w.workspaceId, actorId: "admin", bindingId: w.grant.bindingId, expectedVersion: 1 });
    const before = w.fetchImpl.mock.calls.length;
    await expect(w.adapter.assertLocalAccess({ workspaceId: w.workspaceId, repository: "acme/renamed", ref: SHA, repositoryId: 99, accessKind: "public",
      expected: { ...w.original.sourceIdentity!, repo: "renamed", binding: null } })).rejects.toMatchObject({ code: "refused" });
    expect(w.fetchImpl).toHaveBeenCalledTimes(before);
  });
});
