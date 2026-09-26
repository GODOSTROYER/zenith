import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/lib/client/api";
import type { Bootstrap, ShellData } from "@/components/shell/shell-context";
import type { Workspace } from "@/lib/domain/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  shell: undefined as unknown,
  api: vi.fn(), refresh: vi.fn(), sharing: vi.fn(),
}));
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: state.api,
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("@/components/workspace/workspace-sharing", () => ({ WorkspaceSharing: state.sharing }));
vi.mock("next/link", () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));

import { WorkspaceAccessPage } from "@/app/(product)/workspace/workspace-access-page";

const atlas: Workspace = { id: "atlas", name: "Atlas", slug: "atlas", createdAt: "2026-09-01T00:00:00Z" };
const orbit: Workspace = { id: "orbit", name: "Orbit", slug: "orbit", createdAt: "2026-09-01T00:00:00Z" };
const bootstrap = (workspace = atlas): Bootstrap => ({
  catalog: [], workspace,
  workspaces: [{ ...atlas, role: "admin" }, { ...orbit, role: "viewer" }],
  projects: [], environments: [], deployments: [], connections: [], providers: [], settings: {},
  user: { id: "user", name: "Person", email: "person@example.com" },
  role: workspace.id === "atlas" ? "admin" : "viewer", auth: { configured: true }, members: [],
});

let root: Root;
let host: HTMLDivElement;
let shell: ShellData;

const show = async (requestedWorkspaceId?: string) => {
  await act(async () => root.render(<StrictMode><WorkspaceAccessPage requestedWorkspaceId={requestedWorkspaceId} /></StrictMode>));
};
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;

beforeEach(() => {
  state.api.mockReset();
  state.refresh.mockReset();
  state.sharing.mockReset();
  state.sharing.mockImplementation(({ boot }: { boot: Bootstrap | undefined }) => boot
    ? <div data-testid="workspace-access-controls">Controls for {boot.workspace.name}</div>
    : <div role="status">Loading workspace</div>);
  shell = { boot: bootstrap(), loading: false, error: undefined, refresh: state.refresh, catalog: [] };
  state.shell = shell;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("workspace sharing links", () => {
  it.each([undefined, "atlas"])("shows the current workspace's access when the target is %s", async (target) => {
    await show(target);
    expect(host.textContent).toContain("Share Atlas");
    expect(host.textContent).toContain("Controls for Atlas");
    expect(state.sharing).toHaveBeenCalledWith({ boot: shell.boot, refresh: state.refresh }, undefined);
    expect(state.api).not.toHaveBeenCalled();
    expect(host.querySelector('a[aria-label="Share Orbit"]')?.getAttribute("href")).toBe("/workspace?workspace=orbit");
  });

  it("selects a known membership once and waits for matching bootstrap before showing controls", async () => {
    let selected!: (result: unknown) => void;
    state.api.mockImplementation(() => new Promise((resolve) => { selected = resolve; }));
    await show("orbit");

    expect(state.api).toHaveBeenCalledExactlyOnceWith("/api/workspace/select", {
      method: "POST", body: JSON.stringify({ workspaceId: "orbit" }),
    });
    expect(host.querySelector('[role="status"][aria-label="Selecting workspace"]')).not.toBeNull();
    expect(state.sharing).not.toHaveBeenCalled();
    await act(async () => selected({ workspace: orbit }));
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.sharing).not.toHaveBeenCalled();

    shell.boot = bootstrap(orbit);
    await show("orbit");
    expect(host.textContent).toContain("Share Orbit");
    expect(host.textContent).toContain("Controls for Orbit");
    expect(host.textContent).not.toContain("Controls for Atlas");
    expect(state.api).toHaveBeenCalledOnce();
  });

  it("refuses an unknown workspace without selecting it or rendering membership controls", async () => {
    await show("unknown-workspace");
    expect(host.textContent).toContain("This workspace is not available to your account");
    expect(host.textContent).toContain("A workspace link does not grant access");
    expect(host.querySelector('a[href="/invite"]')).not.toBeNull();
    expect(state.api).not.toHaveBeenCalled();
    expect(state.sharing).not.toHaveBeenCalled();
  });

  it("shows a selection refusal and retries only when requested", async () => {
    state.api.mockRejectedValueOnce(new ApiError("Workspace selection failed.", 503, "Please try again."));
    await show("orbit");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Workspace selection failed.");
    expect(host.textContent).toContain("Please try again.");
    expect(state.api).toHaveBeenCalledOnce();
    expect(state.sharing).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();

    state.api.mockResolvedValue({ workspace: orbit });
    await act(async () => button("Retry selecting workspace").click());
    expect(state.api).toHaveBeenCalledTimes(2);
    expect(state.api).toHaveBeenLastCalledWith("/api/workspace/select", {
      method: "POST", body: JSON.stringify({ workspaceId: "orbit" }),
    });
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(state.sharing).not.toHaveBeenCalled();
    shell.boot = bootstrap(orbit);
    await show("orbit");
    expect(host.textContent).toContain("Controls for Orbit");
  });

  it("offers a bootstrap retry and invitations when the account has no workspace data", async () => {
    shell.boot = undefined;
    shell.error = new ApiError("Your workspace could not be loaded.", 503);
    await show("orbit");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Your workspace could not be loaded.");
    expect(host.querySelector('a[href="/invite"]')).not.toBeNull();
    expect(state.api).not.toHaveBeenCalled();
    expect(state.sharing).not.toHaveBeenCalled();
    await act(async () => button("Retry loading workspace").click());
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it("does not show access controls from stale bootstrap after an access refresh error", async () => {
    shell.error = new ApiError("Workspace access could not be refreshed.", 503);
    await show("atlas");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Workspace access could not be refreshed.");
    expect(state.api).not.toHaveBeenCalled();
    expect(state.sharing).not.toHaveBeenCalled();
  });
});
