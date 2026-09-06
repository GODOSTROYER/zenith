import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const planAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/api", () => ({ planAction }));
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({ selectedEnvId: "production-env", deployments: [], environments: [{ id: "production-env", name: "Live", class: "production" }] }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
import { StepCard } from "@/components/navigator/step-card";
import type { AutonomyLevel } from "@/lib/domain/types";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks(); });
function render(environmentId?: string, needsApproval = true, autonomy: AutonomyLevel = "approve") {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<StepCard step={{ id: "step", seq: 1, title: "Scale web", rationale: "Requested", actionId: "service.scale", input: { serviceId: "web", environmentId }, risk: "medium", needsApproval, status: "proposed" }} projectId="project" slug="test" autonomy={autonomy} approved={false} onToggleApprove={() => {}} editable onPreview={() => {}} prodEnvIds={new Set(["production-env"])} earlierPending={false} />));
}
describe("Navigator step review", () => {
  it("marks explicitly scoped production steps", () => {
    render("production-env"); expect(host.textContent).toContain("Live · production");
  });
  it("does not relabel a project action as production based on the current environment", () => {
    render(); expect(host.textContent).toContain("Project scope");
    expect(host.textContent).not.toContain("Live · production");
  });
  it("distinguishes step eligibility from starting the approved run", () => {
    render(undefined, false);
    expect(host.textContent).toContain("No separate step approval is required.");
    expect(host.textContent).toContain("This step starts when you choose Run approved steps.");
    expect(host.textContent).not.toContain("runs without a separate approval");
  });
  it("keeps the autonomy restriction explicit when no separate step approval is needed", () => {
    render(undefined, false, "plan");
    expect(host.textContent).toContain("Autonomy is set to plan");
    expect(host.textContent).not.toContain("This step starts when");
  });
  it("retains a failed preview without retrying until requested", async () => {
    planAction.mockRejectedValue(new Error("Provider unavailable")); render();
    const preview = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Preview what"))!;
    await act(async () => { preview.click(); });
    expect(planAction).toHaveBeenCalledTimes(1);
    expect(planAction.mock.calls[0][1].scope.environmentId).toBe("production-env");
    expect(host.textContent).toContain("Provider unavailable");
    const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry preview")!;
    await act(async () => { retry.click(); });
    expect(planAction).toHaveBeenCalledTimes(2);
  });
});
