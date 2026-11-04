/** Page wiring uses explicit loader fakes; no live platform or cloud reads. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageContext } from "@/app/(product)/platform/_lib/loaders";
import type { AutonomyView } from "@/lib/capabilities/autonomy";
import EnvironmentPage from "@/app/(product)/platform/environments/[id]/page";
import { button, click, flush, mount, text, type } from "../screens/platform/render";

const state = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("@/app/(product)/platform/_lib/loaders", () => ({
  loadEnvironment: async () => state.value,
  one: (search: Record<string, unknown>, key: string) => typeof search[key] === "string" ? search[key] : undefined,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const fetchMock = vi.fn<typeof fetch>();
const context: PageContext = { workspaceId: "ws_1", principal: { kind: "user", id: "human", name: "Human" }, role: "admin", environments: [{ id: "env_prod", name: "Production", class: "production" }] };
const autonomy: AutonomyView = { workspaceId: "ws_1", environmentId: "env_prod", environmentClass: "production", level: 2, defaulted: false, defaultForClass: 2, version: 1, name: "Plan", summary: "Summary", unattended: "None", navigator: "approve" };
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (path, init) => {
    if (path === "/api/platform/v1/environments/env_prod/teardown-review" && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ review: null }), { status: 200 });
    }
    throw new Error("Unexpected request in environment-page test");
  });
  state.value = { context, data: { resources: { rows: [], evidence: "contract" }, drift: { report: null, truncated: false, evidence: "contract" }, autonomy } };
});
const page = () => EnvironmentPage({ params: Promise.resolve({ id: "env_prod" }), searchParams: Promise.resolve({}) });

describe("teardown environment-page wiring", () => {
  it("places teardown on the loaded environment and sends its actual id", async () => {
    const el = mount(await page()); await flush();
    expect(text(el)).toContain("Production"); expect(el.querySelector('section[aria-label="Environment teardown"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [reviewPath, reviewInit] = fetchMock.mock.calls[0];
    expect(reviewPath).toBe("/api/platform/v1/environments/env_prod/teardown-review");
    expect(reviewInit?.method ?? "GET").toBe("GET"); expect(reviewInit?.body).toBeUndefined();
    expect(reviewInit?.credentials).toBe("same-origin"); expect(reviewInit?.cache).toBe("no-store");
    const reviewHeaders = new Headers(reviewInit?.headers);
    expect(reviewHeaders.get("x-zenith-workspace")).toBe("ws_1");
    for (const header of ["authorization", "x-zenith-actor", "x-zenith-navigator"]) expect(reviewHeaders.has(header)).toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ plan: { summary: "Production teardown", details: ["Counts: 0 deletes.", "Stateful deletes: 0.", "Retained: 0."], warnings: [], risk: "high", costDeltaUsd: 0, requiresApproval: true } }), { status: 200 }));
    click(button(el, "Review teardown plan")); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [planPath, planInit] = fetchMock.mock.calls[1];
    expect(planPath).toBe("/api/actions/env.teardown"); expect(planInit?.method).toBe("POST");
    expect(JSON.parse(planInit!.body as string)).toEqual({ mode: "plan", input: { environmentId: "env_prod" }, scope: { environmentId: "env_prod" } });
    expect(text(el)).toContain("Type Production exactly");
    const confirmation = el.querySelector('section[aria-label="Environment teardown"] input') as HTMLInputElement;
    expect(button(el, "Request teardown for approval").disabled).toBe(true);
    for (const wrong of ["env_prod", "production", "Production "]) {
      type(confirmation, wrong); expect(button(el, "Request teardown for approval").disabled).toBe(true);
      click(button(el, "Request teardown for approval"));
    }
    type(confirmation, "Production"); expect(button(el, "Request teardown for approval").disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires the actual environment name when the title falls back to its id", async () => {
    state.value = { context: { ...context, environments: [] }, data: { resources: { rows: [], evidence: "contract" }, drift: { report: null, truncated: false, evidence: "contract" }, autonomy } };
    const el = mount(await page()); await flush(); expect(text(el)).toContain("env_prod");
    expect(text(el)).toContain("environment name is unavailable"); expect(button(el, "Review teardown plan").disabled).toBe(true);
  });

  it("keeps teardown absent when environment loading or authorization fails", async () => {
    state.value = { error: "Environment unavailable.", missing: true };
    const el = mount(await page()); expect(text(el)).toContain("Environment unavailable");
    expect(el.querySelector('section[aria-label="Environment teardown"]')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
