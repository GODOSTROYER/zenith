import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoRefresh } from "@/app/(product)/platform/coding-agent/run-controls";
import { mount, rerender } from "../screens/platform/render";

const mocks = vi.hoisted(() => ({ api: vi.fn(), router: { refresh: vi.fn() } }));
vi.mock("@/lib/client/api", () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
const runs = [{ id: "run-a", status: "running", version: 1 }];
beforeEach(() => {
  vi.useFakeTimers(); mocks.api.mockReset().mockResolvedValue({ runs }); mocks.router.refresh.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const tick = (ms = 5_000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("analysis progress polling", () => {
  it("polls only selected metadata and refreshes the historical list once when a run stops", async () => {
    mount(<AutoRefresh workspaceId="ws-a" runs={runs} />);
    mocks.api.mockResolvedValueOnce({ runs: [{ ...runs[0], version: 2 }] });
    await tick();
    const [url, options] = mocks.api.mock.calls[0];
    expect(new URL(url, "https://zenith.test").searchParams.toString()).toBe("view=status&ids=run-a");
    expect(options.headers).toEqual({ "x-zenith-workspace": "ws-a" });
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    mocks.api.mockResolvedValueOnce({ runs: [{ ...runs[0], status: "completed", version: 3 }] });
    await tick(); await tick(20_000);
    expect(mocks.router.refresh).toHaveBeenCalledOnce();
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
  it("refreshes the single detail when its checkpoint version advances", async () => {
    mocks.api.mockResolvedValue({ runs: [{ ...runs[0], version: 2 }] });
    mount(<AutoRefresh workspaceId="ws-a" runs={runs} refreshOnProgress />);
    await tick(); expect(mocks.router.refresh).toHaveBeenCalledOnce();
  });
  it("pauses hidden tabs and never overlaps unresolved status requests", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    mocks.api.mockReturnValue(new Promise(() => {}));
    mount(<AutoRefresh workspaceId="ws-a" runs={runs} />);
    await tick(20_000); expect(mocks.api).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await tick(30_000); expect(mocks.api).toHaveBeenCalledOnce();
    expect(mocks.api.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("aborts a previous workspace request and ignores its late response", async () => {
    let finish!: (value: unknown) => void;
    mocks.api.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const el = mount(<AutoRefresh workspaceId="ws-a" runs={runs} />); await tick();
    const signal = mocks.api.mock.calls[0][1].signal;
    rerender(el, <AutoRefresh workspaceId="ws-b" runs={runs} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ runs: [] }); });
    expect(mocks.router.refresh).not.toHaveBeenCalled();
    await tick(); expect(mocks.api.mock.calls[1][1].headers["x-zenith-workspace"]).toBe("ws-b");
  });
});
