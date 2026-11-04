/** DOM confirmation contracts; real browser acceptance is separately gated. */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionConfirmation } from "@/app/(product)/platform/connections/confirm/confirmation";
import { connectionHandoff, type ConnectionRequest } from "@/lib/connections/handoff";
import { runnerInput, runnerView } from "../../connections/runner-inputs";
import { mount, button, click, type, flush, text } from "./render";

const mutation = vi.hoisted(() => vi.fn());
vi.mock("@/app/(product)/platform/_lib/browser-api", async importOriginal => ({ ...await importOriginal<object>(), browserMutation: mutation }));
beforeEach(() => { window.history.replaceState(null, "", "/"); mutation.mockReset().mockResolvedValue({ ok: true, summary: "Saved pending readiness verification." }); });
const create: ConnectionRequest = { action: "connection.createRunner", input: runnerInput("aws") };
function draft(request: ConnectionRequest, workspaceId?: string) { window.history.replaceState(null, "", connectionHandoff(request, workspaceId)); }
const consent = (host: HTMLElement) => host.querySelector('input[type="checkbox"]')!;
const confirmButton = (host: HTMLElement) => button(host, "Confirm ");
const connection = runnerView("aws", { rotation: { id: "rot_1", status: "verified", changes: ["runnerId"], createdAt: "2026-10-08T00:00:00Z" } });

describe("CLI and agent browser confirmation", () => {
  it("renders the exact unapproved draft, stays inert on load and applies once after explicit review", async () => {
    draft(create, "ws-a");
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[]} />);
    expect(text(host)).toContain("unapproved draft"); expect(text(host)).toContain("run_registered"); expect(text(host)).toContain("123456789012");
    expect(mutation).not.toHaveBeenCalled(); expect(confirmButton(host).disabled).toBe(true);
    click(confirmButton(host)); expect(mutation).not.toHaveBeenCalled();
    click(consent(host)); click(confirmButton(host)); await flush();
    expect(mutation).toHaveBeenCalledExactlyOnceWith("ws-a", "/api/platform/v1/connections", create.input);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Change confirmed");
    expect(confirmButton(host).disabled).toBe(true); click(confirmButton(host)); expect(mutation).toHaveBeenCalledOnce();
  });

  const cases: [ConnectionRequest, string, unknown][] = [
    [{ action: "connection.verify", input: { connectionId: "conn_runner" } }, "verify", {}],
    [{ action: "connection.rotate", input: { connectionId: "conn_runner", patch: { runnerId: "run_new" }, retirePreviousRunner: true } }, "rotate", { patch: { runnerId: "run_new" }, retirePreviousRunner: true }],
    [{ action: "connection.promoteRotation", input: { connectionId: "conn_runner", rotationId: "rot_1" } }, "rotation/promote", { rotationId: "rot_1" }],
    [{ action: "connection.abortRotation", input: { connectionId: "conn_runner", rotationId: "rot_1" } }, "rotation/abort", { rotationId: "rot_1" }],
    [{ action: "connection.revoke", input: { connectionId: "conn_runner", reason: "retired", revokeRunner: true } }, "revoke", { confirm: "conn_runner", reason: "retired", revokeRunner: true }],
  ];
  it.each(cases)("confirms %j using the existing lifecycle endpoint", async (request, suffix, body) => {
    draft(request);
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[connection]} />);
    click(consent(host));
    if (request.action === "connection.revoke") {
      expect(confirmButton(host).disabled).toBe(true);
      const typed = host.querySelector('input:not([type="checkbox"])') as HTMLInputElement;
      expect(typed.closest("label")?.textContent).toContain("Type the connection id");
      type(typed, "conn_other"); expect(confirmButton(host).disabled).toBe(true); type(typed, "conn_runner");
    }
    click(confirmButton(host)); await flush();
    expect(mutation).toHaveBeenCalledExactlyOnceWith("ws-a", `/api/platform/v1/connections/conn_runner/${suffix}`, body);
  });

  it.each(["viewer", "editor"] as const)("blocks %s creation without treating a draft as approval", role => {
    draft(create);
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole={role} connections={[]} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("current workspace admin");
    expect(confirmButton(host).disabled).toBe(true); expect(mutation).not.toHaveBeenCalled();
  });
  it("allows editor verification and blocks revoked, missing and stale rotation targets", async () => {
    draft(cases[0][0]);
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="editor" connections={[connection]} />);
    click(consent(host)); click(confirmButton(host)); await flush(); expect(mutation).toHaveBeenCalledOnce();
    for (const c of [[], [runnerView("aws", { status: "revoked" })]]) {
      draft(cases[0][0]);
      const blocked = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={c} />);
      expect(confirmButton(blocked).disabled).toBe(true); expect(blocked.querySelector('[role="alert"]')?.textContent).toContain("unavailable or revoked");
    }
    draft({ action: "connection.promoteRotation", input: { connectionId: "conn_runner", rotationId: "rot_old" } });
    const stale = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[connection]} />);
    expect(confirmButton(stale).disabled).toBe(true); expect(stale.querySelector('[role="alert"]')?.textContent).toContain("staged access changed");
  });
  it.each(["#broken", "#%XX", `#${encodeURIComponent(JSON.stringify({ version: 1, request: { ...create, approved: true } }))}`])("refuses malformed/approval-bearing drafts %s", fragment => {
    window.history.replaceState(null, "", `/platform/connections/confirm${fragment}`);
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[]} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("invalid or belongs to another workspace");
    expect(host.querySelector("button")).toBeNull(); expect(mutation).not.toHaveBeenCalled();
  });
  it("refuses a foreign-workspace draft without disclosing its identifiers", () => {
    draft(create, "ws-foreign");
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[]} />);
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain("run_registered"); expect(mutation).not.toHaveBeenCalled();
  });
  it("resets review on a changed fragment and ignores the previous request's eventual answer", async () => {
    let resolve!: (value: unknown) => void;
    mutation.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    draft(create);
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[]} />);
    click(consent(host)); click(confirmButton(host));
    expect(confirmButton(host).disabled).toBe(true); expect(mutation).toHaveBeenCalledOnce();
    act(() => { draft({ ...create, input: { ...create.input, runnerId: "run_other" } }); window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect((consent(host) as HTMLInputElement).checked).toBe(false); expect(text(host)).toContain("run_other");
    await act(async () => resolve({ ok: true, summary: "Previous change confirmed" }));
    expect(host.querySelector('[role="status"]')).toBeNull(); expect(confirmButton(host).disabled).toBe(true);
    click(consent(host)); click(confirmButton(host)); await flush();
    expect(mutation).toHaveBeenLastCalledWith("ws-a", "/api/platform/v1/connections", { ...create.input, runnerId: "run_other" });
  });
  it("reports server refusals honestly and never echoes unknown exception text", async () => {
    draft(create); mutation.mockRejectedValueOnce(new Error("untrusted provider text"));
    const host = mount(<ConnectionConfirmation workspaceId="ws-a" viewerRole="admin" connections={[]} />);
    click(consent(host)); click(confirmButton(host)); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed"); expect(text(host)).not.toContain("untrusted provider text");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
