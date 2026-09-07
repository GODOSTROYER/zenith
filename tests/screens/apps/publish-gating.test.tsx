/**
 * Publishing is refused for four different reasons and each one has to say
 * which it is — a builder who cannot publish should never have to guess whether
 * it is their role, the machine, the money or a job already running.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/ui/toast";
import { PublishPanel } from "@/components/apps/publish-panel";
import {
  publishBlockedReason,
  rollbackBlockedReason,
  stateChangeBlockedReason,
  type GateInput,
} from "@/components/apps/gating";
import { builder, release } from "./fixtures";

const base: GateInput = {
  appName: "Equipment requests",
  appState: "active",
  workspaceRole: "editor",
  workspaceName: "Kepler Labs",
  isOwner: true,
  runtime: { availability: { available: true } },
  builders: [builder()],
  buildsPaused: false,
  hasRunningJob: false,
};

const noise: string[] = [];
beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
});
afterEach(() => {
  expect(noise).toEqual([]);
  vi.restoreAllMocks();
});

describe("publish gating", () => {
  it("allows a workspace editor who owns the app", () => {
    expect(publishBlockedReason(base)).toBeUndefined();
    expect(rollbackBlockedReason(base)).toBeUndefined();
  });

  it("names the missing workspace role and where to fix it", () => {
    const reason = publishBlockedReason({ ...base, workspaceRole: "viewer" });
    expect(reason).toContain("needs the editor role in Kepler Labs");
    expect(reason).toContain("you are viewer");
    expect(reason).toContain("Settings → Members");
  });

  it("names the missing app role separately from the workspace role", () => {
    const reason = publishBlockedReason({ ...base, isOwner: false });
    expect(reason).toContain("owner role on Equipment requests");
    expect(reason).toContain("Audience");
  });

  it("repeats a runner's own reason when none of them can build", () => {
    const reason = publishBlockedReason({
      ...base,
      builders: [
        builder({
          availability: {
            available: false,
            reason: "ZENITH_BUILD_RUNNER is none, so no build may run on this install.",
          },
        }),
      ],
    });
    expect(reason).toContain("No build runner on this install can run right now");
    expect(reason).toContain("ZENITH_BUILD_RUNNER is none");
  });

  it("does not refuse while at least one runner can run, because the server picks", () => {
    expect(
      publishBlockedReason({
        ...base,
        builders: [
          builder({ id: "docker", availability: { available: false, reason: "No daemon." } }),
          builder({ id: "recipe-local", availability: { available: true } }),
        ],
      })
    ).toBeUndefined();
  });

  it("says builds are paused rather than blaming the source", () => {
    expect(publishBlockedReason({ ...base, buildsPaused: true })).toContain("Builds are paused");
  });

  it("refuses a second publish while one is running, and says to wait", () => {
    expect(publishBlockedReason({ ...base, hasRunningJob: true })).toContain(
      "already running for this app"
    );
  });

  it("blocks a suspended app before anything else", () => {
    const reason = publishBlockedReason({ ...base, appState: "suspended", buildsPaused: true });
    expect(reason).toContain("is suspended");
  });

  it("does not need a build runner to roll back, because the release is already built", () => {
    const input = {
      ...base,
      builders: [builder({ availability: { available: false, reason: "No build runner is configured." } })],
    };
    expect(publishBlockedReason(input)).toContain("No build runner on this install can run");
    expect(rollbackBlockedReason(input)).toBeUndefined();
  });

  it("needs workspace admin as well as app owner to suspend", () => {
    expect(stateChangeBlockedReason({ ...base, isOwner: false })).toContain("owner role on it");
    expect(stateChangeBlockedReason(base)).toContain("admin role in Kepler Labs");
    expect(stateChangeBlockedReason({ ...base, workspaceRole: "admin" })).toBeUndefined();
  });
});

describe("Publish panel", () => {
  const render = (blockedReason?: string) =>
    renderToStaticMarkup(
      <ToastProvider renderToaster={false}>
        <PublishPanel
          appId="app-1"
          appName="Equipment requests"
          url="http://equipment.apps.localhost/"
          activeRelease={release()}
          blockedReason={blockedReason}
          runningJobId={null}
          onChanged={() => {}}
          onOpen={() => {}}
        />
      </ToastProvider>
    );

  it("summarises the supported-source rules next to the upload option", () => {
    const markup = render();
    expect(markup).toContain("Equipment requests — reference app");
    expect(markup).toContain("Minimal app");
    expect(markup).toContain("Your own app, as a .tar.gz");
    expect(markup).toContain("unpack to no more than 20 MB");
    expect(markup).toContain("nothing inside it is ever run to build it");
  });

  it("will not publish until a source is chosen, and says so on the button", () => {
    const markup = render();
    expect(markup).toContain("Choose what to publish first.");
    expect(markup).toContain('disabled=""');
  });

  it("carries the screen's refusal onto the button instead of hiding it", () => {
    const markup = render("Builds are paused because Kepler Labs reached its spending envelope.");
    expect(markup).toContain("Builds are paused because Kepler Labs reached its spending envelope.");
  });
});
