/** Browser contract tests with fake action replies; no live identity, approval or cloud claims. */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPlan } from "@/lib/actions/core";
import { EnvironmentTeardown } from "@/app/(product)/platform/environments/[id]/environment-teardown";
import { button, click, describedBy, flush, mount, rerender, text, type } from "../screens/platform/render";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
const props = { workspaceId: "ws_1", environmentId: "env_prod", environmentName: "Production", viewerRole: "admin" as const };
const plan: ActionPlan = {
  summary: "Tear down Production infrastructure.",
  details: ["Counts: 3 deletes, 2 retained.", "Stateful deletes: aws_db_instance.main (1).", "Retained: aws_ebs_volume.backup, imported.shared_network (2)."],
  warnings: ["Deleting the database permanently removes data."],
  risk: "high", costDeltaUsd: 0, requiresApproval: true, requiredRole: "admin",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const planReply = (value: unknown = plan) => reply({ plan: value });
const input = (el: HTMLElement) => el.querySelector("input") as HTMLInputElement;
function request(index = 0) {
  const [path, init] = fetchMock.mock.calls[index];
  return { path, init: init!, headers: new Headers(init!.headers), body: JSON.parse(init!.body as string) };
}
async function review(element = <EnvironmentTeardown {...props} />, value: unknown = plan) {
  fetchMock.mockResolvedValueOnce(planReply(value));
  const el = mount(element);
  click(button(el, "Review teardown plan")); await flush();
  return el;
}

describe("environment teardown review", () => {
  it("reviews server counts, stateful deletes and retained resources before exact name confirmation", async () => {
    const el = await review();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request().path).toBe("/api/actions/env.teardown");
    expect(request().body).toEqual({ mode: "plan", input: { environmentId: props.environmentId }, scope: { environmentId: props.environmentId } });
    expect(text(el)).toContain("3 deletes, 2 retained");
    expect(text(el)).toContain("Stateful deletes: aws_db_instance.main (1)");
    expect(text(el)).toContain("Retained: aws_ebs_volume.backup, imported.shared_network (2)");
    expect(text(el)).toContain("Deleting the database permanently removes data");
    expect(button(el, "Request teardown for approval").disabled).toBe(true);
    expect(button(el, "Request teardown for approval").title).toContain("exact environment name");
    const field = input(el);
    expect(el.querySelector(`label[for="${field.id}"]`)?.textContent).toContain("Confirm environment name");
    expect(field.getAttribute("aria-required")).toBe("true");
    expect(describedBy(field)).toContain("Type Production exactly");
    for (const wrong of ["production", " Production", "Production ", "env_prod", ""]) {
      type(field, wrong); expect(button(el, "Request teardown for approval").disabled).toBe(true);
    }
    type(field, "Production"); expect(button(el, "Request teardown for approval").disabled).toBe(false);
    type(field, ""); expect(button(el, "Request teardown for approval").disabled).toBe(true);
  });

  it("submits through the session action client and links to the returned operation without approving", async () => {
    const el = await review();
    fetchMock.mockResolvedValueOnce(reply({ result: { ok: true, summary: "Requested", data: { operationId: "op_destroy-1" } } }));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval")); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = request(1);
    expect(sent.path).toBe("/api/actions/env.teardown"); expect(sent.init.method).toBe("POST");
    expect(sent.body).toEqual({ mode: "execute", input: { environmentId: props.environmentId }, scope: { environmentId: props.environmentId }, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(sent.headers.has("authorization")).toBe(false);
    expect(sent.headers.has("x-zenith-actor")).toBe(false);
    expect(sent.headers.has("x-zenith-navigator")).toBe(false);
    expect(el.querySelector('a[href="/platform/operations/op_destroy-1"]')?.textContent).toContain("for approval");
    expect(text(el)).toContain("request recorded"); expect(text(el)).not.toContain("infrastructure deleted");
    expect(el.querySelector("button")).toBeNull(); expect(el.querySelector("input")).toBeNull();
  });

  it.each(["Prod  West", " Production "])("preserves exact confirmation for a name containing spaces (%s)", async (environmentName) => {
    const el = await review(<EnvironmentTeardown {...props} environmentName={environmentName} />);
    const displayed = el.querySelector("strong");
    expect(displayed?.textContent).toBe(environmentName);
    type(input(el), environmentName.trim().replace(/\s+/g, " "));
    expect(button(el, "Request teardown for approval").disabled).toBe(true);
    type(input(el), environmentName);
    expect(button(el, "Request teardown for approval").disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("locks duplicate review clicks and announces loading", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const el = mount(<EnvironmentTeardown {...props} />);
    const control = button(el, "Review teardown plan");
    act(() => { control.click(); control.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(control.disabled).toBe(true);
    expect(el.querySelector('[role="status"]')?.textContent).toContain("Loading");
    await act(async () => { resolve(planReply()); });
    expect(button(el, "Request teardown for approval").disabled).toBe(true);
  });

  it("locks duplicate submission clicks, typing and replanning while a request is pending", async () => {
    const el = await review();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    type(input(el), props.environmentName);
    const control = button(el, "Request teardown for approval");
    act(() => { control.click(); control.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(control.disabled).toBe(true);
    expect(input(el).disabled).toBe(true); expect(button(el, "Review teardown plan").disabled).toBe(true);
    expect(el.querySelector('p[role="status"]')?.textContent).toContain("Submitting");
    await act(async () => { resolve(reply({ result: { ok: true, data: { operationId: "op_1" } } })); });
    expect(el.querySelector('a[href="/platform/operations/op_1"]')).not.toBeNull();
  });

  it("clears the reviewed plan and typed confirmation on a new review", async () => {
    const el = await review(); type(input(el), props.environmentName);
    fetchMock.mockResolvedValueOnce(planReply({ ...plan, details: ["Counts: 4 deletes, 1 retained.", "Stateful deletes: 2.", "Retained: imported.shared_network."] }));
    click(button(el, "Review a new plan")); await flush();
    expect(input(el).value).toBe(""); expect(button(el, "Request teardown for approval").disabled).toBe(true);
    expect(text(el)).toContain("4 deletes, 1 retained"); expect(text(el)).not.toContain("3 deletes, 2 retained");
  });

  it.each(["Policy denies database deletion.", ""])("disables a blocked plan, including an empty refusal (%s)", async (blocked) => {
    const el = await review(undefined, { ...plan, blocked });
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval"));
    expect(button(el, "Request teardown for approval").disabled).toBe(true);
    expect(text(el)).toContain("Teardown refused"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a plan without human approval even if its environment name is entered", async () => {
    const el = await review(undefined, { ...plan, requiresApproval: false });
    type(input(el), props.environmentName);
    expect(text(el)).toContain("Approval unavailable"); expect(button(el, "Request teardown for approval").disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["viewer", "editor"] as const)("explains the server-required admin role to a %s", async (viewerRole) => {
    const el = await review(<EnvironmentTeardown {...props} viewerRole={viewerRole} />);
    expect(text(el)).toContain("admin"); expect(button(el, "Request teardown for approval").disabled).toBe(true);
  });

  it("honors the server's required role instead of inventing a stronger contract", async () => {
    const el = await review(<EnvironmentTeardown {...props} viewerRole="editor" />, { ...plan, requiredRole: "editor" });
    type(input(el), props.environmentName); expect(button(el, "Request teardown for approval").disabled).toBe(false);
  });

  it.each([undefined, "", "   "])("never substitutes an environment id for a missing name (%s)", (environmentName) => {
    const el = mount(<EnvironmentTeardown {...props} environmentName={environmentName} />);
    expect(text(el)).toContain("name is unavailable"); expect(button(el, "Review teardown plan").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables review when workspace membership is absent", () => {
    const el = mount(<EnvironmentTeardown {...props} viewerRole="none" />);
    expect(text(el)).toContain("Workspace membership is required"); expect(button(el, "Review teardown plan").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { ...plan, details: [] }, { ...plan, warnings: [42] }, { ...plan, requiresApproval: undefined }, { ...plan, requiredRole: "owner" }])("fails closed on an incomplete action-plan response (%j)", async (value) => {
    const el = await review(undefined, value === undefined ? null : value);
    expect(text(el)).toContain("summary is unavailable or incomplete"); expect(el.querySelector("input")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "Teardown refused", "Sign in again"],
    [403, "Teardown refused", "workspace role"],
    [404, "Teardown unavailable", "action is available"],
    [409, "Teardown refused", "reviewed state changed"],
    [503, "Teardown unavailable", "Reload"],
  ])("shows an honest plan failure for HTTP %s without raw external errors", async (status, title, recovery) => {
    fetchMock.mockResolvedValueOnce(reply({ error: { message: "secret-value-do-not-render", fix: "<script>evil</script>" } }, status as number));
    const el = mount(<EnvironmentTeardown {...props} />); click(button(el, "Review teardown plan")); await flush();
    expect(text(el)).toContain(title); expect(text(el)).toContain(recovery); expect(text(el)).not.toContain("secret-value");
    expect(el.querySelector("input")).toBeNull(); expect(el.querySelector("script")).toBeNull();
  });

  it("shows network failures while planning as unavailable and permits a fresh review", async () => {
    fetchMock.mockRejectedValueOnce(new Error("do-not-echo-this-network-error"));
    const el = mount(<EnvironmentTeardown {...props} />); click(button(el, "Review teardown plan")); await flush();
    expect(text(el)).toContain("Teardown unavailable"); expect(text(el)).not.toContain("do-not-echo");
    fetchMock.mockResolvedValueOnce(planReply()); click(button(el, "Review teardown plan")); await flush();
    expect(text(el)).toContain("Destroy-plan summary"); expect(input(el).value).toBe("");
  });

  it("treats an explicit execute refusal as refused, never as successful teardown", async () => {
    const el = await review();
    fetchMock.mockResolvedValueOnce(reply({ result: { ok: false, summary: "secret-do-not-render", error: "sensitive-error", data: { operationId: "op_false" } } }));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval")); await flush();
    expect(text(el)).toContain("Teardown refused"); expect(text(el)).not.toContain("secret-do-not-render"); expect(text(el)).not.toContain("sensitive-error");
    expect(el.querySelector('a[href="/platform/operations/op_false"]')).toBeNull(); expect(el.querySelector("input")).toBeNull();
  });

  it("discards confirmation after a stale-state refusal and requires reviewing a fresh plan", async () => {
    const el = await review(); fetchMock.mockResolvedValueOnce(reply({ error: { message: "stale-secret" } }, 409));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval")); await flush();
    expect(text(el)).toContain("reviewed state changed"); expect(text(el)).not.toContain("stale-secret");
    fetchMock.mockResolvedValueOnce(planReply()); click(button(el, "Review teardown plan")); await flush();
    expect(input(el).value).toBe(""); expect(button(el, "Request teardown for approval").disabled).toBe(true);
  });

  it.each([undefined, { ok: true }, { ok: true, data: { operationId: "https://evil.example" } }, { ok: true, data: { operationId: "../escape" } }, { ok: "yes", data: { operationId: "op_1" } }])("reports missing or invalid operation references as unknown (%j)", async (result) => {
    const el = await review(); fetchMock.mockResolvedValueOnce(reply({ result }));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval")); await flush();
    expect(text(el)).toContain("Request outcome unknown"); expect(el.querySelector('a[href="/platform?environmentId=env_prod"]')).not.toBeNull();
    expect(el.querySelector("button")).toBeNull(); expect(el.querySelector("input")).toBeNull();
    expect(el.querySelector('a[href^="https:"]')).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["lost reply", "server unavailable"])("does not retry an ambiguous submission (%s)", async (failure) => {
    const el = await review();
    if (failure === "lost reply") fetchMock.mockRejectedValueOnce(new Error("raw-secret-lost-reply"));
    else fetchMock.mockResolvedValueOnce(reply({ error: { message: "raw-secret-server-error" } }, 503));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval")); await flush();
    expect(text(el)).toContain("Request outcome unknown"); expect(text(el)).not.toContain("raw-secret");
    expect(el.querySelector("button")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["environmentId", "environmentName", "workspaceId", "viewerRole"] as const)("invalidates a reviewed plan and name on a %s change", async (field) => {
    const el = await review(); type(input(el), props.environmentName);
    const next = { ...props, [field]: field === "viewerRole" ? "viewer" : "different" };
    rerender(el, <EnvironmentTeardown {...next} />);
    expect(text(el)).not.toContain("Destroy-plan summary"); expect(el.querySelector("input")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an old environment's late plan reply", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const el = mount(<EnvironmentTeardown {...props} />); click(button(el, "Review teardown plan"));
    rerender(el, <EnvironmentTeardown {...props} environmentId="env_other" environmentName="Other" />);
    await act(async () => { resolve(planReply()); });
    expect(text(el)).not.toContain(plan.summary); expect(el.querySelector("input")).toBeNull();
    fetchMock.mockResolvedValueOnce(planReply({ ...plan, summary: "Other teardown." }));
    click(button(el, "Review teardown plan")); await flush();
    expect(request(1).body.input.environmentId).toBe("env_other"); expect(text(el)).toContain("Other teardown");
  });

  it("does not attach a late submission result to another workspace", async () => {
    const el = await review(); let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    type(input(el), props.environmentName); click(button(el, "Request teardown for approval"));
    rerender(el, <EnvironmentTeardown {...props} workspaceId="ws_other" />);
    await act(async () => { resolve(reply({ result: { ok: true, data: { operationId: "op_old" } } })); });
    expect(el.querySelector('a[href="/platform/operations/op_old"]')).toBeNull(); expect(text(el)).not.toContain("request recorded");
  });

  it("renders external plan and name strings as text", async () => {
    const name = "<img src=x onerror=alert(1)>";
    const el = await review(<EnvironmentTeardown {...props} environmentName={name} />, { ...plan, summary: "<script>external text</script>", details: ["Counts: unknown", "Stateful deletes: unknown", "Retained: <img src=x onerror=alert(1)>"] });
    expect(text(el)).toContain("Counts: unknown"); expect(text(el)).toContain("<script>external text</script>");
    expect(el.querySelector("script,img")).toBeNull();
    type(input(el), name); expect(button(el, "Request teardown for approval").disabled).toBe(false);
  });
});
