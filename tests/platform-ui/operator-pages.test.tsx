/** Operator journey pages with explicit loader fakes: states, approval binding and accessibility structure, not live API evidence. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { button, describedBy, headingsDoNotSkip, mount, text } from "../screens/platform/render";
import type { PageContext } from "@/app/(product)/platform/_lib/loaders";
import RunbooksPage from "@/app/(product)/platform/runbooks/page";
import RunbookRunPage from "@/app/(product)/platform/runbooks/runs/[id]/page";
import ReadinessPage from "@/app/(product)/platform/readiness/page";
import DeploymentPage from "@/app/(product)/platform/deployments/[id]/page";
import OperationPage from "@/app/(product)/platform/operations/[id]/page";
import { decision, operation } from "../screens/platform/fixtures";

const state = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("@/app/(product)/platform/_lib/loaders", () => ({
  loadRunbooks: async () => state.value, loadRunbookRun: async () => state.value, loadReadiness: async () => state.value,
  loadDeployment: async () => state.value, loadOperation: async () => state.value,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/platform" }));
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const context = (role: PageContext["role"], id = "approver"): PageContext => ({ workspaceId: "ws_1", principal: { kind: "user", id, name: "Person" }, role, environments: [] });
const params = Promise.resolve({ id: "run_1" });
beforeEach(() => { state.value = { error: "Platform store unavailable." }; });

const runData = (over: Record<string, unknown> = {}) => ({
  run: { id: "run_1", runbookId: "restart-web", version: 2, status: "pending_approval", definitionDigest: D1, bindingDigest: D2, createdAt: "2026-10-05T00:00:00Z", deadlineAt: "2026-10-05T01:00:00Z", maxParallelTargets: 2, requester: { id: "requester", name: "Requester", kind: "user" }, ...over },
  name: "Restart web", targets: [{ transport: "zenithd", resourceId: "res_1", targetId: "machine_1" }],
  steps: [{ targetIndex: 0, stepId: "restart", status: "uncertain" }],
  diff: [{ id: "restart", kind: "changed", fields: ["args"], step: { id: "restart", title: "Restart", operation: "service.restart", args: { unit: "api" }, timeoutSec: 60, onFailure: "abort" } },
    { id: "shell", kind: "added", fields: [], step: { id: "shell", title: "Run script", operation: "machine.exec", args: { argv: ["true"] }, timeoutSec: 30, onFailure: "abort" } }],
  hasPrevious: true,
  classification: { risk: "critical", escapeHatchSteps: ["shell"], mutatingSteps: ["restart"], capabilities: [], requiresApproval: true, argvClassification: "never_classified_safe" },
  audit: [{ seq: 1, event: "run.requested", actor: "Requester", createdAt: "2026-10-05T00:00:00Z" }],
});

describe("operator pages state handling", () => {
  it.each([
    ["runbooks", () => RunbooksPage()],
    ["runbook run", () => RunbookRunPage({ params })],
    ["readiness", () => ReadinessPage({ searchParams: Promise.resolve({}) })],
    ["deployment", () => DeploymentPage({ params })],
  ])("%s renders a loader error without a blank page", async (_name, render) => {
    const el = mount(await render());
    expect(text(el)).toContain("Could not load platform");
    expect(text(el)).toContain("Platform store unavailable");
  });
});

describe("runbook run page", () => {
  it("shows the exact effect diff, the bound digest, the raw-exec warning and an uncertain outcome with next steps", async () => {
    state.value = { context: context("admin"), data: runData({ status: "uncertain" }) };
    const el = mount(await RunbookRunPage({ params }));
    expect(text(el)).toContain("Exact effect");
    expect(text(el)).toContain("Changed");
    expect(text(el)).toContain("Added");
    expect(text(el)).toContain("machine.exec");
    expect(text(el)).toContain("never a sandbox");
    expect(text(el)).toContain("Outcome uncertain");
    expect(text(el)).toContain("Do not re-run this runbook yet");
    expect(text(el)).toContain("Compared with version 1");
    expect(headingsDoNotSkip(el)).toBe(true);
    expect(el.querySelectorAll("section[aria-labelledby]").length).toBeGreaterThanOrEqual(3);
    expect(el.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
  });
  it("lets an independent admin approve and keeps the requester out with the reason on the control", async () => {
    state.value = { context: context("admin", "approver"), data: runData() };
    expect(button(mount(await RunbookRunPage({ params })), "Approve this run").disabled).toBe(false);
    state.value = { context: context("admin", "requester"), data: runData() };
    const blocked = mount(await RunbookRunPage({ params }));
    const approve = button(blocked, "Approve this run");
    expect(approve.disabled).toBe(true);
    expect(describedBy(approve)).toContain("someone else must approve");
  });
  it("does not offer approval to an editor or after the run started", async () => {
    state.value = { context: context("editor"), data: runData() };
    expect(button(mount(await RunbookRunPage({ params })), "Approve this run").disabled).toBe(true);
    state.value = { context: context("admin"), data: runData({ status: "running" }) };
    expect(button(mount(await RunbookRunPage({ params })), "Approve this run").disabled).toBe(true);
  });
});

describe("runbooks list page", () => {
  it("renders empty states for runs, schedules and runbooks", async () => {
    state.value = { context: context("admin"), data: { runbooks: [], runs: [], schedules: [] } };
    const el = mount(await RunbooksPage());
    expect(text(el)).toContain("No runs yet");
    expect(text(el)).toContain("No schedules");
    expect(text(el)).toContain("No runbooks are published");
    expect(headingsDoNotSkip(el)).toBe(true);
  });
  it("lists a pending schedule with its bounds and a disabled approve for its creator", async () => {
    state.value = { context: context("admin", "creator"), data: { runbooks: [], runs: [], schedules: [{ id: "sch_1", runbookId: "restart-web", version: 2, status: "pending_approval", nextDueAt: null, bindingDigest: D2, targetCount: 1, createdBy: "Creator", creatorId: "creator", lines: ["Runs once at 2026-10-06T00:00:00Z (UTC)."] }] } };
    const el = mount(await RunbooksPage());
    expect(text(el)).toContain("Runs once at");
    expect(button(el, "Approve schedule").disabled).toBe(true);
  });
});

describe("readiness page", () => {
  const readiness = { provider: "aws", ready: false, checkedAt: "2026-10-05T00:00:00Z", checks: [{ id: "temporal", ok: false, detail: "Temporal did not answer.", fix: "Start Temporal." }, { id: "provider", ok: true, detail: "Routable.", fix: "Nothing to do." }] };
  it("prints a text result per check and does not claim the install deploys", async () => {
    state.value = { context: context("admin"), data: { providers: ["aws", "gcp"], selected: "aws", visible: true, readiness } };
    const el = mount(await ReadinessPage({ searchParams: Promise.resolve({}) }));
    expect(text(el)).toContain("Missing");
    expect(text(el)).toContain("Passed");
    expect(text(el)).toContain("Start Temporal.");
    expect(text(el)).toContain("Preview");
    expect(text(el)).toContain("not proof of a working deploy");
    expect(el.querySelector("table caption")).not.toBeNull();
    expect(el.querySelector('a[href="/platform/connections"]')).not.toBeNull();
  });
  it("hides install configuration from a viewer", async () => {
    state.value = { context: context("viewer"), data: { providers: ["aws"], selected: "aws", visible: false } };
    const el = mount(await ReadinessPage({ searchParams: Promise.resolve({}) }));
    expect(text(el)).toContain("shown to editors and admins");
    expect(text(el)).not.toContain("Temporal");
  });
});

describe("legacy deployment page", () => {
  it("projects through the same vocabulary and links to the operation", async () => {
    state.value = { context: context("viewer"), data: { deployment: { id: "dep_1", status: "applying", executor: "workflow", operationId: "op_1", createdAt: "2026-10-05T00:00:00Z", changeSummary: "Add web", steps: [{ id: "s1", seq: 1, title: "Apply plan", status: "running" }] }, linked: { id: "op_1", status: "uncertain", planDigest: D1 } } };
    const el = mount(await DeploymentPage({ params: Promise.resolve({ id: "dep_1" }) }));
    expect(text(el)).toContain("Outcome uncertain");
    expect(text(el)).toContain("Apply plan");
    expect(el.querySelector('a[href="/platform/operations/op_1"]')).not.toBeNull();
  });
});

describe("operation page journey wiring", () => {
  it("shows ownership transfers before the approval card and a deployment link when one projects it", async () => {
    const proposal = { ...operation().proposal, broker: { v: 1, risk: "high", ownershipTransfers: [{ address: "aws_ecs_service.web", resourceType: "aws:ecs_service", path: "desired_count", from: "autoscaler", to: "native-op", digest: D1 }] } };
    const op = { ...operation({ planDigest: undefined, proposal: { ...proposal, planDigest: undefined } as never }), approvalRound: 0 };
    state.value = { context: context("admin"), data: { operation: op, decision: decision(), approvals: [], events: [], timelineTruncated: false, linkedDeploymentId: "dep_9" } };
    const el = mount(await OperationPage({ params: Promise.resolve({ id: op.id }) }));
    const html = el.innerHTML;
    expect(text(el)).toContain("Field ownership");
    expect(text(el)).toContain("desired_count");
    expect(html.indexOf("Field ownership")).toBeLessThan(html.indexOf("Approve"));
    expect(el.querySelector('a[href="/platform/deployments/dep_9"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="journey-live"]')).not.toBeNull();
  });
});
