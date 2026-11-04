/** Actual product components over modeled read results; browser identity and native SQL are separate gates. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/domain/types";
import type { OperationDetail } from "@/lib/capabilities/operations";
import { DeploymentView } from "@/components/deploy/live-progress";
import { DeploymentDetail } from "@/app/(product)/p/[slug]/deploys/deployment-detail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({
  deployment: undefined as Deployment | undefined,
  operation: undefined as OperationDetail["operation"] | undefined,
  workspaceId: "workspace-1", role: "admin", loading: false,
  error: undefined as { message: string } | undefined,
  reads: vi.fn(), refresh: vi.fn(), actions: vi.fn(),
}));
vi.mock("@/lib/client/api", () => ({
  useJson: (url: string | null) => {
    if (url?.startsWith("/api/platform/")) {
      state.reads(url);
      return { data: state.operation ? { operation: state.operation } : undefined, loading: state.loading, error: state.error, refresh: state.refresh };
    }
    return { data: url?.startsWith("/api/deployments/") ? { deployment: state.deployment } : undefined, refresh: state.refresh };
  },
  useEventStream: () => ({ connected: true }),
}));
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({
  project: { id: "project-1", workspaceId: "workspace-1" },
  environments: [{ id: "env-1", name: "Staging", class: "staging", connectionId: "connection-1" }], revisions: [],
}) }));
vi.mock("@/components/shell/shell-context", () => ({
  useShell: () => ({ boot: { workspace: { id: state.workspaceId }, role: state.role, connections: [{ id: "connection-1", provider: "aws" }] }, catalog: [] }),
  requiredRoleOf: () => "admin",
}));
vi.mock("@/components/inspector/plan-first", () => ({
  PlanFirst: ({ actionId, input, label, disabled }: { actionId: string; input: unknown; label: string; disabled?: boolean }) =>
    <button data-action={actionId} disabled={disabled} onClick={() => state.actions(actionId, input)}>{label}</button>,
}));
vi.mock("@/components/screens/shared", () => ({
  ActionConfirm: ({ open, actionId, input }: { open: boolean; actionId: string; input: unknown }) =>
    open ? <button data-action={actionId} onClick={() => state.actions(actionId, input)}>Confirm action</button> : null,
  ErrorNote: ({ error }: { error: Error }) => <p role="alert">{error.message}</p>,
}));

const sample = (over: Partial<Deployment> = {}): Deployment => ({
  id: "deployment-1", projectId: "project-1", environmentId: "env-1", revisionId: "revision-1", operationId: "operation-1", executor: "workflow",
  status: "awaiting_approval", steps: [], outputs: [], changeSummary: "Deploy the saved revision", estCostDeltaUsd: 0,
  actor: { type: "user", id: "admin-1", name: "Admin" }, createdAt: "2026-10-04T00:00:00.000Z", ...over,
});
const operation = (over: Partial<OperationDetail["operation"]> = {}): OperationDetail["operation"] => ({
  id: "operation-1", workspaceId: "workspace-1", projectId: "project-1", environmentId: "env-1", capability: "deployment.deploy", status: "awaiting_approval",
  principal: { kind: "user", id: "admin-1", name: "Admin" },
  proposal: { summary: "Saved deployment proposal", details: ["unrendered-metadata-canary"], risk: "high",
    scope: { workspaceId: "workspace-1", projectId: "project-1", environmentId: "env-1" }, input: { deploymentId: "deployment-1", revisionId: "revision-1" } },
  proposalDigest: "a".repeat(64), planDigest: "b".repeat(64), approvalRound: 1, approvalRequired: true, correlationId: "correlation-1",
  createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", expiresAt: "2026-10-05T00:00:00.000Z", ...over,
});
let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];
type Surface = "live" | "history";
const render = async (surface: Surface) => act(async () => root.render(surface === "live"
  ? <DeploymentView deploymentId={state.deployment!.id} onLiveTargets={() => {}} onSwitch={() => {}} onAddRoute={() => {}} />
  : <DeploymentDetail snapshot={state.deployment!} envName="Staging" isProd={false} environmentId="env-1" connectionId="connection-1" projectId="project-1" slug="one" revisionNumbers={new Map()} onChanged={state.refresh} />));
const assertNoInlineApproval = () => {
  expect(host.querySelector('[data-action="deploy.approve"]')).toBeNull();
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "Approve and apply")).toBe(false);
  expect(state.actions).not.toHaveBeenCalled();
};
const approveInline = async (surface: Surface) => {
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Approve and apply")!.click());
  if (surface === "history") await act(async () => (host.querySelector('[data-action="deploy.approve"]') as HTMLButtonElement).click());
};
beforeEach(() => {
  vi.clearAllMocks(); noise.length = 0;
  state.deployment = sample(); state.operation = operation(); state.workspaceId = "workspace-1"; state.role = "admin"; state.loading = false; state.error = undefined;
  vi.spyOn(console, "error").mockImplementation((...args) => { noise.push(String(args[0])); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); expect(noise).toEqual([]); vi.restoreAllMocks(); });

describe.each(["live", "history"] as const)("%s deployment approval routing", surface => {
  it.each([undefined, "2026-10-04T00:01:00.000Z"])("routes the actual native plan gate to platform review with workflow start acknowledgment %s", async workflowStartedAt => {
    state.deployment = sample({ workflowStartedAt }); await render(surface);
    expect(state.reads).toHaveBeenCalledWith("/api/platform/v1/operations/operation-1?workspace=workspace-1");
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')?.textContent).toBe("Review platform plan");
    assertNoInlineApproval();
    expect(host.textContent).not.toContain("b".repeat(64)); expect(host.textContent).not.toContain("unrendered-metadata-canary");
  });

  it("preserves initial proposal approval only for confirmed unbound native round zero", async () => {
    state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render(surface); await approveInline(surface);
    expect(state.actions).toHaveBeenCalledExactlyOnceWith("deploy.approve", { deploymentId: "deployment-1" });
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("routes a bound plan to review even at round zero", async () => {
    state.operation = operation({ approvalRound: 0 }); await render(surface);
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')).not.toBeNull(); assertNoInlineApproval();
  });

  it("keeps truly legacy approval available without a native lookup", async () => {
    state.deployment = sample({ executor: "engine", operationId: undefined }); state.operation = undefined;
    await render(surface); await approveInline(surface);
    expect(state.reads).not.toHaveBeenCalled(); expect(state.actions).toHaveBeenCalledExactlyOnceWith("deploy.approve", { deploymentId: "deployment-1" });
  });

  it("never treats an operation-bearing deployment as legacy because its executor label differs", async () => {
    state.deployment = sample({ executor: "engine" }); await render(surface);
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')).not.toBeNull(); assertNoInlineApproval();
  });

  it.each(["loading", "failure", "missing"] as const)("keeps a %s native lookup read-only and offers an explicit reload", async mode => {
    state.operation = mode === "missing" ? undefined : operation({ approvalRound: 0, planDigest: undefined });
    state.loading = mode === "loading"; state.error = mode === "failure" ? { message: "external-error-canary" } : undefined;
    await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull(); expect(host.textContent).not.toContain("external-error-canary");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Reload approval")!.click());
    expect(state.refresh).toHaveBeenCalledOnce();
  });

  it.each([undefined, -1, 0.5])("does not invent native round zero from invalid approvalRound %s", async approvalRound => {
    state.operation = operation({ approvalRound, planDigest: undefined }); await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it.each(["id", "workspaceId", "projectId", "environmentId"] as const)("refuses a mismatched native %s", async field => {
    state.operation = operation({ [field]: "foreign" }); await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it.each(["deploymentId", "revisionId"] as const)("requires the immutable proposal's actual %s association", async field => {
    const actual = operation(); state.operation = operation({ proposal: { ...actual.proposal, input: { deploymentId: "deployment-1", revisionId: "revision-1", [field]: "foreign" } } });
    await render(surface); assertNoInlineApproval(); expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("refuses a proposal scope that disagrees with the native operation", async () => {
    const actual = operation(); state.operation = operation({ proposal: { ...actual.proposal, scope: { ...actual.proposal.scope, workspaceId: "foreign" } } });
    await render(surface); assertNoInlineApproval(); expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("keeps a workflow with no native operation id read-only", async () => {
    state.deployment = sample({ operationId: undefined }); await render(surface); assertNoInlineApproval();
    expect(state.reads).not.toHaveBeenCalled(); expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("does not revive the previous deployment's approval from a stale read", async () => {
    state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render(surface);
    state.deployment = sample({ id: "deployment-2", revisionId: "revision-2", operationId: "operation-2" }); await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')).toBeNull();
    const next = operation({ id: "operation-2" }); state.operation = { ...next, proposal: { ...next.proposal, input: { deploymentId: "deployment-2", revisionId: "revision-2" } } };
    await render(surface); expect(host.querySelector('a[href="/platform/operations/operation-2"]')).not.toBeNull();
    state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("requires the current workspace even when a previous native read is still present", async () => {
    state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render(surface);
    state.workspaceId = "workspace-2"; await render(surface); assertNoInlineApproval();
    expect(host.querySelector('a[href^="/platform/operations/"]')).toBeNull();
  });

  it("lets a viewer navigate to read the platform plan without offering a product decision", async () => {
    state.role = "viewer"; await render(surface);
    expect(host.querySelector('a[href="/platform/operations/operation-1"]')).not.toBeNull(); assertNoInlineApproval();
  });
});

it("removes an open initial approval confirmation when the native operation advances to its plan round", async () => {
  state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render("history");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Approve and apply")!.click());
  expect(host.querySelector('[data-action="deploy.approve"]')).not.toBeNull();
  state.operation = operation(); await render("history"); assertNoInlineApproval();
  expect(host.querySelector('a[href="/platform/operations/operation-1"]')).not.toBeNull();
});

it("does not carry an open initial confirmation into another selected deployment", async () => {
  state.operation = operation({ approvalRound: 0, planDigest: undefined }); await render("history");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Approve and apply")!.click());
  expect(host.querySelector('[data-action="deploy.approve"]')).not.toBeNull();
  state.deployment = sample({ id: "deployment-2", revisionId: "revision-2", operationId: "operation-2" });
  const next = operation({ id: "operation-2", approvalRound: 0, planDigest: undefined });
  state.operation = { ...next, proposal: { ...next.proposal, input: { deploymentId: "deployment-2", revisionId: "revision-2" } } };
  await render("history");
  expect(host.querySelector('[data-action="deploy.approve"]')).toBeNull(); expect(state.actions).not.toHaveBeenCalled();
  await approveInline("history"); expect(state.actions).toHaveBeenCalledExactlyOnceWith("deploy.approve", { deploymentId: "deployment-2" });
});
