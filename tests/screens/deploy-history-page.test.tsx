import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DeploysPage from "@/app/(product)/p/[slug]/deploys/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ api: vi.fn(), select: vi.fn(), envCallback: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: mocks.api }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock("@/components/screens/project-data", () => ({ useSelectedEnv: () => ({
  data: { revisions: [] }, env: { id: "env1", name: "Staging", class: "staging" }, projectId: "p1", slug: "one", refresh: () => {}, setSelectedEnv: mocks.envCallback,
}) }));
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({ deployments: [] }) }));
vi.mock("@/components/screens/shared", () => ({ ErrorNote: ({ error }: { error: Error }) => <p role="alert">{error.message}</p> }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button> }));
vi.mock("@/app/(product)/p/[slug]/deploys/deployment-detail", () => ({ DeploymentDetail: ({ snapshot }: { snapshot: { id: string } }) => <p data-detail>{snapshot.id}</p> }));
vi.mock("@/app/(product)/p/[slug]/deploys/deployment-list", () => ({ DeploymentList: ({ onSelect }: { onSelect: (id: string) => void }) => <button onClick={() => onSelect("recent")}>Select recent</button> }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.api.mockReset(); mocks.select.mockReset();
  mocks.envCallback = vi.fn(mocks.select);
  window.history.replaceState(null, "", "/p/one/deploys?deployment=old");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("opens the exact scoped deployment even when it is outside the loaded history page", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/deployments/")
    ? { deployment: { id: "old", projectId: "p1", environmentId: "env1" } }
    : { deployments: [{ id: "recent", revisionId: "r2" }], total: 51, nextCursor: "50" });
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("old");
  expect(mocks.select).toHaveBeenCalledWith("env1");
  await act(async () => host.querySelector("button")!.click());
  mocks.envCallback = vi.fn(mocks.select);
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("recent");
  expect(mocks.api.mock.calls.filter(([url]) => url.startsWith("/api/deployments/"))).toHaveLength(1);
});

it("rejects a deployment from another project without relabeling it as the selected project", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/deployments/")
    ? { deployment: { id: "old", projectId: "p2", environmentId: "env2" } }
    : { deployments: [{ id: "recent", revisionId: "r2" }], total: 1 });
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[role=alert]")?.textContent).toContain("another project");
  expect(host.querySelector("[data-detail]")?.textContent).toBe("recent");
  expect(mocks.select).not.toHaveBeenCalled();
});

it("selects a new deployment when navigation changes only the query on the same route", async () => {
  mocks.api.mockImplementation(async (url: string) => url.startsWith("/api/deployments/")
    ? { deployment: { id: url.split("/").at(-1), projectId: "p1", environmentId: "env1" } }
    : { deployments: [{ id: "recent", revisionId: "r2" }], total: 1 });
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("old");
  window.history.replaceState(null, "", "/p/one/deploys?deployment=another");
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("another");
  expect(mocks.api).toHaveBeenCalledWith("/api/deployments/another");
});

it("clears a linked deployment and a stale error when the deployment query is removed", async () => {
  mocks.api.mockImplementation(async (url: string) => {
    if (url === "/api/deployments/missing") throw new Error("Deployment not found");
    return url.startsWith("/api/deployments/")
      ? { deployment: { id: "old", projectId: "p1", environmentId: "env1" } }
      : { deployments: [{ id: "recent", revisionId: "r2" }], total: 1 };
  });
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("old");
  window.history.replaceState(null, "", "/p/one/deploys");
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("recent");
  window.history.replaceState(null, "", "/p/one/deploys?deployment=missing");
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Deployment not found");
  window.history.replaceState(null, "", "/p/one/deploys");
  await act(async () => root.render(<DeploysPage />));
  expect(host.querySelector("[role=alert]")).toBeNull();
  expect(host.querySelector("[data-detail]")?.textContent).toBe("recent");
});

it("ignores a late linked response after its query was removed", async () => {
  let finish!: (value: unknown) => void;
  mocks.api.mockImplementation((url: string) => url.startsWith("/api/deployments/")
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve({ deployments: [{ id: "recent", revisionId: "r2" }], total: 1 }));
  await act(async () => root.render(<DeploysPage />));
  window.history.replaceState(null, "", "/p/one/deploys");
  await act(async () => root.render(<DeploysPage />));
  await act(async () => finish({ deployment: { id: "old", projectId: "p1", environmentId: "env1" } }));
  expect(host.querySelector("[data-detail]")?.textContent).toBe("recent");
  expect(mocks.select).not.toHaveBeenCalled();
});
