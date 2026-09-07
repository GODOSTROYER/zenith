/**
 * A publish while it runs: phases in order, every reason on a failure, and no
 * claim that anything is live until the server has said `succeeded`.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ISO, job, loaded, release } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ job: undefined as unknown }));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  useHostedJob: () => state.job,
}));

import { JobProgress } from "@/components/apps/job-progress";

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];
const settled = vi.fn();
const retry = vi.fn();
const again = vi.fn();

const render = async () => {
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <JobProgress
          appId="app-1"
          jobId="job-1"
          appName="Equipment requests"
          url="http://equipment.apps.localhost/"
          activeRelease={release()}
          onSettled={settled}
          onRetry={retry}
          onPublishAgain={again}
          onOpen={() => {}}
        />
      </ToastProvider>
    )
  );
};

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  settled.mockClear();
  retry.mockClear();
  again.mockClear();
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

describe("Publish job panel", () => {
  it("lists every phase and marks the one the server is in", async () => {
    state.job = loaded({
      job: job({ status: "running", phase: "build" }),
      logs: [`${ISO} Running the pinned recipe.`],
    });
    await render();

    const text = host.textContent ?? "";
    for (const phase of [
      "Check the source",
      "Build",
      "Store the files",
      "Verify the files",
      "Stage the release",
      "Health checks",
      "Activate",
      "Clean up",
    ])
      expect(text).toContain(phase);
    expect(text).toContain("Running for");
    expect(text).toContain("Running the pinned recipe.");
    expect(host.querySelector('[aria-label="In progress"]')).not.toBeNull();
  });

  it("never says the app is live while the job is still running", async () => {
    state.job = loaded({ job: job({ status: "running", phase: "activate" }), logs: [] });
    await render();

    expect(host.textContent).not.toContain("is live");
    expect(host.textContent).not.toContain("http://equipment.apps.localhost/");
    expect(settled).not.toHaveBeenCalled();
  });

  it("shows the error and every reason behind a failure, and offers the same job again", async () => {
    state.job = loaded({
      job: job({
        status: "failed",
        phase: "intake",
        finishedAt: ISO,
        error: "The source was refused before anything ran.",
      }),
      logs: [
        `${ISO} source rejected: vite.config.ts is not supported: the platform supplies the build configuration.`,
        `${ISO} source rejected: package-lock.json is not supported: dependencies come from the pinned recipe.`,
        `${ISO} failed: The source was refused before anything ran.`,
      ],
    });
    await render();

    const text = host.textContent ?? "";
    expect(text).toContain("This publish failed");
    expect(text).toContain("The source was refused before anything ran.");
    expect(text).toContain("vite.config.ts is not supported");
    expect(text).toContain("package-lock.json is not supported");
    expect(text).toContain("Whatever was live before this publish is still live.");
    expect(text).toContain("Retry");
    expect(text).toContain("Publish again");
    expect(text).not.toContain("is live at");
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("shows the address only once the server reports success", async () => {
    state.job = loaded({
      job: job({ status: "succeeded", phase: "cleanup", finishedAt: ISO }),
      logs: [],
    });
    await render();

    const text = host.textContent ?? "";
    expect(text).toContain("Equipment requests is live");
    expect(text).toContain("Release 2 is live");
    expect(text).toContain("http://equipment.apps.localhost/");
    expect(text).toContain("Open app");
    expect(text).toContain("Took");
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
