/** DOM contracts only: no operated browser, identity service or cloud. */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionAdmin } from "@/app/(product)/platform/connections/connection-admin";
import { RUNNER_CONNECTION_PROVIDERS } from "@/lib/connections/schemas";
import { runnerInput, runnerView } from "../../connections/runner-inputs";
import { mount, button, click, type, flush, rerender, text } from "./render";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), mutation: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/(product)/platform/_lib/browser-api", async importOriginal => ({ ...await importOriginal<object>(), browserMutation: mocks.mutation }));
beforeEach(() => { mocks.refresh.mockReset(); mocks.mutation.mockReset().mockResolvedValue({ ok: true, summary: "Readiness only; cloud permissions remain unverified.", data: {} }); });

function input(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("label")].find(el => text(el).startsWith(label))?.querySelector("input");
  if (!found) throw new Error(`Missing input ${label}`);
  return found;
}
const labels: Record<string, string> = { accountId: "AWS account id", region: "Region", observeRoleArn: "Observe role ARN", deployRoleArn: "Deploy role ARN", projectId: "Project id", workloadIdentityProvider: "Workload identity provider", observeServiceAccount: "Observe service account", deployServiceAccount: "Deploy service account", tenantId: "Tenant id", clientId: "Application (client) id", subscriptionId: "Subscription id", tenancyOcid: "Tenancy OCID", compartmentOcid: "Compartment OCID", server: "Kubernetes API origin", namespaces: "Namespaces", runnerId: "Registered runner id" };
const names = { aws: "AWS", gcp: "Google Cloud", azure: "Azure", oci: "Oracle Cloud", kubernetes: "Kubernetes" };

describe("runner connection administration", () => {
  it.each(RUNNER_CONNECTION_PROVIDERS)("creates %s with the shared schema only after human Save", async provider => {
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[]} />);
    click(button(host, names[provider]));
    expect(button(host, names[provider]).getAttribute("aria-pressed")).toBe("true");
    if (provider === "gcp" || provider === "azure") click(input(host, "Customer runner"));
    const expected = runnerInput(provider);
    for (const [key, value] of Object.entries(expected)) if (labels[key]) type(input(host, labels[key]), ` ${Array.isArray(value) ? value.join(", ") : value} `);
    const select = host.querySelector("select")!;
    expect(select.closest("label")?.textContent).toContain("Runner credential custody");
    act(() => { select.value = "federated"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(button(host, "Save connection").disabled).toBe(false);
    expect(input(host, "Registered runner id").getAttribute("aria-required")).toBe("true");
    click(button(host, "Save connection")); await flush();
    expect(mocks.mutation).toHaveBeenCalledExactlyOnceWith("ws-a", "/api/platform/v1/connections", { ...expected, runnerCustody: "federated" });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("not verified yet");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("keeps Zenith managed creation independent of the previous runner mode", async () => {
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[]} />);
    click(input(host, "Customer runner"));
    click(button(host, "Zenith managed"));
    expect(button(host, "Zenith managed").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Zenith managed needs no cloud account");
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).not.toContain("Registered runner id");
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(button(host, "Save connection").disabled).toBe(false);
    click(button(host, "Save connection")); await flush();
    expect(mocks.mutation).toHaveBeenCalledExactlyOnceWith("ws-a", "/api/platform/v1/connections", { provider: "zenith" });
  });

  it("rejects malformed identifiers locally and protects create for viewers", () => {
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[]} />);
    click(button(host, "Kubernetes"));
    type(input(host, "Kubernetes API origin"), "http://insecure.example.test"); type(input(host, "Namespaces"), "customer"); type(input(host, "Registered runner id"), "run_registered");
    expect(button(host, "Save connection").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTPS");
    click(button(host, "Save connection")); expect(mocks.mutation).not.toHaveBeenCalled();
    rerender(host, <ConnectionAdmin workspaceId="ws-a" viewerRole="viewer" initial={[]} />);
    expect(input(host, "Registered runner id").disabled).toBe(true); expect(button(host, "Save connection").disabled).toBe(true);
  });

  it.each(RUNNER_CONNECTION_PROVIDERS)("verifies and stages only runner replacement for %s", async provider => {
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[runnerView(provider)]} />);
    click(button(host, "Verify")); await flush();
    expect(mocks.mutation).toHaveBeenLastCalledWith("ws-a", "/api/platform/v1/connections/conn_runner/verify", {});
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Runner readiness verified");
    click(button(host, "Rotate access"));
    const rotation = input(host, "New runner id").parentElement!.parentElement!;
    expect(rotation.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(1);
    type(input(host, "New runner id"), " run_new ");
    click(input(host, "After switching")); click(input(host, "Switch immediately"));
    click(button(host, "Stage and verify")); await flush();
    expect(mocks.mutation).toHaveBeenLastCalledWith("ws-a", "/api/platform/v1/connections/conn_runner/rotate", { patch: { runnerId: "run_new" }, promote: true, retirePreviousRunner: true });
  });

  it("promotes/discards exact candidates and refuses unverified promotion", async () => {
    const c = runnerView("aws", { rotation: { id: "rot_1", status: "failed", changes: ["runnerId"], createdAt: "2026-10-08T00:00:00Z" } });
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[c]} />);
    expect(button(host, "Promote new access").disabled).toBe(true);
    click(button(host, "Discard")); await flush();
    expect(mocks.mutation).toHaveBeenLastCalledWith("ws-a", "/api/platform/v1/connections/conn_runner/rotation/abort", { rotationId: "rot_1" });
    rerender(host, <ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[{ ...c, rotation: { ...c.rotation!, status: "verified" } }]} />);
    click(button(host, "Promote new access")); await flush();
    expect(mocks.mutation).toHaveBeenLastCalledWith("ws-a", "/api/platform/v1/connections/conn_runner/rotation/promote", { rotationId: "rot_1" });
  });

  it("requires the exact id to revoke, sends the runner retirement choice and blocks revoked controls", async () => {
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[runnerView()]} />);
    click(button(host, "Revoke")); type(input(host, "Type the connection id"), "conn_other");
    expect(button(host, "Revoke connection").disabled).toBe(true); expect(mocks.mutation).not.toHaveBeenCalled();
    type(input(host, "Type the connection id"), "conn_runner"); type(input(host, "Reason"), " retired "); click(input(host, "Also revoke"));
    click(button(host, "Revoke connection")); await flush();
    expect(mocks.mutation).toHaveBeenCalledExactlyOnceWith("ws-a", "/api/platform/v1/connections/conn_runner/revoke", { confirm: "conn_runner", reason: "retired", revokeRunner: true });
    rerender(host, <ConnectionAdmin workspaceId="ws-a" viewerRole="admin" initial={[runnerView("aws", { status: "revoked" })]} />);
    for (const label of ["Verify", "Rotate access", "Revoke"]) expect(button(host, label).disabled).toBe(true);
  });

  it("allows editor readiness checks only and reports failures without claiming success", async () => {
    mocks.mutation.mockRejectedValueOnce(Object.assign(new Error("unsafe server detail"), { status: 403 }));
    const host = mount(<ConnectionAdmin workspaceId="ws-a" viewerRole="editor" initial={[runnerView()]} />);
    expect(button(host, "Verify").disabled).toBe(false);
    expect(button(host, "Rotate access").disabled).toBe(true); expect(button(host, "Revoke").disabled).toBe(true);
    click(button(host, "Verify")); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("server refused");
    expect(host.textContent).not.toContain("unsafe server detail"); expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
