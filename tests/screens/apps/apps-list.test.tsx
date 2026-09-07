/**
 * The Apps list: what a card is allowed to claim, and what the banner above it
 * has to repeat word for word from the API.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { app, builder, job, listPayload, loaded, runtime, shell } from "./fixtures";

const state = vi.hoisted(() => ({
  apps: undefined as unknown,
  shell: undefined as unknown,
}));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  useHostedApps: () => state.apps,
  launchHostedApp: vi.fn(),
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import AppsPage from "@/app/(product)/apps/page";

const render = () =>
  renderToStaticMarkup(
    <ToastProvider renderToaster={false}>
      <AppsPage />
    </ToastProvider>
  );

const noise: string[] = [];
beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  state.apps = loaded(listPayload());
  state.shell = shell("editor");
});
afterEach(() => {
  expect(noise).toEqual([]);
  vi.restoreAllMocks();
});

describe("Apps list", () => {
  it("renders a card from the payload without inventing anything", () => {
    const markup = render();
    expect(markup).toContain("Equipment requests");
    expect(markup).toContain("http://equipment.apps.localhost/");
    expect(markup).toContain("Release 2");
    expect(markup).toContain("1 person can open it");
    expect(markup).toContain("1 invited");
    expect(markup).toContain("New app");
    expect(markup).toContain('href="/apps/new"');
  });

  it("shows the runtime label and the build runner's own boundary sentence", () => {
    const markup = render();
    expect(markup).toContain("Local runtime — this control process serves the app from this machine.");
    expect(markup).toContain("Recipe runner on this machine");
    expect(markup).toContain("It is not a sandbox for hostile code.");
  });

  it("names the reason and the fix when the runtime is blocked", () => {
    state.apps = loaded(
      listPayload({
        runtime: runtime({
          availability: {
            available: false,
            reason: "ZENITH_CF_ACCOUNT_ID is not set, so the Cloudflare runtime cannot be reached.",
            fix: "Set ZENITH_CF_ACCOUNT_ID and ZENITH_CF_API_TOKEN, then restart the control service.",
          },
        }),
      })
    );
    const markup = render();
    expect(markup).toContain("Apps cannot be served right now");
    expect(markup).toContain("ZENITH_CF_ACCOUNT_ID is not set");
    expect(markup).toContain("then restart the control service.");
  });

  it("says why nothing can be built when no runner can run", () => {
    state.apps = loaded(
      listPayload({
        builders: [
          builder({
            id: "docker",
            label: "Docker container",
            availability: {
              available: false,
              reason: "No Docker daemon answered on this host.",
            },
          }),
        ],
      })
    );
    const markup = render();
    expect(markup).toContain("Nothing can be built here right now");
    expect(markup).toContain("No Docker daemon answered on this host.");
  });

  it("shows a running publish on the card it belongs to", () => {
    state.apps = loaded(listPayload({ apps: [app({ runningJob: job({ phase: "probe" }) })] }));
    const markup = render();
    expect(markup).toContain("Publishing");
    expect(markup).toContain("Health checks");
  });

  it("offers the same first step from the empty state", () => {
    state.apps = loaded(listPayload({ apps: [] }));
    const markup = render();
    expect(markup).toContain("No apps yet");
    expect(markup).toContain("Create an app");
  });

  it("disables creating an app for a workspace viewer and says who to ask", () => {
    state.shell = shell("viewer");
    const markup = render();
    expect(markup).toContain("Creating an app needs the editor role in Kepler Labs");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('href="/apps/new"');
  });

  it("shows the address the server gave, never one this screen assembled", () => {
    state.apps = loaded(
      listPayload({
        apps: [app({ hostname: "field.example.test", origin: "https://field.example.test" })],
      })
    );
    const markup = render();
    expect(markup).toContain("https://field.example.test/");
    expect(markup).not.toContain("apps.localhost");
  });
});
