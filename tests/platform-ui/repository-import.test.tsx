/** Source/agent UI interactions. Provider and worker responses are fakes; no live acceptance is claimed. */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryPicker, githubUrl, type RepositorySelection, type SourceBindingView, type SourceInspection } from "@/components/sources/repository-picker";
import { SourcePanel } from "@/app/(product)/platform/source/source-panel";
import { RunControls, StartRun } from "@/app/(product)/platform/coding-agent/run-controls";
import { DEFAULT_LIMITS } from "@/lib/coding-agent/budget";
import { button, click, flush, mount, rerender, text, type } from "../screens/platform/render";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchMock = vi.fn<typeof fetch>();
const binding: SourceBindingView = { bindingId: "bind_one", owner: "acme", repo: "web", repositoryId: 10, installationId: 20, version: 3, state: "connected", manageUrl: "https://github.com/settings/installations/20" };
const second: SourceBindingView = { ...binding, bindingId: "bind_two", repo: "api", repositoryId: 11, version: 8 };
const commit = "a".repeat(40);
const digest = "d".repeat(64);
const inspection: SourceInspection = {
  owner: "acme", repo: "web", repositoryId: 10, bindingId: "bind_one", bindingVersion: 3, commitSha: commit, viaBinding: true,
  candidates: [{ root: "", strategy: "dockerfile", dockerfile: "Dockerfile", confidence: "high", note: "Dockerfile found", language: "node" }],
  selected: { root: "", strategy: "dockerfile", dockerfile: "Dockerfile", confidence: "high", note: "Dockerfile found" },
  monorepo: false, truncated: false, unknowns: [], buildSource: { repo: "acme/web", ref: commit, dockerfile: "Dockerfile", contextDir: "", contextDigest: digest },
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const requests = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined }));
function select(element: HTMLSelectElement, value: string) { act(() => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function settle() { await flush(); await flush(); }
beforeEach(() => {
  fetchMock.mockReset(); router.refresh.mockReset(); router.push.mockReset(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async url => String(url).includes("/inspect?") ? reply(inspection) : reply({ appConfigured: true, bindings: [binding, second] }));
});

describe("repository input", () => {
  it("resolves a deep-linked stable binding outside the first connection page", async () => {
    fetchMock.mockImplementation(async url => String(url).includes("bindingId=")
      ? reply({ bindings: [second], nextCursor: null })
      : reply({ bindings: [binding], nextCursor: "next_page" }));
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialSource={{ bindingId: second.bindingId }} onChange={() => {}} />); await settle();
    expect(requests()).toHaveLength(2);
    expect(new URL(requests()[1].url, "https://zenith.test").searchParams.get("bindingId")).toBe(second.bindingId);
    expect(new Headers(requests()[1].init?.headers).get("x-zenith-workspace")).toBe("ws_one");
    expect(el.querySelector("select")!.value).toBe(second.bindingId);
    expect(el.querySelector(`option[value="${binding.bindingId}"]`)).not.toBeNull();
    expect(text(el)).toContain("Load more authorized repositories");
  });
  it("loads another bounded connection page and preserves earlier selections", async () => {
    fetchMock.mockResolvedValue(reply({ bindings: [second], nextCursor: null }));
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} initialNextCursor="cursor_one" onChange={() => {}} />);
    select(el.querySelector("select")!, binding.bindingId);
    click(button(el, "Load more authorized repositories")); await settle();
    const request = requests()[0];
    expect(new URL(request.url, "https://zenith.test").searchParams.get("cursor")).toBe("cursor_one");
    expect(new Headers(request.init?.headers).get("x-zenith-workspace")).toBe("ws_one");
    expect(el.querySelector("select")!.value).toBe(binding.bindingId);
    expect(el.querySelector(`option[value="${second.bindingId}"]`)).not.toBeNull();
    expect(text(el)).not.toContain("Load more authorized repositories");
  });
  it("reads only the explicitly selected repository and emits a pinned, authorized source", async () => {
    const changed = vi.fn<(selection: RepositorySelection | null) => void>();
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding, second]} onChange={changed} />);
    select(el.querySelector("select")!, "bind_one");
    click(button(el, "Inspect repository")); await settle();
    const request = requests().find(row => row.url.includes("/inspect?"))!;
    const query = new URL(request.url, "https://zenith.test").searchParams;
    expect(query.get("repository")).toBe("acme/web");
    expect(query.get("accessKind")).toBe("installed");
    expect(query.get("contextDir")).toBe("");
    expect(request.init?.credentials).toBe("same-origin");
    expect(new Headers(request.init?.headers).get("x-zenith-workspace")).toBe("ws_one");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ bindingId: "bind_one", bindingVersion: 3, repositoryId: 10, ref: commit, contextDigest: digest }));
    expect(text(el)).toContain(commit);
    type(el.querySelectorAll("input")[0], "release");
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(text(el)).not.toContain(commit);
  });

  it("refuses an inspection whose repository authority changed", async () => {
    fetchMock.mockResolvedValue(reply({ ...inspection, bindingVersion: 4 }));
    const changed = vi.fn();
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} onChange={changed} />);
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(text(el)).toContain("permission changed");
  });

  it("disables revoked grants and makes anonymous public selection explicit", async () => {
    const changed = vi.fn();
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[{ ...binding, state: "revoked" }]} onChange={changed} />);
    expect((el.querySelector('option[value="bind_one"]') as HTMLOptionElement).disabled).toBe(true);
    select(el.querySelector("select")!, "public");
    type(el.querySelector("input")!, "acme/public");
    fetchMock.mockResolvedValue(reply({ ...inspection, owner: "acme", repo: "public", repositoryId: 99, viaBinding: false, bindingId: undefined, bindingVersion: undefined, buildSource: undefined }));
    click(button(el, "Inspect repository")); await settle();
    expect(new URL(requests()[0].url, "https://zenith.test").searchParams.get("accessKind")).toBe("public");
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ repository: "acme/public", repositoryId: 99, ref: commit });
    expect(changed.mock.calls.at(-1)?.[0]).not.toHaveProperty("bindingId");
  });

  it("does not echo provider failure details", async () => {
    fetchMock.mockResolvedValue(reply({ error: { message: "secret=must-not-be-shown" } }, 403));
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} onChange={() => {}} />);
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    expect(text(el)).toContain("Access was refused"); expect(text(el)).not.toContain("must-not-be-shown");
  });

  it("limits provider destinations to GitHub HTTPS", () => {
    expect(githubUrl("https://github.com/settings/installations/1")).toBe("https://github.com/settings/installations/1");
    for (const value of ["javascript:alert(1)", "https://github.com.attacker.test/", "https://user:password@github.com/", "http://github.com/"]) expect(githubUrl(value)).toBeUndefined();
  });

  it("offers verified branch choices while still inspecting the selected ref", async () => {
    fetchMock.mockImplementation(async url => String(url).includes("/branches?") ? reply({ branches: [{ name: "release", commitSha: commit, protected: true }], nextCursor: null }) : reply(inspection));
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} onChange={() => {}} />);
    select(el.querySelector("select")!, "bind_one");
    click(button(el, "Browse branches")); await settle();
    expect(new URL(requests()[0].url, "https://zenith.test").searchParams.get("bindingId")).toBe("bind_one");
    select(el.querySelectorAll("select")[1], "release");
    click(button(el, "Inspect repository")); await settle();
    expect(new URL(requests()[1].url, "https://zenith.test").searchParams.get("ref")).toBe("release");
    expect(text(el)).toContain(commit);
  });

  it("does not republish a late inspection after connection state changes", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} onChange={changed} />);
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository"));
    rerender(el, <RepositoryPicker workspaceId="ws_one" initialBindings={[{ ...binding, state: "revoked", version: 4 }]} onChange={changed} />);
    finish(reply(inspection)); await settle();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(text(el)).not.toContain(commit);
    expect(button(el, "Inspect repository").disabled).toBe(true);
  });

  it("requires a Dockerfile proof for a custom context and explains how to continue analysis without one", async () => {
    const noDockerfile: SourceInspection = { ...inspection, buildSource: undefined, selected: { root: "", strategy: "buildpack", confidence: "medium", needsDockerfile: true, note: "Node application" }, candidates: [] };
    fetchMock.mockImplementation(async () => reply(noDockerfile));
    const changed = vi.fn();
    const el = mount(<RepositoryPicker workspaceId="ws_one" initialBindings={[binding]} onChange={changed} />);
    select(el.querySelector("select")!, "bind_one");
    type(el.querySelectorAll("input")[1], "apps/web");
    click(button(el, "Inspect repository")); await settle();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(text(el)).toContain("Build context needs verification");
    expect(text(el)).toContain("Clear the build context to analyze the repository");
    type(el.querySelectorAll("input")[1], "");
    click(button(el, "Inspect repository")); await settle();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ ref: commit, contextDir: "" }));
  });
});

describe("workspace connections", () => {
  it("pages connection history without dropping the first page or re-enabling revoked identities", async () => {
    fetchMock.mockImplementation(async url => String(url).includes("cursor=")
      ? reply({ appConfigured: true, bindings: [{ ...second, state: "revoked", nameCurrent: false }], nextCursor: null })
      : reply({ appConfigured: true, bindings: [binding], nextCursor: "cursor_two" }));
    const el = mount(<SourcePanel workspaceId="ws_one" viewerRole="admin" />); await settle();
    click(button(el, "Load more connections")); await settle();
    expect(text(el)).toContain("acme/web"); expect(text(el)).toContain("acme/api");
    expect(text(el)).toContain("Historical grant for repository ID 11");
    expect((el.querySelector('option[value="bind_two"]') as HTMLOptionElement).disabled).toBe(true);
    expect(text(el)).not.toContain("Load more connections");
  });
  it("confirms and revokes only the selected binding/version", async () => {
    const el = mount(<SourcePanel workspaceId="ws_one" viewerRole="admin" />); await settle();
    click(button(el, "Stop workspace access to acme/api"));
    expect(requests().filter(row => row.init?.method === "POST")).toHaveLength(0);
    expect(text(el)).toContain("Other repository connections and running applications continue");
    click(button(el, "Confirm stop access")); await settle();
    expect(requests().find(row => row.url.endsWith("/binding/unbind"))?.body).toEqual({ bindingId: "bind_two", version: 8 });
  });

  it("does not fetch or show source metadata to a viewer", async () => {
    const el = mount(<SourcePanel workspaceId="ws_one" viewerRole="viewer" />); await settle();
    expect(fetchMock).not.toHaveBeenCalled(); expect(text(el)).toContain("Only workspace admins"); expect(text(el)).not.toContain("acme/");
  });

  it("checks live access separately from stopping the local grant", async () => {
    fetchMock.mockImplementation(async (url, init) => String(url).endsWith("/binding/sync") && init?.method === "POST" ? reply({ state: "connected", verifiedAt: "2030-01-01T00:00:00Z" }) : reply({ appConfigured: true, bindings: [binding] }));
    const el = mount(<SourcePanel workspaceId="ws_one" viewerRole="admin" />); await settle();
    click(button(el, "Verify access to acme/web")); await settle();
    expect(requests().find(row => row.url.endsWith("/binding/sync"))?.body).toEqual({ bindingId: "bind_one", version: 3 });
    expect(requests().some(row => row.url.endsWith("/binding/unbind"))).toBe(false);
    expect(text(el)).toContain("was verified");
  });

  it("ignores a late mutation refresh after the selected workspace changes", async () => {
    let finish!: (response: Response) => void;
    let firstWorkspaceReads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/binding/unbind")) return reply({ state: "revoked" });
      if (new Headers(init?.headers).get("x-zenith-workspace") === "ws_two") return reply({ appConfigured: true, bindings: [{ ...second, repo: "teacher" }] });
      if (++firstWorkspaceReads === 1) return reply({ appConfigured: true, bindings: [binding] });
      return new Promise(resolve => { finish = resolve; });
    });
    const el = mount(<SourcePanel workspaceId="ws_one" viewerRole="admin" />); await settle();
    click(button(el, "Stop workspace access to acme/web")); click(button(el, "Confirm stop access")); await settle();
    expect(firstWorkspaceReads).toBe(2);
    rerender(el, <SourcePanel workspaceId="ws_two" viewerRole="admin" />); await settle();
    expect(text(el)).toContain("acme/teacher");
    finish(reply({ appConfigured: true, bindings: [{ ...binding, state: "revoked", version: 4 }] })); await settle();
    expect(text(el)).toContain("acme/teacher");
    expect(text(el)).not.toContain("acme/web");
    expect(text(el)).not.toContain("Workspace source access to acme/web has stopped");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(button(el, "Refresh connections").disabled).toBe(false);
  });
});

describe("Gimbal start and adoption", () => {
  it("requires inspection and a planning target, then sends the exact commit with static mode by default", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/inspect?")) return reply(inspection);
      if (init?.method === "POST") return reply({ id: "run_created" });
      return reply({ appConfigured: true, bindings: [binding] });
    });
    const el = mount(<StartRun workspaceId="ws_one" targets={[{ projectId: "project_one", environmentId: "env_one", label: "Web / staging" }]} />); await settle();
    expect(button(el, "Analyze repository").disabled).toBe(true);
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    click(el.querySelector('input[name="gimbal-intent"][value="plan"]')!);
    expect(button(el, "Prepare deployment proposal").disabled).toBe(true);
    select(el.querySelectorAll("select")[1], "env_one");
    act(() => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await settle();
    const request = requests().find(row => row.url.endsWith("/coding-agent/runs") && row.init?.method === "POST")!;
    expect(request.body).toMatchObject({ mode: "static", accessKind: "installed", ref: commit, bindingId: "bind_one", bindingVersion: 3, repositoryId: 10, contextDir: "", contextDigest: digest, dockerfile: "Dockerfile", target: { projectId: "project_one", environmentId: "env_one" } });
    expect(new Headers(request.init?.headers).get("Idempotency-Key")).toMatch(/^[a-f0-9-]{36}$/);
    expect(router.push).toHaveBeenCalledWith("/platform/coding-agent/run_created");
  });

  it("reuses the request key after an uncertain response and rotates it when the draft or mode changes", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/inspect?")) return reply(inspection);
      if (init?.method === "POST") throw new TypeError("The connection closed before a response arrived.");
      return reply({ appConfigured: true, bindings: [binding] });
    });
    const el = mount(<StartRun workspaceId="ws_one" targets={[]} />); await settle();
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    const submit = async () => {
      act(() => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      await settle();
    };
    await submit();
    expect(text(el)).toContain("Submit the same inputs again");
    await submit();
    type(el.querySelector("textarea")!, "Analyze the teacher application and its data storage.");
    await submit();
    click(el.querySelector('input[name="gimbal-mode"][value="model"]')!);
    await submit();
    const submitted = requests().filter(row => row.url.endsWith("/coding-agent/runs") && row.init?.method === "POST");
    const keys = submitted.map(row => new Headers(row.init?.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(4);
    expect(keys.every(key => key && /^[a-f0-9-]{36}$/.test(key))).toBe(true);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[2]);
    expect(submitted[0].body).toEqual(submitted[1].body);
    expect(submitted[3].body.mode).toBe("model");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("does not navigate to a late-created run after switching workspaces", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/inspect?")) return reply(inspection);
      if (init?.method === "POST") return new Promise(resolve => { finish = resolve; });
      return reply({ appConfigured: true, bindings: [binding] });
    });
    const el = mount(<StartRun workspaceId="ws_one" targets={[]} />); await settle();
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    act(() => { el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    rerender(el, <StartRun workspaceId="ws_two" targets={[]} />); await settle();
    finish(reply({ id: "old_workspace_run" })); await settle();
    expect(router.push).not.toHaveBeenCalled();
    select(el.querySelector("select")!, "bind_one"); click(button(el, "Inspect repository")); await settle();
    expect(button(el, "Analyze repository").disabled).toBe(false);
  });

  it("sends the captured base revision and refuses legacy adoption without one", async () => {
    fetchMock.mockResolvedValue(reply({ adopted: true }));
    const props = { workspaceId: "ws_one", runId: "run_one", resumable: false, cancellable: false, adoptReady: true, adoptReason: "", hasProject: true };
    const old = mount(<RunControls {...props} />);
    expect(button(old, "Adopt into project").disabled).toBe(true);
    const el = mount(<RunControls {...props} baseManifestHash="a1b2c3d4" />);
    click(button(el, "Adopt into project")); await settle();
    expect(requests()[0].body).toEqual({ expectedHash: "a1b2c3d4" });
    expect(requests()).toHaveLength(1);
  });

  it("shows the increased total and requires an explicit budget decision before resuming", async () => {
    fetchMock.mockResolvedValue(reply({ id: "run_one" }));
    const el = mount(<RunControls workspaceId="ws_one" runId="run_one" resumable cancellable adoptReady={false} adoptReason="Awaiting approval" hasProject limits={DEFAULT_LIMITS} />);
    click(button(el, "Review higher budgets"));
    expect(fetchMock).not.toHaveBeenCalled(); expect(text(el)).toContain("$2.00 to $4.00");
    click(button(el, "Approve budget and resume")); await settle();
    expect(requests()[0].body.limits).toMatchObject({ spendMicroUsd: 4_000_000, toolCalls: 80, wallTimeMs: 360_000 });
  });

  it("prepares handoff only through the authenticated run endpoint", async () => {
    fetchMock.mockResolvedValue(reply({ digest, expiresAt: "2030-01-01T00:00:00Z", filename: "zenith-handoff.md", markdown: "# Continue\nCommit: " + commit, mcp: { path: "/api/agent/v3/mcp", tool: "zenith_get_handoff", arguments: {} } }));
    const el = mount(<RunControls workspaceId="ws_one" runId="run_one" resumable={false} cancellable={false} adoptReady={false} adoptReason="No target" hasProject={false} />);
    click(button(el, "Continue in Claude Code")); await settle();
    expect(requests()[0].url).toBe("/api/platform/v1/coding-agent/runs/run_one/handoff");
    expect(requests()[0].body).toEqual({});
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toContain(commit);
    expect(text(el)).toContain("revoke that connection independently");
  });

  it("ignores an old run's late handoff and clears continuation content when the run changes", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const props = { workspaceId: "ws_one", resumable: false, cancellable: false, adoptReady: false, adoptReason: "No proposal", hasProject: false };
    const el = mount(<RunControls {...props} runId="run_one" />);
    click(button(el, "Continue in Claude Code"));
    rerender(el, <RunControls {...props} runId="run_two" />);
    const context = { digest, expiresAt: "2030-01-01T00:00:00Z", filename: "context.md", markdown: "# Old source context", mcp: null };
    finish(reply(context)); await settle();
    expect(el.querySelector('textarea')).toBeNull();
    expect(button(el, "Continue in Claude Code").disabled).toBe(false);
    fetchMock.mockImplementation(async () => reply({ ...context, markdown: "# Current source context" }));
    click(button(el, "Continue in Claude Code")); await settle();
    expect(el.querySelector('textarea')?.value).toContain("Current source context");
    rerender(el, <RunControls {...props} runId="run_three" />);
    expect(el.querySelector('textarea')).toBeNull();
  });

  it("confirms content deletion separately from repository access", async () => {
    fetchMock.mockResolvedValue(reply({ deleted: true }));
    const el = mount(<RunControls workspaceId="ws_one" runId="run_one" resumable={false} cancellable={false} adoptReady={false} adoptReason="No target" hasProject={false} runVersion={7} contentDeletable />);
    click(button(el, "Delete analysis content"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(el)).toContain("Minimal audit records remain");
    click(button(el, "Confirm delete analysis content")); await settle();
    expect(requests()[0].init?.method).toBe("DELETE");
    expect(requests()[0].body).toEqual({ expectedVersion: 7 });
    expect(requests()[0].url).toBe("/api/platform/v1/coding-agent/runs/run_one");
    expect(router.push).toHaveBeenCalledWith("/platform/coding-agent");
  });
});
