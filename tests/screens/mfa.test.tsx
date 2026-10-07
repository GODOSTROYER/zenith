/** Accessible DOM and SDK contract checks; no browser/axe or real Auth claim. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaFlow } from "@/app/(product)/account/mfa/mfa-flow";
import { MfaControls } from "@/app/(product)/platform/settings/mfa-controls";
import { LegacyCancel } from "@/app/(product)/platform/deployments/[id]/legacy-cancel";
import { projectLegacyDeployment } from "@/lib/platform/operator-journey";

const mocks = vi.hoisted(() => ({ user: vi.fn(), factors: vi.fn(), enroll: vi.fn(), verify: vi.fn(), unenroll: vi.fn(), api: vi.fn(), execute: vi.fn(), refresh: vi.fn(), configured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { getUser: mocks.user, mfa: { listFactors: mocks.factors, enroll: mocks.enroll, challengeAndVerify: mocks.verify, unenroll: mocks.unenroll } } }) }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => mocks.configured }));
vi.mock("@/lib/client/api", () => ({ api: mocks.api, executeAction: mocks.execute }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

let host: HTMLDivElement, root: Root, setupKey: string, code: string;
beforeEach(() => {
  vi.resetAllMocks(); mocks.configured = true;
  setupKey = randomBytes(20).toString("hex"); code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
  mocks.user.mockResolvedValue({ data: { user: { id: "operator" } }, error: null });
  mocks.factors.mockResolvedValue({ data: { totp: [{ id: "factor-one", friendly_name: "My authenticator", status: "verified" }], all: [] }, error: null });
  mocks.enroll.mockResolvedValue({ data: { id: "new-factor", totp: { secret: setupKey, qr_code: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}` } }, error: null });
  mocks.verify.mockResolvedValue({ data: {}, error: null }); mocks.unenroll.mockResolvedValue({ error: null });
  mocks.api.mockResolvedValue({ verified: true }); mocks.execute.mockResolvedValue({ ok: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = async (mode: "enrol" | "challenge" = "challenge", next?: string) => { await act(async () => root.render(<MfaFlow mode={mode} returnTo={next} />)); };
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const type = async (value: string) => {
  const input = host.querySelector<HTMLInputElement>("#mfa-code")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const submit = async () => { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };

describe("authenticator screens", () => {
  it("labels the factor/code, supplies numeric/OTP hints, and focuses the code", async () => {
    await render();
    expect(host.querySelector('label[for="mfa-factor"]')?.textContent).toBe("Authenticator");
    expect(host.querySelector('label[for="mfa-code"]')?.textContent).toBe("Six-digit authenticator code");
    const input = host.querySelector<HTMLInputElement>("#mfa-code")!;
    expect(input.getAttribute("autocomplete")).toBe("one-time-code"); expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("aria-describedby")).toBe("mfa-code-help"); expect(document.activeElement).toBe(input);
    expect(button("Verify authenticator").type).toBe("submit");
  });
  it("accepts six digits only and sends the selected factor through the SDK", async () => {
    await render();
    for (const value of ["", "12", "abcdef", "1234567"]) { await type(value); expect(button("Verify authenticator").disabled).toBe(true); await submit(); }
    expect(mocks.verify).not.toHaveBeenCalled();
    await type(code); await submit();
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ factorId: "factor-one", code });
    expect(mocks.api).toHaveBeenCalledWith("/api/auth/mfa/verify", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    expect(host.textContent).toContain("Authenticator verified"); expect(document.activeElement?.textContent).toBe("Authenticator verified");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("waits for the server to confirm AAL2 before showing success", async () => {
    mocks.api.mockRejectedValueOnce(new Error(setupKey)); await render(); await type(code); await submit();
    expect(host.textContent).not.toContain("Authenticator verified"); expect(host.textContent).not.toContain(setupKey);
    expect(host.querySelector<HTMLInputElement>("#mfa-code")?.value).toBe(""); expect(document.activeElement?.getAttribute("role")).toBe("alert");
  });
  it("shows a focused generic alert and clears an invalid code without reflecting provider secrets", async () => {
    mocks.verify.mockResolvedValueOnce({ error: new Error(setupKey) }); await render(); await type(code); await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be verified"); expect(host.textContent).not.toContain(setupKey);
    expect(mocks.api).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>("#mfa-code")?.value).toBe("");
  });
  it("blocks duplicate form events while verification is pending", async () => {
    let finish!: (value: unknown) => void;
    mocks.verify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render(); await type(code); await submit(); await submit(); expect(mocks.verify).toHaveBeenCalledOnce();
    expect(button("Verify authenticator").disabled).toBe(true);
    await act(async () => finish({ error: null })); expect(host.textContent).toContain("Authenticator verified");
  });
  it("offers enrollment when no verified TOTP is available", async () => {
    mocks.factors.mockResolvedValueOnce({ data: { totp: [{ id: "pending", status: "unverified" }] }, error: null });
    await render(); expect(host.querySelector("form")).toBeNull(); expect(host.textContent).toContain("No verified authenticator");
    expect(host.querySelector('a[href^="/account/mfa/enrol"]')).not.toBeNull();
  });
  it("requires live identity and factor discovery before enabling enrollment", async () => {
    mocks.user.mockResolvedValueOnce({ data: { user: null }, error: null }); await render("enrol");
    expect(host.querySelector("button")).toBeNull(); expect(mocks.factors).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("refuses unavailable Auth honestly", async () => {
    mocks.configured = false; await render(); expect(host.textContent).toContain("Authentication is unavailable"); expect(mocks.user).not.toHaveBeenCalled();
  });
  it("enrolls TOTP and exposes an accessible manual key without injecting SVG markup", async () => {
    await render("enrol"); await click(button("Set up authenticator"));
    expect(mocks.enroll).toHaveBeenCalledWith(expect.objectContaining({ factorType: "totp", issuer: "Zenith" }));
    expect(host.querySelector<HTMLInputElement>("#mfa-setup-key")?.value).toBe(setupKey);
    expect(host.querySelector('label[for="mfa-setup-key"]')).not.toBeNull(); expect(host.querySelector("img")?.alt).toContain("setup key");
    expect(host.querySelector("svg")).toBeNull(); expect(document.activeElement?.id).toBe("mfa-code");
    await type(code); await submit(); expect(mocks.verify).toHaveBeenCalledWith({ factorId: "new-factor", code });
    expect(host.querySelector("#mfa-setup-key")).toBeNull(); expect(host.querySelector("img")).toBeNull();
  });
  it("explicitly cancels an unverified enrollment and erases its secret", async () => {
    await render("enrol"); await click(button("Set up authenticator")); await click(button("Cancel setup"));
    expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: "new-factor" }); expect(host.querySelector("#mfa-setup-key")).toBeNull();
  });
  it("erases the setup key once the provider verifies it, even if the server refuses the new session", async () => {
    mocks.api.mockRejectedValueOnce(new Error(setupKey)); await render("enrol"); await click(button("Set up authenticator")); await type(code); await submit();
    expect(host.querySelector("#mfa-setup-key")).toBeNull(); expect(host.textContent).not.toContain(setupKey); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("returns to the current review safely and never auto-submits the action", async () => {
    await render("challenge", "//attacker.test"); await type(code); await submit();
    expect([...host.querySelectorAll("a")].find((link) => link.textContent === "Return to review")?.getAttribute("href")).toBe("/platform");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("workspace controls and legacy cancellation", () => {
  it("shows the enforced controls for the selected workspace and rejects stale workspace data", async () => {
    mocks.api.mockResolvedValueOnce({ workspaceId: "ws-a", privilegedActionsRequireAal2: true, requireForAllMutations: true, maxAgeSeconds: 300 });
    await act(async () => root.render(<MfaControls workspaceId="ws-a" />)); expect(host.textContent).toContain("all changes by people"); expect(host.textContent).toContain("300 seconds");
    mocks.api.mockResolvedValueOnce({ workspaceId: "ws-b" }); await act(async () => root.render(<MfaControls key="new" workspaceId="ws-a" />)); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("requires a confirmation and sends only the existing cancellation action", async () => {
    await act(async () => root.render(<LegacyCancel deploymentId="dep" canCancel />)); await click(button("Cancel deployment"));
    expect(document.activeElement).toBe(button("Confirm cancellation")); expect(mocks.execute).not.toHaveBeenCalled();
    await click(button("Confirm cancellation")); expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("deploy.cancel", { input: { deploymentId: "dep" } });
    expect(mocks.refresh).toHaveBeenCalledOnce(); expect(document.activeElement?.textContent).toContain("Cancellation recorded");
  });
  it("disables cancellation for viewers and explains the required role", async () => {
    await act(async () => root.render(<LegacyCancel deploymentId="dep" canCancel={false} />)); expect(button("Cancel deployment").disabled).toBe(true);
    expect(button("Cancel deployment").getAttribute("aria-describedby")).toContain("legacy-cancel-role"); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not claim a failed/unconfirmed cancellation succeeded", async () => {
    mocks.execute.mockResolvedValueOnce({ ok: false }); await act(async () => root.render(<LegacyCancel deploymentId="dep" canCancel />));
    await click(button("Cancel deployment")); await click(button("Confirm cancellation")); expect(host.textContent).toContain("could not be confirmed"); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each(["planning", "awaiting_approval", "applying", "verifying", "rolling_back"] as const)("offers the real legacy engine cancellation during %s", (status) => {
    expect(projectLegacyDeployment({ id: "dep", executor: "engine", status, steps: [] }).cancel.available).toBe(true);
  });
  it.each(["succeeded", "failed", "cancelled", "rolled_back"] as const)("keeps terminal legacy deployment %s uncancellable", (status) => {
    expect(projectLegacyDeployment({ id: "dep", executor: "engine", status, steps: [] }).cancel.available).toBe(false);
  });
});
