/**
 * The app screen end to end: every section renders from one payload, the two
 * roles publishing needs are both named, and a recovering app says that
 * reopening it is an operator's job.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { app, detail, grant, health, idle, invite, listPayload, loaded, shell } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  detail: undefined as unknown,
  apps: undefined as unknown,
  health: undefined as unknown,
  grants: undefined as unknown,
  invites: undefined as unknown,
  usage: undefined as unknown,
  spending: undefined as unknown,
  shell: undefined as unknown,
}));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  useHostedApp: () => state.detail,
  useHostedApps: () => state.apps,
  useHostedHealth: () => state.health,
  useHostedGrants: () => state.grants,
  useHostedInvites: () => state.invites,
  useHostedUsage: () => state.usage,
  useSpending: () => state.spending,
  launchHostedApp: vi.fn(),
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import AppDetailPage from "@/app/(product)/apps/[appId]/page";

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

const show = async () => {
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <Suspense fallback={null}>
          <AppDetailPage params={Promise.resolve({ appId: "app-1" })} />
        </Suspense>
      </ToastProvider>
    )
  );
};

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label));

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  );
  state.detail = loaded(detail());
  state.apps = loaded(listPayload());
  state.health = loaded(health());
  state.grants = loaded({ grants: [grant()] });
  state.invites = loaded({ invites: [invite()], deliveries: [] });
  state.usage = idle();
  state.spending = idle();
  state.shell = shell("editor");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  expect(noise).toEqual([]);
  vi.restoreAllMocks();
});

describe("App screen", () => {
  it("lays out every section from one payload", async () => {
    await show();
    const text = host.textContent ?? "";
    for (const section of [
      "Overview",
      "Publish",
      "Releases",
      "Audience",
      "Limits & usage",
      "Health & logs",
      "Export & recovery",
    ])
      expect(text).toContain(section);
    expect(host.querySelector("#overview")).not.toBeNull();
    expect(host.querySelector("#export")).not.toBeNull();
    expect(text).toContain("http://equipment.apps.localhost/");
    expect(text).toContain("Release 2");
  });

  it("names both roles publishing needs, not just one", async () => {
    await show();
    const text = host.textContent ?? "";
    expect(text).toContain("needs editor");
    expect(text).toContain("needs app owner");
    expect(text).toContain("the editor role in Kepler Labs and the owner role on this app");
  });

  it("lets an owning editor publish, and reserves suspend for a workspace admin", async () => {
    await show();
    expect(button("Publish")?.disabled).toBe(true); // no source chosen yet
    expect(button("Publish")?.title).toContain("Choose what to publish first.");
    expect(button("Suspend")?.disabled).toBe(true);
    expect(button("Suspend")?.title).toContain("admin role in Kepler Labs");
  });

  it("refuses publishing to a workspace viewer without hiding the panel", async () => {
    state.shell = shell("viewer");
    await show();
    expect(button("Publish")?.disabled).toBe(true);
    expect(button("Publish")?.title).toContain("needs the editor role in Kepler Labs");
  });

  it("tells a non-owner what an owner would see, instead of an empty screen", async () => {
    state.detail = loaded(detail({ grants: undefined, invites: undefined, isOwner: false }));
    state.grants = idle();
    state.invites = idle();
    await show();
    const text = host.textContent ?? "";
    expect(text).toContain("Only an owner of Equipment requests can do this.");
    expect(button("Export JSON")?.disabled).toBe(true);
  });

  it("says recovery is an operator's job rather than offering a button", async () => {
    state.detail = loaded(
      detail({
        app: app({
          app: {
            state: "recovering",
            stateReason: "Restored from a backup on 7 September; two grants could not be confirmed.",
          },
        }),
      })
    );
    await show();
    const text = host.textContent ?? "";
    expect(text).toContain("In recovery");
    expect(text).toContain("two grants could not be confirmed");
    expect(text).toContain("Reopening it is an operator action");
    expect(button("Open app")?.disabled).toBe(true);
  });

  it("says the last backup is unknown rather than implying there is one", async () => {
    await show();
    expect(host.textContent).toContain("the server did not report a backup time");
  });
});
