/** Adapter races and cancellation. GitHub HTTP and SQL authority have independent suites. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import type { GithubBindingState } from "@/lib/sources/github/store";
import { GithubSourceError, type GithubImmutableSource, type GithubImmutableSourceRequest } from "@/lib/sources/github/types";
import type { ContextVerification } from "@/lib/sources/github/inspect";
import type { GithubSnapshotRequest } from "@/lib/analysis/github";
import type { RepoSnapshot } from "@/lib/analysis/types";
import { createGithubSource } from "@/lib/coding-agent/github-source";

const hooks = vi.hoisted(() => ({
  state: vi.fn<() => Promise<GithubBindingState | undefined>>(),
  access: vi.fn<(input: GithubImmutableSourceRequest, read: (identity: GithubImmutableSource, token?: string) => Promise<unknown>) => Promise<unknown>>(),
  context: vi.fn<(input: ContextVerification) => Promise<boolean>>(),
  snapshot: vi.fn<(input: GithubSnapshotRequest) => Promise<RepoSnapshot>>(),
}));
vi.mock("@/lib/sources/github/store", () => ({ createGithubSourceStore: () => ({ getState: hooks.state }) }));
vi.mock("@/lib/sources/github/runtime", () => ({ createGithubImmutableSourceAccess: () => hooks.access }));
vi.mock("@/lib/sources/github/inspect", async original => ({
  ...await original<typeof import("@/lib/sources/github/inspect")>(), createGithubContextVerifier: () => hooks.context,
}));
vi.mock("@/lib/analysis", async original => ({
  ...await original<typeof import("@/lib/analysis")>(), snapshotFromGithub: hooks.snapshot,
}));

const SHA = "a".repeat(40), TOKEN = "synthetic-installation-credential";
const identity: GithubImmutableSource = { owner: "acme", repo: "school", repositoryId: 99, commitSha: SHA,
  binding: { appId: "42", installationId: 7, repositoryId: 99, version: 1 } };
const state: GithubBindingState = { bindingId: "grant-school", revoked: false,
  binding: { workspaceId: "workspace", owner: "acme", repo: "school", appId: "42", installationId: 7, repositoryId: 99, version: 1 } };
const request = { workspaceId: "workspace", repository: "acme/school", ref: SHA, bindingId: "grant-school", bindingVersion: 1, repositoryId: 99, accessKind: "installed" as const };
const db: Sql = { query: vi.fn() as Sql["query"], tx: async work => work(db) };
const source = () => createGithubSource({ db: async () => db, env: {} });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.state.mockResolvedValue(structuredClone(state));
  hooks.access.mockImplementation(async (_input, read) => read(structuredClone(identity), TOKEN));
  hooks.context.mockResolvedValue(true);
  hooks.snapshot.mockResolvedValue({ files: [{ path: "server.ts", content: 'const API_TOKEN="private-source-canary";\n' }], truncated: false, source: { kind: "fixture" } });
});

describe("Gimbal immutable source adapter", () => {
  it.each(["resolve", "read"] as const)("refuses %s when the grant changes between selection and immutable resolution", async method => {
    hooks.access.mockImplementation(async (_input, read) => read({ ...identity, binding: { ...identity.binding!, version: 2 } }, TOKEN));
    const adapter = source(), use = vi.fn(async () => "never");
    const pending = method === "resolve" ? adapter.resolve(request) : adapter.read({ ...request, expected: identity }, use);
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(hooks.snapshot).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });

  it("refuses an anonymous-to-installed race before returning source identity", async () => {
    hooks.state.mockResolvedValue(undefined);
    await expect(source().resolve({ workspaceId: "workspace", repository: "acme/school", ref: SHA, accessKind: "public" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(hooks.snapshot).not.toHaveBeenCalled();
  });

  it("propagates cancellation and access mode into immutable resolution and context verification", async () => {
    const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    hooks.context.mockImplementation(input => new Promise((_resolve, reject) => {
      const abort = () => reject(new GithubSourceError("unavailable"));
      input.signal?.addEventListener("abort", abort, { once: true });
      started();
      if (input.signal?.aborted) abort();
    }));
    const pending = source().resolve({ ...request, root: "apps/web", contextDir: "", dockerfile: "apps/web/Dockerfile", contextDigest: "b".repeat(64), signal: controller.signal });
    await ready; controller.abort(TOKEN);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(hooks.access.mock.calls[0][0]).toMatchObject({ signal: controller.signal, accessKind: "installed" });
    expect(hooks.context.mock.calls[0][0]).toMatchObject({ signal: controller.signal, commitSha: SHA, contextDir: "", dockerfile: "apps/web/Dockerfile" });
  });

  it("passes the worker signal to source download and reauthorizes every redacted cache hit", async () => {
    const adapter = source(), controller = new AbortController();
    const input = { ...request, expected: identity, signal: controller.signal };
    const use = vi.fn(async (snapshot: RepoSnapshot) => snapshot.files[0].content);
    expect(await adapter.read(input, use)).not.toContain("private-source-canary");
    expect(await adapter.read(input, use)).toContain("[REDACTED]");
    expect(hooks.access).toHaveBeenCalledTimes(2);
    expect(hooks.snapshot).toHaveBeenCalledTimes(1);
    expect(hooks.access.mock.calls[0][0]).toMatchObject({ signal: controller.signal, accessKind: "installed", expected: identity });
    expect(hooks.snapshot.mock.calls[0][0]).toMatchObject({ signal: controller.signal, token: TOKEN, ref: SHA });
    hooks.state.mockResolvedValue({ ...state, revoked: true });
    await expect(adapter.read(input, use)).rejects.toMatchObject({ code: "refused" });
    expect(use).toHaveBeenCalledTimes(2);
    expect(hooks.snapshot).toHaveBeenCalledTimes(1);
  });
});
