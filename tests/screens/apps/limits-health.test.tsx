/**
 * Limits say where they are enforced, and health says whether anyone actually
 * measured it. Both are the difference between a screen that informs and a
 * screen that reassures.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { DEFAULT_LIMITS } from "@/lib/hosted/contracts";
import { ToastProvider } from "@/components/ui/toast";
import { HealthPanel } from "@/app/(product)/apps/health-panel";
import { LimitsTable } from "@/app/(product)/apps/limits-table";
import { enforcement, health, usage } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

const show = async (node: ReactNode) => {
  await act(async () => root.render(<ToastProvider renderToaster={false}>{node}</ToastProvider>));
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

describe("Limits table", () => {
  it("says where each limit is applied, in the same three sentences", async () => {
    await show(<LimitsTable limits={DEFAULT_LIMITS} enforcement={enforcement} />);
    const text = host.textContent ?? "";
    expect(text).toContain("Enforced here");
    expect(text).toContain("Provider limit (Cloudflare) — not enforced on the local runtime");
    expect(text).toContain("Not enforced");
  });

  it("prefers the API's own wording when it sends it", async () => {
    await show(
      <LimitsTable
        limits={DEFAULT_LIMITS}
        enforcement={enforcement}
        labels={usage().enforcementLabels}
      />
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Enforced here by Zenith, and tested.");
    expect(text).toContain("Enforced by the provider (Cloudflare), not by Zenith.");
  });

  it("discloses that stored data is counted as logical bytes", async () => {
    await show(<LimitsTable limits={DEFAULT_LIMITS} enforcement={enforcement} />);
    expect(host.textContent).toContain(
      "logical bytes of the fields stored in this app's database, not the size of the file on disk"
    );
  });

  it("shows the contract's own numbers, not rounded guesses", async () => {
    await show(<LimitsTable limits={DEFAULT_LIMITS} enforcement={enforcement} />);
    const text = host.textContent ?? "";
    expect(text).toContain("10 000");
    expect(text).toContain("100 MB");
    expect(text).toContain("1.0 MB");
  });
});

describe("Health panel", () => {
  it("labels a measured result as measured and never as simulated", async () => {
    await show(<HealthPanel health={health({ simulated: false })} />);
    const text = host.textContent ?? "";
    expect(text).toContain("measured");
    expect(text).not.toContain("simulated");
    expect(text).toContain("Every check passed");
    expect(text).toContain("data can be opened and read");
  });

  it("labels a generated result as simulated", async () => {
    await show(<HealthPanel health={health({ simulated: true })} />);
    expect(host.textContent).toContain("simulated");
  });

  it("attributes the checks to the release that was serving", async () => {
    await show(<HealthPanel health={health()} />);
    const text = host.textContent ?? "";
    expect(text).toContain("These checks ran against release 2");
    expect(text).toContain("x-zenith-release");
  });

  it("says there is nothing to attribute when nothing is serving", async () => {
    await show(<HealthPanel health={health({ release: null })} />);
    expect(host.textContent).toContain("no release to attribute these results to");
  });

  it("reports what the app recorded as counts, not as invented log lines", async () => {
    await show(<HealthPanel health={health()} />);
    const text = host.textContent ?? "";
    expect(text).toContain("14 events since");
    expect(text).toContain("records written");
    expect(text).toContain("requests refused");
  });

  it("shows a failing check with what it found", async () => {
    await show(
      <HealthPanel
        health={health({
          ok: false,
          checks: [
            { id: "data_round_trip", ok: false, detail: "The write was refused: storage is full." },
          ],
        })}
      />
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Something is failing");
    expect(text).toContain("Data can be written and read back");
    expect(text).toContain("The write was refused: storage is full.");
  });

  it("says no check has run rather than showing a green tick", async () => {
    await show(<HealthPanel health={null} />);
    expect(host.textContent).toContain("No health check has run for this app yet");
  });
});
