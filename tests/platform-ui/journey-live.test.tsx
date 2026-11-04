/** Live progress, replan notice, uncertainty and runbook actions in jsdom. HTTP replies are test fakes, not live API evidence. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { button, click, describedBy, flush, headingsDoNotSkip, mount, text } from "../screens/platform/render";
import { JourneyLive, readJourney } from "@/app/(product)/platform/_components/journey-live";
import { RunActions } from "@/app/(product)/platform/runbooks/runs/[id]/run-actions";
import { ScheduleActions } from "@/app/(product)/platform/runbooks/schedule-actions";
import { OwnershipTransferReview } from "@/components/platform/ownership-transfer-review";
import { JourneyPanel } from "@/components/platform/journey-panel";
import { ownershipTransferRows, projectPlatformOperation, projectRunbookRun } from "@/lib/platform/operator-journey";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/platform" }));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); router.refresh.mockReset(); vi.stubGlobal("fetch", fetchMock); });
const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const op = (status: string, planDigest = D1) => ({ operation: { id: "op_1", status, planDigest, proposalDigest: D2 } });

describe("readJourney", () => {
  it("projects an operation read with the workspace header and no body", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply(op("uncertain")));
    const view = await readJourney("ws_1", { kind: "platform_operation", operationId: "op_1" });
    expect(view.stage).toBe("uncertain");
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe("/api/platform/v1/operations/op_1");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("x-zenith-workspace")).toBe("ws_1");
  });
  it("lets the linked operation win for a workflow deployment and falls back when it cannot be read", async () => {
    const dep = { deployment: { id: "dep_1", status: "failed", executor: "workflow", operationId: "op_1", steps: [] } };
    fetchMock.mockResolvedValueOnce(jsonReply(dep)).mockResolvedValueOnce(jsonReply(op("uncertain")));
    expect((await readJourney("ws_1", { kind: "legacy_deployment", deploymentId: "dep_1", operationId: "op_1" })).stage).toBe("uncertain");
    fetchMock.mockResolvedValueOnce(jsonReply(dep)).mockResolvedValueOnce(jsonReply({ error: { message: "no" } }, 404));
    expect((await readJourney("ws_1", { kind: "legacy_deployment", deploymentId: "dep_1", operationId: "op_1" })).stage).toBe("failed");
  });
  it("projects a runbook run with step titles", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ run: { id: "run_1", status: "running", bindingDigest: D1 }, steps: [{ targetIndex: 0, stepId: "s", status: "started" }] }));
    const view = await readJourney("ws_1", { kind: "runbook_run", runId: "run_1", stepTitles: { s: "Restart" } });
    expect(view.steps[0]?.title).toContain("Restart");
    expect(view.steps[0]?.state).toBe("running");
  });
  it("refuses a path outside the platform read endpoints", async () => {
    const { browserRead } = await import("@/app/(product)/platform/_lib/browser-api");
    expect(() => browserRead("ws_1", "https://evil.test/x")).toThrow();
    expect(() => browserRead("ws_1", "/api/secrets")).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JourneyLive", () => {
  const initial = projectPlatformOperation({ id: "op_1", status: "running", planDigest: D1 });
  it("announces a change once in the polite live region and shows uncertainty with next steps", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply(op("uncertain")));
    const el = mount(<JourneyLive workspaceId="ws_1" target={{ kind: "platform_operation", operationId: "op_1" }} initial={initial} pollMs={3_600_000} />);
    const live = el.querySelector('[data-testid="journey-live"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain("Running");
    click(button(el, "Refresh")); await flush(); await flush();
    expect(el.querySelector('[data-testid="journey-live"]')!.textContent).toContain("Outcome uncertain");
    expect(text(el)).toContain("do not assume it failed or succeeded");
    expect(text(el)).toContain("Do not retry yet");
    expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("raises a reapproval alert and moves focus to it when the plan digest changes", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply(op("awaiting_approval", D2)));
    const el = mount(<JourneyLive workspaceId="ws_1" target={{ kind: "platform_operation", operationId: "op_1" }} initial={projectPlatformOperation({ id: "op_1", status: "awaiting_approval", planDigest: D1 })} pollMs={3_600_000} />);
    click(button(el, "Refresh")); await flush(); await flush();
    expect(text(el)).toContain("Plan changed: approval is required again");
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.activeElement?.contains(el.querySelector('[role="alert"]'))).toBe(true);
    expect(router.refresh).toHaveBeenCalled();
    click(button(el, "I have reviewed the updated plan")); await flush();
    expect(text(el)).not.toContain("Plan changed");
  });
  it("keeps the last known state and says live updates paused after repeated failures", async () => {
    fetchMock.mockResolvedValue(jsonReply({ error: { message: "x" } }, 500));
    const el = mount(<JourneyLive workspaceId="ws_1" target={{ kind: "platform_operation", operationId: "op_1" }} initial={initial} pollMs={3_600_000} />);
    click(button(el, "Refresh")); await flush(); await flush();
    expect(text(el)).not.toContain("Live updates paused");
    click(button(el, "Refresh")); await flush(); await flush();
    expect(text(el)).toContain("Live updates paused");
    expect(el.querySelector('[data-testid="journey-live"]')!.textContent).toContain("Running");
  });
  it("polls on its interval while in progress and stops once the journey is terminal", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonReply(op("succeeded")));
      const el = mount(<JourneyLive workspaceId="ws_1" target={{ kind: "platform_operation", operationId: "op_1" }} initial={initial} pollMs={1000} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(el.querySelector('[data-testid="journey-live"]')!.textContent).toContain("Succeeded");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("JourneyPanel semantics", () => {
  it("labels the region, prints state words beside glyphs and keeps headings in order", () => {
    const view = projectRunbookRun({ id: "r", status: "failed", bindingDigest: D1 }, [{ targetIndex: 0, stepId: "a", status: "failed", errorCode: "E_X" }]);
    const el = mount(<JourneyPanel view={view} />);
    const region = el.querySelector("section")!;
    expect(region.getAttribute("aria-labelledby")).toBeTruthy();
    expect(text(el)).toContain("Failed");
    expect(el.querySelector('ol[aria-label="Steps"]')).not.toBeNull();
    expect(headingsDoNotSkip(el)).toBe(true);
  });
});

describe("runbook decisions", () => {
  it("approves with the reviewed binding digest and confirms through a focused status message", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ run: {} }));
    const el = mount(<RunActions workspaceId="ws_1" runId="run_1" bindingDigest={D1} approve={{ eligible: true }} cancel={{ available: true }} />);
    click(button(el, "Approve this run")); await flush(); await flush();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(String(path)).toBe("/api/platform/v1/runbooks/runs/run_1/approve");
    expect(JSON.parse(String(init?.body))).toEqual({ bindingDigest: D1 });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    expect(button(el, "Approve this run").disabled).toBe(true);
  });
  it("never leaves a dead control: a requester sees why approve is disabled and no request is sent", () => {
    const el = mount(<RunActions workspaceId="ws_1" runId="run_1" bindingDigest={D1} approve={{ eligible: false, reason: "You requested this run, so someone else must approve it." }} cancel={{ available: true }} />);
    const approve = button(el, "Approve this run");
    expect(approve.disabled).toBe(true);
    expect(describedBy(approve)).toContain("someone else must approve");
    click(approve);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancels through the cancel route and surfaces a fixed error on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ error: { message: "internal host detail" } }, 500));
    const el = mount(<RunActions workspaceId="ws_1" runId="run_1" bindingDigest={D1} approve={{ eligible: false, reason: "n/a" }} cancel={{ available: true }} />);
    click(button(el, "Cancel run")); await flush(); await flush();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/platform/v1/runbooks/runs/run_1/cancel");
    expect(text(el)).toContain("could not be confirmed");
    expect(text(el)).not.toContain("internal host detail");
  });
  it("approves a schedule only for the digest shown and explains why when not allowed", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ schedule: {} }));
    const ok = mount(<ScheduleActions workspaceId="ws_1" scheduleId="sch_1" bindingDigest={D2} status="pending_approval" canApprove />);
    click(button(ok, "Approve schedule")); await flush(); await flush();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ bindingDigest: D2 });
    const no = mount(<ScheduleActions workspaceId="ws_1" scheduleId="sch_2" bindingDigest={D2} status="pending_approval" canApprove={false} />);
    expect(button(no, "Approve schedule").disabled).toBe(true);
    expect(text(no)).toContain("did not create");
  });
});

describe("ownership transfer approvals", () => {
  it("shows every exact transfer, the bound proposal digest and an accessible table", () => {
    const rows = ownershipTransferRows({ broker: { ownershipTransfers: [{ address: "aws_ecs_service.web", resourceType: "aws:ecs_service", path: "desired_count", from: "autoscaler", to: "native-op", digest: D1 }] } });
    const el = mount(<OwnershipTransferReview transfers={rows} warnings={["The next apply may revert it."]} proposalDigest={D2} />);
    expect(text(el)).toContain("transfers write ownership");
    expect(text(el)).toContain("aws_ecs_service.web");
    expect(text(el)).toContain("desired_count");
    expect(text(el)).toContain("The next apply may revert it.");
    expect(el.querySelector("table caption")).not.toBeNull();
    expect(el.querySelectorAll('th[scope="col"]').length).toBe(5);
    expect(headingsDoNotSkip(el)).toBe(true);
  });
  it("renders nothing when the proposal has no ownership content", () => {
    expect(mount(<OwnershipTransferReview transfers={[]} proposalDigest={D2} />).innerHTML).toBe("");
  });
});
