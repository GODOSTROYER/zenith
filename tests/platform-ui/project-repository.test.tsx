import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectRepositoryPage from "@/app/(product)/p/[slug]/repository/page";
import { button, click, flush, mount, rerender, text } from "../screens/platform/render";

const context = vi.hoisted(() => ({ role: "admin", project: { id: "project_one", workspaceId: "ws_one", slug: "web" }, selectedEnvId: "env_one" }));
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => context }));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => ({ boot: { role: context.role, auth: { configured: true } } }) }));
const fetchMock = vi.fn<typeof fetch>();
const binding = { bindingId: "binding_one", owner: "acme", repo: "web", repositoryId: 10, installationId: 20, version: 3, state: "connected" };
const source = { projectId: "project_one", bindingId: "binding_one", repositoryId: 10, repository: "acme/web", ref: "main", root: "apps/web", contextDir: "", version: 4 };
const commit = "c".repeat(40);
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));
async function settle() { await flush(); await flush(); }
beforeEach(() => {
  context.project = { id: "project_one", workspaceId: "ws_one", slug: "web" }; context.selectedEnvId = "env_one";
  context.role = "admin"; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).includes("/project-source")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return body.detach ? reply({ source: null, version: 5 }) : reply({ source: { ...source, version: 6 }, version: 6 });
      }
      return reply({ source, version: 4 });
    }
    if (String(url).includes("/inspect?")) return reply({ owner: "acme", repo: "web", repositoryId: 10, bindingId: "binding_one", bindingVersion: 3, commitSha: commit, viaBinding: true, candidates: [], monorepo: false, truncated: false, unknowns: [] });
    return reply({ appConfigured: true, bindings: [binding] });
  });
});

describe("project repository attachment", () => {
  it("detaches with the reviewed version without revoking workspace access", async () => {
    const el = mount(<ProjectRepositoryPage />); await settle();
    click(button(el, "Remove from project"));
    expect(writes()).toHaveLength(0);
    click(button(el, "Confirm remove from project")); await settle();
    expect(writes()).toEqual([{ url: "/api/platform/v1/github/project-source", body: { projectId: "project_one", expectedVersion: 4, detach: true } }]);
    expect(text(el)).toContain("Workspace access, other projects, and running applications remain separately managed");
    expect(text(el)).toContain("No repository attached");

    const select = el.querySelector("select")!;
    act(() => { select.value = "binding_one"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    click(button(el, "Inspect repository")); await settle();
    click(button(el, "Attach to project")); await settle();
    expect(writes()[1].body).toMatchObject({ projectId: "project_one", bindingId: "binding_one", expectedVersion: 5, ref: "HEAD" });
  });

  it("carries project environment and source into Gimbal without changing infrastructure", async () => {
    const el = mount(<ProjectRepositoryPage />); await settle();
    const link = [...el.querySelectorAll("a")].find(anchor => anchor.textContent === "Analyze with Gimbal")!;
    const query = new URL(link.href).searchParams;
    expect(query.get("environmentId")).toBe("env_one");
    expect(query.get("bindingId")).toBe("binding_one");
    expect(query.get("root")).toBe("apps/web");
    expect(query.get("contextDir")).toBe("");
    expect(writes()).toHaveLength(0);
  });

  it("does not request private repository metadata for a viewer", async () => {
    context.role = "viewer";
    const el = mount(<ProjectRepositoryPage />); await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text(el)).toContain("Ask a workspace admin");
  });

  it.each(["attach", "detach"])("ignores a late %s response after switching projects", async action => {
    const original = fetchMock.getMockImplementation()!;
    const nextSource = { ...source, projectId: "project_two", bindingId: "binding_two", repositoryId: 11, repository: "acme/teacher", version: 9 };
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes("/project-source") && init?.method === "POST") return new Promise(resolve => { finish = resolve; });
      if (String(url).includes("projectId=project_two")) return reply({ source: nextSource, version: 9 });
      return original(url, init);
    });
    const el = mount(<ProjectRepositoryPage />); await settle();
    if (action === "attach") {
      click(button(el, "Inspect repository")); await settle();
      click(button(el, "Update project source"));
    } else {
      click(button(el, "Remove from project")); click(button(el, "Confirm remove from project"));
    }
    expect(writes()).toHaveLength(1);
    context.project = { id: "project_two", workspaceId: action === "detach" ? "ws_two" : "ws_one", slug: "teacher" };
    context.selectedEnvId = "env_two";
    rerender(el, <ProjectRepositoryPage />); await settle();
    expect(text(el)).toContain("acme/teacher");
    finish(action === "detach" ? reply({ source: null, version: 5 }) : reply({ source: { ...source, version: 6 }, version: 6 })); await settle();
    expect(text(el)).toContain("acme/teacher");
    expect(text(el)).not.toContain("No repository attached");
    expect(text(el)).not.toContain("Repository attached to this project");
    expect(text(el)).not.toContain("Repository removed from this project");
    const link = [...el.querySelectorAll("a")].find(anchor => anchor.textContent === "Analyze with Gimbal")!;
    const query = new URL(link.href).searchParams;
    expect(query.get("bindingId")).toBe("binding_two"); expect(query.get("environmentId")).toBe("env_two");
    expect(button(el, "Remove from project").disabled).toBe(false);
  });
});
