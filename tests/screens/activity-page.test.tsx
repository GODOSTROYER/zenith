import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/lib/domain/types";

const state = vi.hoisted(() => ({ error: undefined as unknown, refresh: vi.fn() }));
const event: AuditEvent = {
  id: "audit-1", projectId: "project-1", workspaceId: "workspace-1",
  ts: "2026-09-01T10:00:00.000Z", actionId: "system.addService",
  actor: { id: "user-1", name: "Ada", type: "user" },
  input: {}, result: "ok", summary: "Added api",
};
vi.mock("@/lib/client/api", () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(),
  useJson: () => ({ data: state.error ? undefined : { events: [event], nextCursor: "older" }, loading: false, error: state.error, refresh: state.refresh }),
}));
vi.mock("@/components/screens/project-data", () => ({
  useSelectedEnv: () => ({ projectId: "project-1", slug: "atlas", data: { environments: [] } }),
}));
vi.mock("@/app/(product)/p/[slug]/activity/activity-detail", () => ({ ActivityDetail: () => null }));
import ActivityPage from "@/app/(product)/p/[slug]/activity/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); state.error = undefined; vi.clearAllMocks(); });

function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<ActivityPage />));
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  return container;
}

describe("Activity recovery", () => {
  it("keeps older history reachable when the loaded search has no matches", () => {
    const container = renderPage();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search loaded actions"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "unmatched");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("Nothing loaded matches");
    expect(container.textContent).toContain("Load 50 older actions");
    expect(container.textContent).toContain("Clear search and dates");
  });

  it("shows failed history loading as unavailable with a retry, never as an empty trail", () => {
    state.error = new Error("Connection interrupted. Retry the request.");
    const container = renderPage();
    expect(container.textContent).toContain("The audit trail could not be loaded");
    expect(container.textContent).not.toContain("Nothing has happened yet");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry audit trail")!;
    act(() => retry.click());
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});
