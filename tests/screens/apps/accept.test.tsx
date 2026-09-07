/**
 * Accepting an invitation — the recipient's only Zenith page. Success ends in
 * the app; every refusal names the three things that break an invitation and
 * shows the address the person is actually signed in as.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/client/api";
import { ToastProvider } from "@/components/ui/toast";
import { app, grant, shell } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  shell: undefined as unknown,
  accept: vi.fn(),
  launch: vi.fn(),
}));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  acceptHostedInvite: state.accept,
  launchHostedApp: state.launch,
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AcceptPanel } from "@/app/(product)/apps/accept/accept-panel";

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

const show = async (token: string | null) => {
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <AcceptPanel token={token} />
      </ToastProvider>
    )
  );
};

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  state.shell = shell("viewer");
  state.accept.mockReset();
  state.launch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(noise).toEqual([]);
  vi.restoreAllMocks();
});

describe("Accept an invitation", () => {
  it("says the link is incomplete when it carries no code", async () => {
    await show(null);
    expect(host.textContent).toContain("This invitation link is incomplete");
    expect(host.textContent).toContain("missing its invitation code");
    expect(state.accept).not.toHaveBeenCalled();
  });

  it("ends in the app when the server accepts it", async () => {
    state.accept.mockResolvedValue({ app: app(), grant: grant({ role: "editor" }) });
    await show("token-abc");

    expect(state.accept).toHaveBeenCalledWith("token-abc");
    const text = host.textContent ?? "";
    expect(text).toContain("You now have access to Equipment requests");
    expect(text).toContain("as editor");
    expect(text).toContain("Open Equipment requests");
  });

  it("passes the server's refusal through, with its fix", async () => {
    state.accept.mockRejectedValue(
      new ApiError(
        "This invitation was sent to someone else.",
        403,
        "Sign in with the address the invitation was sent to, then open the link again."
      )
    );
    await show("token-abc");

    const text = host.textContent ?? "";
    expect(text).toContain("This invitation cannot be accepted");
    expect(text).toContain("This invitation was sent to someone else.");
    expect(text).toContain("Sign in with the address the invitation was sent to");
  });

  it("names the three reasons an invitation stops working and who you are signed in as", async () => {
    state.accept.mockRejectedValue(new ApiError("This invitation has expired.", 409));
    await show("token-abc");

    const text = host.textContent ?? "";
    expect(text).toContain("sent to a different email address");
    expect(text).toContain("more than 48 hours old");
    expect(text).toContain("already been used");
    expect(text).toContain("You are signed in as");
    expect(text).toContain("owner@example.com");
  });

  it("asks the server exactly once, even when React replays the effect", async () => {
    state.accept.mockResolvedValue({ app: app(), grant: grant() });
    await show("token-abc");
    await show("token-abc");
    expect(state.accept).toHaveBeenCalledTimes(1);
  });
});
