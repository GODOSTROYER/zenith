import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  shell: undefined as unknown,
  api: vi.fn(),
  push: vi.fn(),
  routerRefresh: vi.fn(),
  shellRefresh: vi.fn(),
}));

vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: state.api,
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: state.routerRefresh }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { InvitationPanel } from "@/app/(product)/invite/invitation-panel";

const invitation = (overrides: Record<string, unknown> = {}) => ({
  id: "invite-atlas",
  workspaceId: "workspace-atlas",
  workspaceName: "Atlas",
  email: "invited@example.com",
  role: "viewer",
  createdBy: "admin-atlas",
  createdAt: "2026-09-25T12:00:00.000Z",
  expiresAt: "2099-09-30T12:00:00.000Z",
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;

const response = (invitations = [invitation()]) => ({
  ok: true,
  status: 200,
  json: async () => ({ email: "invited@example.com", invitations }),
});

const show = async (inviteId: string | null = "invite-atlas") => {
  await act(async () => root.render(<InvitationPanel inviteId={inviteId} />));
};

const acceptButton = (workspace = "Atlas") =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Accept invitation to ${workspace}"]`)!;

beforeEach(() => {
  state.api.mockReset();
  state.push.mockReset();
  state.routerRefresh.mockReset();
  state.shellRefresh.mockReset();
  state.shell = {
    boot: { workspace: { id: "workspace-old" }, user: { email: "invited@example.com" } },
    loading: false,
    error: undefined,
    refresh: state.shellRefresh,
  };
  fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("workspace invitation acceptance", () => {
  it("shows only the targeted invitation with its email and offered role", async () => {
    fetcher.mockResolvedValue(response([
      invitation(),
      invitation({ id: "invite-orbit", workspaceName: "Orbit", role: "admin" }),
    ]));
    await show();

    expect(host.textContent).toContain("Atlas");
    expect(host.textContent).toContain("invited@example.com");
    expect(host.textContent).toContain("viewer");
    expect(host.textContent).toContain("Read workspace projects and activity.");
    expect(host.textContent).not.toContain("Orbit");
    expect(acceptButton().disabled).toBe(false);
    expect(state.api).not.toHaveBeenCalled();
  });

  it("allows a new account to accept its first workspace even when bootstrap failed", async () => {
    state.shell = {
      boot: undefined,
      loading: false,
      error: new ApiError("You do not belong to a workspace yet.", 403),
      refresh: state.shellRefresh,
    };
    state.api.mockResolvedValue({ workspace: { id: "workspace-atlas" }, member: { role: "viewer" } });
    await show();
    expect(fetcher).toHaveBeenCalledWith("/api/workspace/invitations", expect.any(Object));
    expect(host.textContent).toContain("Signed in as invited@example.com");

    await act(async () => acceptButton().click());
    expect(state.api).toHaveBeenCalledWith("/api/workspace/invites/invite-atlas/accept", { method: "POST" });
    expect(state.shellRefresh).toHaveBeenCalledOnce();
    expect(state.push).toHaveBeenCalledWith("/overview");
    expect(state.routerRefresh).toHaveBeenCalledOnce();
  });

  it("lists pending invitations without a query and prevents simultaneous acceptance", async () => {
    fetcher.mockResolvedValue(response([
      invitation(),
      invitation({ id: "invite-orbit", workspaceName: "Orbit", role: "editor" }),
    ]));
    let finish!: (value: unknown) => void;
    state.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await show(null);

    expect(host.textContent).toContain("Workspace invitations");
    expect(acceptButton("Atlas").disabled).toBe(false);
    expect(acceptButton("Orbit").disabled).toBe(false);
    await act(async () => {
      acceptButton("Atlas").click();
      acceptButton("Atlas").click();
    });
    expect(state.api).toHaveBeenCalledOnce();
    expect(acceptButton("Atlas").getAttribute("aria-busy")).toBe("true");
    expect(acceptButton("Orbit").disabled).toBe(true);
    expect(state.push).not.toHaveBeenCalled();
    await act(async () => finish({ workspace: { id: "workspace-atlas" } }));
    expect(state.push).toHaveBeenCalledWith("/overview");
  });

  it("explains unavailable links without revealing another workspace and offers account switching", async () => {
    fetcher.mockResolvedValue(response([invitation({ id: "unrelated", workspaceName: "Private Orbit" })]));
    await show("unknown-invite");

    expect(host.textContent).toContain("This invitation is unavailable");
    expect(host.textContent).toContain("expired, been revoked, already been accepted");
    expect(host.textContent).toContain("different email address");
    expect(host.textContent).toContain("Signed in as invited@example.com");
    expect(host.textContent).not.toContain("Private Orbit");
    expect(acceptButton()).toBeNull();
    expect(host.querySelector('form[action="/auth/signout"]')?.getAttribute("method")).toBe("post");
    expect(host.querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe("/invite?invite=unknown-invite");
    expect(state.api).not.toHaveBeenCalled();
  });

  it.each([
    [{ expiresAt: "2000-01-01T00:00:00.000Z" }, "This invitation has expired"],
    [{ revokedAt: "2026-09-26T00:00:00.000Z" }, "This invitation was revoked"],
    [{ acceptedAt: "2026-09-26T00:00:00.000Z" }, "This invitation has already been accepted"],
  ])("disables an invitation whose returned status is unavailable (%j)", async (status, message) => {
    fetcher.mockResolvedValue(response([invitation(status)]));
    await show();
    expect(host.textContent).toContain(message);
    expect(acceptButton().disabled).toBe(true);
    expect(acceptButton().title).toContain(message);
  });

  it("keeps the server's refusal visible and reloads the invitation after an acceptance race", async () => {
    state.api.mockRejectedValue(new ApiError("This invitation was revoked.", 409, "Ask an admin for a new invitation."));
    await show();
    fetcher.mockResolvedValue(response([]));
    await act(async () => acceptButton().click());

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("This invitation was revoked.");
    expect(host.textContent).toContain("Ask an admin for a new invitation.");
    expect(acceptButton()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.shellRefresh).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("offers a retry when the inbox fails instead of claiming the invitation is absent", async () => {
    fetcher.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: "The service is unavailable.", fix: "Try again shortly." } }),
    });
    await show();
    expect(host.textContent).toContain("Invitations could not be loaded");
    expect(host.textContent).toContain("Try again shortly.");
    expect(host.textContent).not.toContain("This invitation is unavailable");
    fetcher.mockResolvedValue(response());
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(acceptButton().disabled).toBe(false);
  });

  it("shows the empty inbox when no link or pending invitations exist", async () => {
    fetcher.mockResolvedValue(response([]));
    await show(null);
    expect(host.textContent).toContain("No pending invitations");
    expect(host.textContent).not.toContain("This invitation is unavailable");
    expect(state.api).not.toHaveBeenCalled();
  });
});
