/** Browser UI contract tests in jsdom. HTTP replies are test fakes; no live identity or AWS check is claimed. */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomyView } from "@/lib/capabilities/autonomy";
import type { WorkspacePolicyView } from "@/lib/capabilities/policy-settings";
import { DEFAULT_WORKSPACE_POLICY } from "@/lib/policy/types";
import { operation, decision, node, observation, runtime, planView, DIGEST } from "../screens/platform/fixtures";
import { button, click, flush, mount, text, type } from "../screens/platform/render";
import { OperationActions } from "@/app/(product)/platform/operations/[id]/operation-actions";
import { EnvironmentAutonomy } from "@/app/(product)/platform/environments/[id]/environment-autonomy";
import { EnvironmentState } from "@/app/(product)/platform/environments/[id]/environment-state";
import { WorkspacePolicyEditor } from "@/app/(product)/platform/settings/policy-editor";
import { AwsConnectionFlow } from "@/app/(product)/platform/connections/aws/aws-flow";
import { browserMutation } from "@/app/(product)/platform/_lib/browser-api";
import { ShellNavigation } from "@/components/shell/navigation";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); router.refresh.mockReset(); vi.stubGlobal("fetch", fetchMock); });
const jsonReply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const liveOperation = () => operation({ planDigest: undefined, proposal: { ...operation().proposal, planDigest: undefined }, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
function request(index = 0) {
  const [path, init] = fetchMock.mock.calls[index];
  return { path, init: init!, headers: new Headers(init!.headers), body: JSON.parse(init!.body as string) };
}
const autonomy: AutonomyView = { workspaceId: "ws_1", environmentId: "env_prod", environmentClass: "production", level: 2, defaulted: false, defaultForClass: 2, version: 7, name: "Plan", summary: "Summary", unattended: "None", navigator: "approve" };
const policy: WorkspacePolicyView = { workspaceId: "ws_1", overrides: {}, effective: DEFAULT_WORKSPACE_POLICY, version: 3, isDefault: true };

describe("session-only operation controls", () => {
  it("requires the readable bound plan for approval while leaving rejection possible", () => {
    const op = operation({ expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const unavailable = mount(<OperationActions workspaceId="ws_1" operation={op} decision={decision()} approvals={[]} viewer={{ id: "other", role: "admin" }} />);
    expect(button(unavailable, "Approve").disabled).toBe(true); expect(button(unavailable, "Reject").disabled).toBe(false); expect(text(unavailable)).toContain("bound plan is unavailable");
    const readable = mount(<OperationActions workspaceId="ws_1" operation={op} decision={decision()} approvals={[]} viewer={{ id: "other", role: "admin" }} plan={planView()} />);
    expect(button(readable, "Approve").disabled).toBe(false);
  });
  it.each(["Approve", "Reject"])("%s posts the actual reviewed digest with browser cookies and no Authorization", async (action) => {
    fetchMock.mockResolvedValueOnce(jsonReply({ recorded: true }));
    const el = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} decision={decision()} approvals={[]} viewer={{ id: "user_approver", role: "editor", reviewedDigest: DIGEST }} />);
    click(button(el, action)); await flush();
    const call = request();
    expect(call.path).toBe(`/api/platform/v1/operations/op_1/${action.toLowerCase()}`);
    expect(call.body).toEqual({ proposalDigest: DIGEST });
    expect(call.init.method).toBe("POST"); expect(call.init.credentials).toBe("same-origin");
    expect(call.headers.has("authorization")).toBe(false); expect(call.headers.has("origin")).toBe(false);
    expect(call.headers.get("x-zenith-workspace")).toBe("ws_1");
    expect(router.refresh).toHaveBeenCalledOnce(); expect(text(el)).toContain("Decision recorded");
  });
  it("sends the optional reason without serializing record fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({}));
    const el = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} decision={decision()} approvals={[]} viewer={{ id: "other", role: "admin" }} />);
    type(el.querySelector("textarea")!, "Reviewed the database change"); click(button(el, "Approve")); await flush();
    expect(request().body).toEqual({ proposalDigest: DIGEST, reason: "Reviewed the database change" });
  });
  it("shows a session refusal without echoing arbitrary server secrets and allows a reload", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ error: { message: "password=never-echo-this" } }, 401));
    const el = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} decision={decision()} approvals={[]} viewer={{ id: "other", role: "admin" }} />);
    click(button(el, "Approve")); await flush();
    expect(text(el)).toContain("Sign in again"); expect(text(el)).not.toContain("never-echo-this"); expect(router.refresh).not.toHaveBeenCalled();
    click(button(el, "Refresh details")); expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("does not offer an approval to a viewer or the requester under two-person policy", () => {
    const viewer = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} decision={decision()} approvals={[]} viewer={{ id: "other", role: "viewer" }} />);
    expect(button(viewer, "Approve").disabled).toBe(true);
    const requester = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} decision={decision()} approvals={[]} viewer={{ id: "user_requester", role: "admin" }} />);
    expect(button(requester, "Approve").disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancels an unstarted operation and refreshes the state", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ status: "cancelled" }));
    const el = mount(<OperationActions workspaceId="ws_1" operation={liveOperation()} approvals={[]} viewer={{ id: "other", role: "admin" }} />);
    click(button(el, "Cancel operation")); await flush();
    expect(request().path).toContain("/cancel"); expect(request().body).toEqual({}); expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("explains why a running operation cannot be cancelled", () => {
    const el = mount(<OperationActions workspaceId="ws_1" operation={operation({ status: "running" })} approvals={[]} viewer={{ id: "other", role: "admin" }} />);
    expect(button(el, "Cancel operation").disabled).toBe(true); expect(text(el)).toContain("has not started");
  });
  it("rejects attempts to route the shared mutation helper to another origin", async () => {
    expect(() => browserMutation("ws_1", "https://evil.test/api/platform/v1/policy", {})).toThrow("endpoint");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("versioned settings", () => {
  it("sends the reviewed autonomy version and renders the returned level", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ ...autonomy, version: 8, level: 4 }));
    const el = mount(<EnvironmentAutonomy initial={autonomy} workspaceId="ws_1" viewerRole="admin" environmentName="Production" />);
    click(el.querySelectorAll('input[type="radio"]')[4]); click(button(el, "Save autonomy level")); await flush();
    expect(request().body).toEqual({ level: 4, expectedVersion: 7 }); expect(request().init.method).toBe("PUT");
    expect(request().headers.has("authorization")).toBe(false); expect(text(el)).toContain("Version 8"); expect(text(el)).toContain("Level 4");
  });
  it("keeps non-admin autonomy and policy controls disabled", () => {
    const a = mount(<EnvironmentAutonomy initial={autonomy} workspaceId="ws_1" viewerRole="editor" environmentName="Production" />);
    expect(a.querySelector("fieldset")?.disabled).toBe(true);
    const p = mount(<WorkspacePolicyEditor initial={policy} viewerRole="viewer" />);
    expect(p.querySelector("textarea")?.disabled).toBe(true); expect(button(p, "Save workspace policy").disabled).toBe(true); expect(text(p)).toContain("Only a workspace admin");
  });
  it("saves JSON overrides with optimistic concurrency and shows the effective reply", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ ...policy, version: 4, isDefault: false, overrides: { twoPersonProduction: true }, effective: { ...policy.effective, twoPersonProduction: true } }));
    const el = mount(<WorkspacePolicyEditor initial={policy} viewerRole="admin" />);
    type(el.querySelector("textarea")!, '{"twoPersonProduction":true}'); click(button(el, "Save workspace policy")); await flush();
    expect(request().body).toEqual({ overrides: { twoPersonProduction: true }, expectedVersion: 3 }); expect(request().init.method).toBe("PUT");
    expect(text(el)).toContain("Policy saved at version 4");
  });
  it.each(["invalid JSON", "[]", "null"])("rejects invalid policy draft %s before an HTTP write", async (draft) => {
    const el = mount(<WorkspacePolicyEditor initial={policy} viewerRole="admin" />);
    type(el.querySelector("textarea")!, draft); click(button(el, "Save workspace policy")); await flush(); expect(fetchMock).not.toHaveBeenCalled(); expect(text(el)).toContain("JSON object");
  });
  it("preserves a conflicting policy draft and explains reloading", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ error: { message: "version conflict" } }, 409));
    const el = mount(<WorkspacePolicyEditor initial={policy} viewerRole="admin" />);
    type(el.querySelector("textarea")!, '{"budgetUsdMonthly":10}'); click(button(el, "Save workspace policy")); await flush();
    expect(text(el)).toContain("Reload before retrying"); expect(el.querySelector("textarea")?.value).toBe('{"budgetUsdMonthly":10}');
  });
});

describe("resource selection and safe text", () => {
  it("shows unobserved state and selects the resource for its detail view", () => {
    const el = mount(<EnvironmentState resources={{ environmentId: "env_prod", rows: [{ node: node() }], evidence: "contract" }} drift={{ report: null, truncated: false, evidence: "contract" }} />);
    expect(text(el)).toContain("Not observed yet");
    click(el.querySelector('tbody tr')!); expect(text(el)).toContain("Not observed");
    click(button(el, "Refresh stored state")); expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("renders external markup as text while retaining simulated labels", () => {
    const el = mount(<EnvironmentState resources={{ environmentId: "env_prod", rows: [{ node: node({ address: "<img src=x onerror=alert(1)>" }), observation: observation({ simulated: true }), runtime: runtime({ simulated: true }) }], evidence: "contract" }} drift={{ report: null, truncated: false, evidence: "contract" }} />);
    expect(el.querySelector("img")).toBeNull(); expect(text(el)).toContain("<img src=x onerror=alert(1)>"); expect(text(el)).toContain("simulated");
  });
  it("shows one Platform navigation entry and selects it for child routes", () => {
    const el = mount(<ShellNavigation pathname="/platform/environments/env-prod" />);
    const links = el.querySelectorAll('a[href="/platform"]'); expect(links).toHaveLength(1); expect(links[0].getAttribute("aria-current")).toBe("page");
  });
});

function fillAws(el: HTMLElement) {
  const inputs = [...el.querySelectorAll<HTMLInputElement>("input")];
  for (const [index, value] of ["123456789012", "us-east-1", "arn:aws:iam::123456789012:role/ZenithObserveRole", "arn:aws:iam::123456789012:role/ZenithDeployRole"].entries()) type(inputs[index], value);
}
describe("AWS action wiring", () => {
  it("saves identifiers, displays the exact generated trust, then verifies the saved connection", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ result: { ok: true, data: { connectionId: "conn_real_id", subject: "zenith:ws:ws_1:conn:conn_real_id", issuerHost: "issuer.zenith.test/api/oidc" } } }));
    fetchMock.mockResolvedValueOnce(jsonReply({ result: { ok: true } }));
    const el = mount(<AwsConnectionFlow workspaceId="ws_1" viewerRole="admin" />);
    fillAws(el); expect(button(el, "Verify connection").disabled).toBe(true);
    click(button(el, "Save connection identifiers")); await flush();
    expect(request().path).toBe("/platform/connections/aws/action"); expect(request().body.actionId).toBe("connection.createAws"); expect(request().body.input.provider).toBeUndefined(); expect(request().body.input.externalId).toBeUndefined(); expect(request().body.idempotencyKey).toBeTruthy();
    expect(text(el)).toContain("zenith:ws:ws_1:conn:conn_real_id"); expect(text(el)).toContain("remain unverified");
    expect(button(el, "Verify connection").disabled).toBe(false); click(button(el, "Verify connection")); await flush();
    expect(request(1).path).toBe("/platform/connections/aws/action"); expect(request(1).body.actionId).toBe("connection.verifyAws"); expect(request(1).body.input).toEqual({ connectionId: "conn_real_id" });
    expect(request(1).headers.has("authorization")).toBe(false); expect(text(el)).toContain("Deploy-role permissions and worker health remain unverified");
  });
  it("blocks verification when the form no longer matches the saved identifiers", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ result: { ok: true, data: { connectionId: "conn_real_id", subject: "zenith:ws:ws_1:conn:conn_real_id", issuerHost: "issuer.test" } } }));
    const el = mount(<AwsConnectionFlow workspaceId="ws_1" viewerRole="admin" />); fillAws(el); click(button(el, "Save connection identifiers")); await flush();
    type(el.querySelectorAll<HTMLInputElement>("input")[1], "us-west-2"); expect(button(el, "Verify connection").disabled).toBe(true); expect(text(el)).toContain("differ from the saved connection");
  });
  it("never claims verification after a failed create or verify action", async () => {
    fetchMock.mockResolvedValueOnce(jsonReply({ result: { ok: false, error: "secret-should-not-be-echoed" } }));
    const el = mount(<AwsConnectionFlow workspaceId="ws_1" viewerRole="admin" />); fillAws(el); click(button(el, "Save connection identifiers")); await flush();
    expect(button(el, "Verify connection").disabled).toBe(true); expect(text(el)).not.toContain("secret-should-not-be-echoed"); expect(text(el)).not.toContain("Connection verified");
  });
  it("requires an admin for creation and an operator ARN for AssumeRole", async () => {
    const viewer = mount(<AwsConnectionFlow workspaceId="ws_1" viewerRole="viewer" />); fillAws(viewer); expect(button(viewer, "Save connection identifiers").disabled).toBe(true);
    const admin = mount(<AwsConnectionFlow workspaceId="ws_1" viewerRole="admin" />);
    await act(async () => { const select = admin.querySelector("select")!; select.value = "aws_assume_role"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(text(admin)).toContain("operator-provided control-plane role ARN"); expect(button(admin, "Save connection identifiers").disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });
});
