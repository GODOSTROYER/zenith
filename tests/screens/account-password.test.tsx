import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordCard } from "@/app/(product)/account/account-profile";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  reauthenticate: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: calls.createClient }));

const account = (providers = ["google"], id = "signed-in-user", email = "me@example.com") => ({
  id,
  email,
  email_confirmed_at: "2026-01-01T00:00:00Z",
  identities: providers.map((provider) => ({ provider })),
  user_metadata: { provider: "google", has_password: false },
});
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  calls.createClient.mockReturnValue({ auth: calls });
  calls.getUser.mockResolvedValue({ data: { user: account() }, error: null });
  calls.signInWithPassword.mockResolvedValue({ data: { user: account(["email"]) }, error: null });
  calls.updateUser.mockResolvedValue({ data: { user: account(["google", "email"]) }, error: null });
  calls.reauthenticate.mockResolvedValue({ error: null });
  calls.resetPasswordForEmail.mockResolvedValue({ error: null });
  calls.signOut.mockResolvedValue({ error: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async () => { await act(async () => root.render(<PasswordCard email="me@example.com" />)); };
const field = (label: string) => {
  const element = [...host.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return element ? document.getElementById(element.htmlFor) as HTMLInputElement : null;
};
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label)!;
const submitButton = () => button("Set or change password") ?? button("Change password");
const click = async (target: HTMLButtonElement) => { await act(async () => target.click()); };
const type = async (label: string, value: string) => {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const newPassword = async (value = "new-password-123") => {
  await type("New password", value);
  await type("New password again", value);
};

describe("account password setup", () => {
  it("lets a verified Google-only account set a password without supplying a nonexistent current one", async () => {
    await render();
    expect(field("Current password")).toBeNull();
    expect(submitButton().disabled).toBe(true);
    await newPassword();
    await click(submitButton());
    expect(calls.getUser).toHaveBeenCalledTimes(2);
    expect(calls.signInWithPassword).not.toHaveBeenCalled();
    expect(calls.updateUser).toHaveBeenCalledWith({ password: "new-password-123" });
    expect(host.textContent).toContain("Password saved");
    expect(field("New password")?.value).toBe("");
    expect(field("New password again")?.value).toBe("");
    // A successful write proves a password exists, even with older Auth servers
    // whose identity response has not acquired an email identity.
    expect(field("Current password")).not.toBeNull();
  });

  it("requires matching passwords with at least eight characters", async () => {
    await render();
    await newPassword("short");
    expect(submitButton().disabled).toBe(true);
    expect(host.textContent).toContain("Use at least 8 characters");
    await type("New password", "new-password-123");
    expect(submitButton().disabled).toBe(true);
    expect(host.textContent).toContain("These two do not match");
    await click(submitButton());
    expect(calls.updateUser).not.toHaveBeenCalled();
    await type("New password again", "new-password-123");
    expect(submitButton().disabled).toBe(false);
  });

  it("waits for verified identities before enabling password actions", async () => {
    let complete!: (result: unknown) => void;
    calls.getUser.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    await render();
    expect(host.textContent).toContain("Checking your sign-in options");
    expect(submitButton().disabled).toBe(true);
    expect(button("Email password link").disabled).toBe(true);
    expect(field("New password")?.disabled).toBe(true);
    await act(async () => complete({ data: { user: account() }, error: null }));
    expect(host.textContent).not.toContain("Checking your sign-in options");
    expect(field("New password")?.disabled).toBe(false);
  });

  it("offers a retry after verification fails and never treats the failure as OAuth-only", async () => {
    calls.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error("network error") });
    await render();
    expect(submitButton().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not verify");
    expect(calls.updateUser).not.toHaveBeenCalled();
    await click(button("Retry account check"));
    await newPassword();
    expect(submitButton().disabled).toBe(false);
  });

  it("does not let editable metadata bypass current-password verification", async () => {
    calls.getUser.mockResolvedValue({ data: { user: account(["email", "google"]) }, error: null });
    await render();
    expect(field("Current password")).not.toBeNull();
    await newPassword();
    expect(submitButton().disabled).toBe(true);
    await type("Current password", "wrong-password");
    calls.signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error: new Error("Invalid login credentials") });
    await click(submitButton());
    expect(calls.updateUser).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("current password does not match");
    expect(submitButton().disabled).toBe(false);
  });

  it("verifies an existing password and sends it for projects that require current_password", async () => {
    calls.getUser.mockResolvedValue({ data: { user: account(["email"]) }, error: null });
    await render();
    await type("Current password", "old-password");
    await newPassword();
    await click(submitButton());
    expect(calls.signInWithPassword).toHaveBeenCalledWith({ email: "me@example.com", password: "old-password" });
    expect(calls.updateUser).toHaveBeenCalledWith({ password: "new-password-123", current_password: "old-password" });
    expect(field("Current password")?.value).toBe("");
    expect(host.textContent).toContain("Password saved");
  });

  it("ends the local session and refuses the write if password verification changes the account", async () => {
    calls.getUser.mockResolvedValue({ data: { user: account(["email"]) }, error: null });
    calls.signInWithPassword.mockResolvedValueOnce({ data: { user: account(["email"], "another-user") }, error: null });
    await render();
    await type("Current password", "old-password");
    await newPassword();
    await click(submitButton());
    expect(calls.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(calls.updateUser).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("signed-in account changed");
  });

  it("refuses a write if the session changed after the form loaded", async () => {
    await render();
    await newPassword();
    calls.getUser.mockResolvedValueOnce({ data: { user: account(["google"], "another-user", "other@example.com") }, error: null });
    await click(submitButton());
    expect(calls.updateUser).not.toHaveBeenCalled();
    expect(calls.signInWithPassword).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("signed-in account changed");
  });

  it("rechecks identity changes before allowing the OAuth-only path", async () => {
    await render();
    await newPassword();
    calls.getUser.mockResolvedValueOnce({ data: { user: account(["google", "email"]) }, error: null });
    await click(submitButton());
    expect(calls.updateUser).not.toHaveBeenCalled();
    expect(field("Current password")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("sign-in options changed");
  });

  it.each(["reauthentication_needed", "reauthentication_required", "reauth_nonce_missing", "nonce_required"])(
    "requests and submits a verification code when Auth returns %s",
    async (code) => {
      calls.updateUser.mockResolvedValueOnce({ error: failure(code) });
      await render();
      await newPassword();
      await click(submitButton());
      expect(calls.reauthenticate).toHaveBeenCalledOnce();
      expect(calls.updateUser).toHaveBeenCalledTimes(1);
      expect(submitButton().disabled).toBe(true);
      expect(host.textContent).not.toContain("Password saved");
      await type("Verification code", " 123456 ");
      await click(submitButton());
      expect(calls.updateUser).toHaveBeenLastCalledWith({ password: "new-password-123", nonce: "123456" });
      expect(host.textContent).toContain("Password saved");
      expect(field("Verification code")).toBeNull();
    },
  );

  it("retains the form after an invalid nonce without reporting a successful password update", async () => {
    calls.updateUser.mockResolvedValueOnce({ error: failure("reauthentication_needed") });
    await render();
    await newPassword();
    await click(submitButton());
    calls.updateUser.mockResolvedValueOnce({ error: failure("reauthentication_not_valid") });
    await type("Verification code", "000000");
    await click(submitButton());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("invalid or expired");
    expect(host.textContent).not.toContain("Password saved");
    expect(calls.updateUser).toHaveBeenCalledTimes(2);
    expect(field("New password")?.value).toBe("new-password-123");
    await click(button("Send a new code"));
    expect(calls.reauthenticate).toHaveBeenCalledTimes(2);
    expect(field("Verification code")?.value).toBe("");
    expect(submitButton().disabled).toBe(true);
  });

  it("blocks nonce submission after sending the code fails, then lets the user retry", async () => {
    calls.updateUser.mockResolvedValueOnce({ error: failure("reauthentication_needed") });
    calls.reauthenticate.mockResolvedValueOnce({ error: new Error("Too many requests") });
    await render();
    await newPassword();
    await click(submitButton());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Too many attempts");
    expect(submitButton().disabled).toBe(true);
    expect(field("Verification code")?.disabled).toBe(true);
    await click(submitButton());
    expect(calls.updateUser).toHaveBeenCalledTimes(1);
    await click(button("Send verification code"));
    expect(calls.reauthenticate).toHaveBeenCalledTimes(2);
    expect(field("Verification code")?.disabled).toBe(false);
  });

  it("accepts an authoritative current-password requirement even when identities look OAuth-only", async () => {
    calls.updateUser.mockResolvedValueOnce({ error: failure("current_password_required") });
    await render();
    await newPassword();
    await click(submitButton());
    expect(field("Current password")).not.toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Enter your current password");
  });

  it("offers email recovery for an email identity that may have no password", async () => {
    calls.getUser.mockResolvedValue({ data: { user: account(["email", "google"]) }, error: null });
    await render();
    await click(button("Email password link"));
    expect(calls.resetPasswordForEmail).toHaveBeenCalledWith("me@example.com", {
      redirectTo: "http://localhost/auth/callback?next=/reset-password",
    });
    expect(calls.signInWithPassword).not.toHaveBeenCalled();
    expect(calls.updateUser).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Open the password link sent to me@example.com");
  });

  it("shows a failed password write and preserves inputs for retry", async () => {
    calls.updateUser.mockResolvedValueOnce({ error: new Error("Network request failed") });
    await render();
    await newPassword();
    await click(submitButton());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not reach the auth server");
    expect(host.textContent).not.toContain("Password saved");
    expect(field("New password")?.value).toBe("new-password-123");
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());
    expect(host.textContent).toContain("Password saved");
  });
});
