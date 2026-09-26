import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/lib/client/api";
import type { Bootstrap } from "@/components/shell/shell-context";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import { WorkspaceSharing, type WorkspaceSharingData } from "@/components/workspace/workspace-sharing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  api: vi.fn(), read: vi.fn(), refresh: vi.fn(), shellRefresh: vi.fn(),
  push: vi.fn(), routerRefresh: vi.fn(), copy: vi.fn(),
}));
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: calls.api,
  useJson: calls.read,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: calls.push, refresh: calls.routerRefresh }),
}));

const workspace: Workspace = {
  id: "ws-atlas", ownerId: "owner", name: "Atlas", slug: "atlas", createdAt: "2026-09-01T00:00:00.000Z",
};
const members: Member[] = [
  { id: "owner", workspaceId: workspace.id, name: "Olivia Owner", email: "owner@example.com", role: "admin" },
  { id: "admin", workspaceId: workspace.id, name: "Alex Admin", email: "admin@example.com", role: "admin" },
  { id: "editor", workspaceId: workspace.id, name: "Erin Editor", email: "editor@example.com", role: "editor" },
  { id: "viewer", workspaceId: workspace.id, name: "Val Viewer", email: "viewer@example.com", role: "viewer" },
];
const invite = (overrides: Partial<Invite> = {}): Invite => ({
  id: "invite-viewer", workspaceId: workspace.id, email: "new@example.com", role: "viewer",
  createdBy: "owner", createdAt: "2026-09-25T00:00:00.000Z", expiresAt: "2099-09-30T00:00:00.000Z", ...overrides,
});

let data: WorkspaceSharingData;
let readError: ApiError | undefined;
let boot: Bootstrap;
let host: HTMLDivElement;
let root: Root;
let originalClipboard: PropertyDescriptor | undefined;

function account(id: "owner" | "admin" | "editor" | "viewer") {
  const member = members.find((row) => row.id === id)!;
  data = {
    workspace, members, invites: [], role: member.role,
    isOwner: id === "owner", canManageMembers: member.role === "admin", canManageAdmins: id === "owner",
  };
  boot = {
    catalog: [], workspace, workspaces: [{ ...workspace, role: member.role }], projects: [],
    environments: [], deployments: [], connections: [], providers: [], settings: {},
    user: { id: member.id, name: member.name, email: member.email }, role: member.role,
    auth: { configured: true }, members,
  };
}

const show = async () => {
  await act(async () => root.render(<WorkspaceSharing boot={boot} refresh={calls.shellRefresh} />));
};
const buttons = (text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === text);
const button = (text: string, within: ParentNode = document) => buttons(text, within)[0]!;
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((panel) => !panel.closest("[inert]"))!;
const click = async (target: HTMLButtonElement) => { await act(async () => target.click()); };
const change = async (target: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event(target instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
};
const field = <T extends HTMLInputElement | HTMLSelectElement>(labelText: string): T => {
  const label = [...document.querySelectorAll("label")].find((element) => element.textContent?.startsWith(labelText))!;
  return document.getElementById(label.htmlFor) as T;
};
const roleSelect = (name: string) => host.querySelector<HTMLSelectElement>(`select[aria-label="Role for ${name}"]`);

beforeEach(() => {
  for (const mock of Object.values(calls)) mock.mockReset();
  calls.api.mockResolvedValue({ ok: true });
  calls.copy.mockResolvedValue(undefined);
  calls.read.mockImplementation(() => ({ data, error: readError, loading: false, refresh: calls.refresh }));
  readError = undefined;
  account("owner");
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: calls.copy } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("workspace sharing permissions", () => {
  it.each(["viewer", "editor"] as const)("gives %s only link copying and their own confirmed exit", async (id) => {
    account(id);
    await show();
    expect(calls.read).toHaveBeenCalledWith("/api/workspace/sharing?workspaceId=ws-atlas", 10_000);
    expect(host.querySelectorAll("select")).toHaveLength(0);
    expect(buttons("Create invitation")).toHaveLength(0);
    expect(host.querySelector('[aria-label^="Remove "]')).toBeNull();
    expect(buttons("Transfer ownership…")).toHaveLength(0);
    expect(buttons("Copy workspace link")).toHaveLength(1);
    expect(buttons("Leave workspace…")).toHaveLength(1);

    await click(button("Copy workspace link"));
    expect(calls.copy).toHaveBeenCalledWith("http://localhost/workspace?workspace=ws-atlas");
    expect(host.textContent).toContain("does not grant access");
    expect(calls.api).not.toHaveBeenCalled();
    await click(button("Leave workspace…"));
    expect(dialog().textContent).toContain("You will lose access to every project in Atlas");
    expect(calls.api).not.toHaveBeenCalled();
    await click(button("Leave workspace", dialog()));
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/leave", {
      method: "POST", body: JSON.stringify({ workspaceId: "ws-atlas" }),
    });
    expect(calls.push).toHaveBeenCalledWith("/onboarding?step=1");
    expect(calls.routerRefresh).toHaveBeenCalledOnce();
  });

  it("lets admins manage viewers and editors while hiding admin and owner controls", async () => {
    account("admin");
    data.invites = [invite({ id: "invite-admin", role: "admin", email: "future-admin@example.com" })];
    await show();
    expect(roleSelect("Olivia Owner")).toBeNull();
    expect(roleSelect("Alex Admin")).toBeNull();
    expect(host.querySelector('[aria-label="Remove Olivia Owner"]')).toBeNull();
    expect(host.querySelector('[aria-label="Remove Alex Admin"]')).toBeNull();
    expect(roleSelect("Erin Editor")).not.toBeNull();
    expect(roleSelect("Val Viewer")).not.toBeNull();
    for (const select of host.querySelectorAll("select")) {
      expect([...select.options].map((option) => option.value)).not.toContain("admin");
    }
    expect(host.querySelector('[aria-label="Revoke invite for future-admin@example.com"]')).toBeNull();
    expect(buttons("Renew invite")).toHaveLength(0);
    expect(buttons("Transfer ownership…")).toHaveLength(0);
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("requires the exact workspace name before transferring ownership", async () => {
    await show();
    expect(buttons("Leave workspace…")).toHaveLength(0);
    expect(button("Transfer ownership…").disabled).toBe(true);
    await change(field<HTMLSelectElement>("New owner"), "editor");
    await click(button("Transfer ownership…"));
    const confirm = button("Transfer ownership", dialog());
    expect(dialog().textContent).toContain("Erin Editor (editor@example.com)");
    expect(dialog().textContent).toContain("You remain an admin");
    expect(confirm.disabled).toBe(true);
    await change(field<HTMLInputElement>("Type Atlas to confirm"), "atlas");
    expect(confirm.disabled).toBe(true);
    await change(field<HTMLInputElement>("Type Atlas to confirm"), "Atlas");
    expect(confirm.disabled).toBe(false);
    expect(calls.api).not.toHaveBeenCalled();
    await click(confirm);
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/ownership", {
      method: "POST", body: JSON.stringify({ workspaceId: "ws-atlas", memberId: "editor" }),
    });
    expect(calls.refresh).toHaveBeenCalledOnce();
    expect(calls.shellRefresh).toHaveBeenCalledOnce();
  });

  it("uses server permissions rather than a stale admin role in bootstrap", async () => {
    account("viewer");
    boot.role = "admin";
    await show();
    expect(buttons("Create invitation")).toHaveLength(0);
    expect(host.querySelectorAll("select")).toHaveLength(0);
    expect(host.textContent).toContain("You have viewer access");
  });
});

describe("workspace invitations and confirmations", () => {
  it("defaults an invitation to viewer and exposes the server's link for sharing", async () => {
    calls.api.mockResolvedValue({ invite: invite(), inviteUrl: "/invite?invite=invite-viewer" });
    await show();
    expect(field<HTMLSelectElement>("Workspace role").value).toBe("viewer");
    await change(field<HTMLInputElement>("Email address"), "New@Example.com");
    await click(button("Create invitation"));
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/invites", {
      method: "POST", body: JSON.stringify({ email: "new@example.com", role: "viewer", workspaceId: "ws-atlas" }),
    });
    expect(field<HTMLInputElement>("Link to share").value).toBe("http://localhost/invite?invite=invite-viewer");
    expect(field<HTMLInputElement>("Email address").value).toBe("");
    expect(host.textContent).toContain("No email is sent.");

    data = { ...data, invites: [invite()] };
    await show();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Copy invite for new@example.com"]')!);
    expect(calls.copy).toHaveBeenCalledWith("http://localhost/invite?invite=invite-viewer");
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it("keeps a selectable invite link when the clipboard is unavailable", async () => {
    data.invites = [invite()];
    calls.copy.mockRejectedValue(new Error("Clipboard denied"));
    await show();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Copy invite for new@example.com"]')!);
    expect(host.textContent).toContain("Copy the link from the field below");
    expect(field<HTMLInputElement>("Link to share").value).toBe("http://localhost/invite?invite=invite-viewer");
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("waits for role confirmation and scopes the request to this workspace", async () => {
    await show();
    await change(roleSelect("Val Viewer")!, "editor");
    expect(calls.api).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Val Viewer (viewer@example.com) will change from viewer to editor");
    await click(button("Change role", dialog()));
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/members/viewer?workspaceId=ws-atlas", {
      method: "PATCH", body: JSON.stringify({ workspaceId: "ws-atlas", role: "editor" }),
    });
    expect(host.textContent).toContain("Val Viewer now has editor access.");
  });

  it("waits for removal confirmation and allows cancellation without a mutation", async () => {
    await show();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove Erin Editor"]')!);
    expect(dialog().textContent).toContain("will lose access to every project in Atlas");
    expect(calls.api).not.toHaveBeenCalled();
    await click(button("Cancel", dialog()));
    expect(calls.api).not.toHaveBeenCalled();

    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove Erin Editor"]')!);
    await click(button("Remove member", dialog()));
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/members/editor?workspaceId=ws-atlas", { method: "DELETE" });
    expect(host.textContent).toContain("Erin Editor no longer has access to Atlas.");
  });

  it("keeps a refused confirmation open with the server's error and fix", async () => {
    calls.api.mockRejectedValue(new ApiError("Your permissions have changed.", 403, "Ask the workspace owner to update access."));
    await show();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Remove Erin Editor"]')!);
    await click(button("Remove member", dialog()));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Your permissions have changed.");
    expect(dialog().textContent).toContain("Ask the workspace owner to update access.");
    expect(button("Remove member", dialog()).disabled).toBe(false);
    expect(calls.refresh).not.toHaveBeenCalled();
    expect(calls.shellRefresh).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Erin Editor no longer has access");
  });

  it("scopes invitation renewal and revocation to the selected workspace", async () => {
    data.invites = [invite()];
    calls.api.mockResolvedValue({ invite: invite(), inviteUrl: "/invite?invite=renewed" });
    await show();
    await click(button("Renew invite"));
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/invites/invite-viewer/resend", {
      method: "POST", body: JSON.stringify({ workspaceId: "ws-atlas" }),
    });
    expect(field<HTMLInputElement>("Link to share").value).toBe("http://localhost/invite?invite=renewed");
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Revoke invite for new@example.com"]')!);
    expect(calls.api).toHaveBeenCalledWith("/api/workspace/invites/invite-viewer?workspaceId=ws-atlas", { method: "DELETE" });
  });

  it("disables mutations when a refresh fails and retains the visible access error", async () => {
    readError = new ApiError("Access could not be refreshed.", 503);
    await show();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Access could not be refreshed.");
    expect(roleSelect("Erin Editor")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove Erin Editor"]')!.disabled).toBe(true);
    expect(field<HTMLInputElement>("Email address").disabled).toBe(true);
    expect(button("Copy workspace link").disabled).toBe(false);
    expect(calls.api).not.toHaveBeenCalled();
  });
});
