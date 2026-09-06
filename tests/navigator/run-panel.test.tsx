import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({ project: { workingManifest: { services: [{ id: "svc-web", name: "web" }], resources: [] } }, environments: [{ id: "prod", name: "Live", class: "production" }], deployments: [{ id: "deployment", environmentId: "prod" }] }) }));
vi.mock("@/components/navigator/step-card", () => ({ StepCard: ({ step, onPreview, onInspect }: { step: { id: string }; onPreview: (id: string, cost: number) => void; onInspect: () => void }) => <li><button onClick={() => onPreview(step.id, 42)}>Preview</button><button onClick={onInspect}>Inspect</button></li> }));
vi.mock("@/components/ui/cost-delta", () => ({ CostDelta: ({ usd }: { usd: number }) => <span data-cost>{usd}</span> }));
vi.mock("@/components/screens/connected-detail", () => ({ ConnectedDetail: ({ open, children, environment }: { open: boolean; children: React.ReactNode; environment: string }) => open ? <aside data-detail>{environment}{children}</aside> : null }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
import { RunPanel } from "@/components/navigator/run-panel";
import type { NavigatorRun } from "@/lib/domain/types";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; });
function render(id: string, deploymentId?: string, status: NavigatorRun["status"] = "awaiting_approval") {
  if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  const run: NavigatorRun = { id, projectId: "project", goal: "Change the service", status, summary: status === "done" ? "The requested change completed." : undefined, createdAt: "2026-09-07T00:00:00Z", steps: [{ id: `step-${id}`, seq: 1, title: "Change web", rationale: "Requested", actionId: "ops.scaleService", input: { serviceId: "web" }, risk: "medium", needsApproval: true, status: "proposed", deploymentId }] };
  act(() => root!.render(<RunPanel run={run} projectId="project" slug="test" autonomy="approve" approvals={new Set()} onToggleApprove={() => {}} onRun={() => {}} running={false} onCancel={() => {}} cancelling={false} role="admin" onSuggest={() => {}} prodEnvIds={new Set(["prod"])} />));
}
describe("Navigator active plan", () => {
  it("does not carry preview estimates into the next plan", () => {
    render("one"); act(() => { [...host.querySelectorAll("button")].find(button => button.textContent === "Preview")!.click(); });
    expect(host.querySelector("[data-cost]")?.textContent).toBe("42");
    render("two"); expect(host.querySelector("[data-cost]")).toBeNull();
  });
  it("provides native navigation links after completion without nested controls", () => {
    render("complete", undefined, "done");
    expect(host.querySelector('a[href="/p/test"]')?.textContent).toBe("Open the System Map");
    expect(host.querySelector('a[href="/p/test/deploys"]')?.textContent).toBe("Deploys");
    expect(host.querySelector('a[href="/p/test/activity"]')?.textContent).toBe("Audit trail");
    expect(host.querySelector("a button")).toBeNull();
  });
  it("uses recorded deployment context in the connected inspector", () => {
    render("one", "deployment");
    act(() => { [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect")!.click(); });
    expect(host.querySelector("[data-detail]")?.textContent).toContain("Live · production");
    expect(host.querySelector('a[href="/p/test/deploys?deployment=deployment"]')).not.toBeNull();
    expect(host.querySelector('a[href="/p/test?select=svc-web"]')).not.toBeNull();
  });
});
