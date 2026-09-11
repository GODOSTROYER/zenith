/**
 * Releases: what each version's health check found, and when rolling back is
 * offered — a release that never passed cannot be made live, and the button
 * says that instead of failing on the server.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ReleasesTable } from "@/app/(product)/apps/releases-table";
import { ISO, release } from "./fixtures";
import type { Release } from "@/lib/hosted/contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

const rollbackButtons = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.includes("Roll back"));

const show = async (releases: Release[], reason?: string) => {
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <ReleasesTable
          appId="app-1"
          appName="Equipment requests"
          releases={releases}
          activeReleaseId="rel-2"
          rollbackDisabledReason={reason}
          onChanged={() => {}}
        />
      </ToastProvider>
    )
  );
};

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
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

describe("Releases", () => {
  it("shows the live release with its checks and a shortened fingerprint", async () => {
    await show([release()]);
    const text = host.textContent ?? "";
    expect(text).toContain("Live");
    expect(text).toContain("1 of 1 checks passed");
    expect(text).toContain("3f2a3f2a3f2a");
    expect(rollbackButtons()[0].disabled).toBe(true);
    expect(rollbackButtons()[0].title).toContain("already live");
  });

  it("shows the checks a failed release did not pass, and refuses to make it live", async () => {
    await show([
      release({
        id: "rel-3",
        number: 3,
        status: "failed",
        activatedAt: undefined,
        error: "The candidate never became healthy.",
        probe: {
          ok: false,
          checkedAt: ISO,
          checks: [
            { id: "index_fetch", ok: true, detail: "The first page loaded." },
            { id: "data_round_trip", ok: false, detail: "The test database refused the write." },
          ],
          testDatabase: "candidate-test.sqlite",
        },
      }),
      release(),
    ]);
    const text = host.textContent ?? "";
    expect(text).toContain("1 of 2 checks failed");
    expect(text).toContain("The test database refused the write.");
    expect(text).toContain("The candidate never became healthy.");
    expect(rollbackButtons()[0].disabled).toBe(true);
    expect(rollbackButtons()[0].title).toContain("never passed its health checks");
  });

  it("offers a rollback for a superseded release", async () => {
    await show([release({ id: "rel-1", number: 1, status: "superseded", activatedAt: undefined })]);
    expect(host.textContent).toContain("Replaced");
    expect(rollbackButtons()[0].disabled).toBe(false);
  });

  it("carries the screen's own refusal onto every row", async () => {
    await show(
      [release({ id: "rel-1", number: 1, status: "superseded" })],
      "Publishing needs the owner role on Equipment requests."
    );
    expect(rollbackButtons()[0].disabled).toBe(true);
    expect(rollbackButtons()[0].title).toContain("owner role on Equipment requests");
  });

  it("says the first publish creates release 1 instead of showing an empty table", async () => {
    await show([]);
    expect(host.textContent).toContain("The first publish creates release 1");
  });
});
