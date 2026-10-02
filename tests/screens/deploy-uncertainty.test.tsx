/** The actual progress panel must show inspection guidance without inventing a terminal outcome. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/domain/types";
import { DeploymentView } from "@/components/deploy/live-progress";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ deployment: undefined as Deployment | undefined, refresh: vi.fn() }));
vi.mock("@/lib/client/api", () => ({
  useJson: () => ({ data: { deployment: state.deployment }, refresh: state.refresh }),
  useEventStream: () => ({ connected: true }),
}));
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({
  project: { id: "project-1" }, environments: [{ id: "env-1", name: "Staging", class: "staging", connectionId: "connection-1" }], revisions: [],
}) }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ boot: { role: "admin", connections: [{ id: "connection-1", provider: "aws" }] }, catalog: [] }),
  requiredRoleOf: () => "admin",
}));
vi.mock("@/components/inspector/plan-first", () => ({ PlanFirst: ({ label }: { label: string }) => <button>{label}</button> }));
vi.mock("@/components/deploy/success-panel", () => ({ SuccessPanel: ({ deployment }: { deployment: Deployment }) => <p>Confirmed {deployment.status}</p> }));

const warning = "Workflow start could not be confirmed; it may already be running. Inspect the platform operation before retrying or proposing another change.";
const sample = (over: Partial<Deployment> = {}): Deployment => ({
  id: "deployment-1", projectId: "project-1", environmentId: "env-1", revisionId: "revision-1", operationId: "operation-1", executor: "workflow",
  status: "applying", error: warning, steps: [{ id: "step-plan", seq: 0, phase: "prepare", title: "Plan", targetId: "web", status: "running" }],
  outputs: [], changeSummary: "Deploy the reviewed revision", estCostDeltaUsd: 0,
  actor: { type: "user", id: "admin-1", name: "Admin" }, createdAt: "2026-10-02T00:00:00.000Z", ...over,
});
let root: Root;
let host: HTMLDivElement;
const live = vi.fn<(ids: string[]) => void>();
const succeeded = vi.fn<(id: string) => void>();
const noise: string[] = [];
const render = async () => act(async () => root.render(<DeploymentView deploymentId="deployment-1" onLiveTargets={live} onSwitch={() => {}} onAddRoute={() => {}} onSucceeded={succeeded} onRetry={() => {}} />));

beforeEach(() => {
  state.deployment = sample(); vi.clearAllMocks(); noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => { noise.push(String(args[0])); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); expect(noise).toEqual([]); vi.restoreAllMocks(); });

describe("deployment inspection", () => {
  it.each(["planning", "awaiting_approval", "applying", "verifying", "rolling_back"] as const)("shows an accessible warning for retained %s without claiming progress or offering another change", async (status) => {
    state.deployment = sample({ status }); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(warning);
    expect(host.querySelector("h2")?.textContent).toContain("Deployment needs attention");
    expect(host.textContent).not.toContain("Nothing has been applied yet");
    expect(host.textContent).not.toContain("Applying the plan.");
    expect(host.textContent).not.toContain("Stopped at");
    expect(host.querySelector(".status-pulse")).toBeNull();
    expect(host.querySelector('[aria-label="In progress"]')).toBeNull();
    expect(host.textContent).toContain("Last reported: running");
    expect(state.deployment.steps[0].status).toBe("running");
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')?.textContent).toBe("Inspect platform operation");
    expect([...host.querySelectorAll("button")].some((button) => /Approve|Retry|Roll back|Cancel deployment/.test(button.textContent ?? ""))).toBe(false);
    expect(live).toHaveBeenLastCalledWith([]); expect(succeeded).not.toHaveBeenCalled();
  });

  it("keeps inspection guidance without inventing a link when there is no operation id", async () => {
    state.deployment = sample({ operationId: undefined }); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(warning);
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("displays another nonterminal notice without relabeling it as uncertainty or definitive failure", async () => {
    state.deployment = sample({ error: "A provider output is temporarily unavailable." }); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("A provider output is temporarily unavailable.");
    expect(host.textContent).not.toContain("uncertain"); expect(host.textContent).not.toContain("Stopped at");
  });

  it("shows confirmed late success and removes the obsolete inspection warning", async () => {
    await render();
    state.deployment = sample({ status: "succeeded", error: undefined, steps: [], endedAt: "2026-10-02T00:01:00.000Z" });
    await render();
    expect(host.textContent).toContain("Confirmed succeeded");
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).not.toContain(warning);
    expect(succeeded).toHaveBeenCalledExactlyOnceWith("deployment-1");
  });

  it("preserves a confirmed failed outcome and its actual error", async () => {
    state.deployment = sample({ status: "failed", error: "Provider rejected the apply before changing anything.", steps: [] });
    await render();
    expect(host.textContent).toContain("Stopped at"); expect(host.textContent).toContain("Provider rejected the apply before changing anything.");
    expect(host.textContent).not.toContain("Deployment needs attention");
  });

  it("keeps ordinary progress and cancellation controls when there is no inspection notice", async () => {
    state.deployment = sample({ error: undefined }); await render();
    expect(host.querySelector("h2")?.textContent).toContain("Deploying to Staging");
    expect(host.textContent).toContain("Applying the plan.");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Cancel deployment")).toBe(true);
    expect(live).toHaveBeenLastCalledWith(["web"]);
    expect(host.querySelector(".status-pulse")).not.toBeNull();
  });
});
