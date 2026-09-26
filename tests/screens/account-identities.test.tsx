import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@/lib/client/api";
import { IdentitiesCard, LINKING_DISABLED, type AccountIdentity } from "@/app/(product)/account/account-identities";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  api: vi.fn(),
  assign: vi.fn(),
  getUserIdentities: vi.fn(),
  linkIdentity: vi.fn(),
  unlinkIdentity: vi.fn(),
  providers: ["google", "github"],
}));
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: calls.api,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: {
    getUserIdentities: calls.getUserIdentities,
    linkIdentity: calls.linkIdentity,
    unlinkIdentity: calls.unlinkIdentity,
  } }),
}));
vi.mock("@/lib/supabase/env", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/env")>()),
  SUPABASE_OAUTH_PROVIDERS: calls.providers,
}));

const identity = (provider: string, email?: string): AccountIdentity => ({
  id: `${provider}-id`,
  identity_id: `${provider}-identity`,
  user_id: "account-id",
  provider,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  identity_data: email ? { email } : {},
});
const loaded = (...identities: AccountIdentity[]) => ({ data: { identities }, error: null });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  calls.api.mockReset();
  calls.getUserIdentities.mockReset().mockResolvedValue(loaded(identity("email", "me@example.com")));
  calls.unlinkIdentity.mockReset().mockResolvedValue({ error: null });
  calls.providers.splice(0, calls.providers.length, "google", "github");
  window.history.replaceState(null, "", "/account");
  vi.stubGlobal("window", new Proxy(window, {
    get: (target, property) => property === "location"
      ? { search: target.location.search, assign: calls.assign }
      : Reflect.get(target, property, target),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () => { await act(async () => root.render(<IdentitiesCard />)); };
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === label);
const button = (label: string) => {
  const result = buttons(label)[0];
  expect(result, `Expected button: ${label}`).toBeDefined();
  return result!;
};
const click = async (label: string) => { await act(async () => button(label).click()); };
const removeFor = (provider: string) => [...host.querySelectorAll("li")]
  .find((row) => row.querySelector("p")?.textContent === provider)!.querySelector("button")!;
const selectRemoval = async (provider: string) => { await act(async () => removeFor(provider).click()); };

describe("account sign-in methods", () => {
  it("keeps every connection disabled until identities have loaded", async () => {
    const pending = deferred<ReturnType<typeof loaded>>();
    calls.getUserIdentities.mockReturnValue(pending.promise);
    await render();
    expect(host.querySelector('[aria-label="Loading sign-in methods"]')).not.toBeNull();
    expect(button("Connect Google").disabled).toBe(true);
    expect(button("Connect GitHub").disabled).toBe(true);
    await click("Connect Google");
    expect(calls.api).not.toHaveBeenCalled();
    await act(async () => pending.resolve(loaded(identity("email"))));
    expect(button("Connect Google").disabled).toBe(false);
  });

  it("shows connected Google once and reads its metadata email", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), identity("google", "google@example.com")));
    await render();
    expect(buttons("Connect Google")).toHaveLength(0);
    expect(host.textContent).toContain("google@example.com");
    expect(removeFor("Google").disabled).toBe(false);
    expect(removeFor("Email").disabled).toBe(true);
    expect(host.textContent).not.toContain("Email and password");
  });

  it("falls back to a legacy email and never renders non-string metadata", async () => {
    const google = identity("google");
    google.email = "legacy@example.com";
    google.identity_data = { email: { untrusted: true } };
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), google));
    await render();
    expect(host.textContent).toContain("legacy@example.com");
    expect(host.textContent).not.toContain("[object Object]");
  });

  it("keeps the email identity protected even with other connected methods", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), identity("google")));
    await render();
    expect(removeFor("Email").title).toContain("Email cannot be removed");
    await selectRemoval("Email");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.unlinkIdentity).not.toHaveBeenCalled();
  });

  it("protects the last provider with an explanation", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("google")));
    await render();
    expect(removeFor("Google").disabled).toBe(true);
    expect(removeFor("Google").title).toContain("only sign-in method");
    expect(host.textContent).toContain("only way in");
  });

  it("offers only providers enabled by deployment configuration", async () => {
    calls.providers.splice(0, calls.providers.length, "github");
    await render();
    expect(buttons("Connect Google")).toHaveLength(0);
    expect(button("Connect GitHub").disabled).toBe(false);
  });

  it("starts linking through the authenticated server endpoint and navigates to its URL", async () => {
    calls.api.mockResolvedValue({ url: "https://accounts.google.com/authorize" });
    await render();
    await click("Connect Google");
    expect(calls.api).toHaveBeenCalledWith("/api/account/identities/link", {
      method: "POST", body: JSON.stringify({ provider: "google" }),
    });
    expect(calls.assign).toHaveBeenCalledWith("https://accounts.google.com/authorize");
    expect(calls.linkIdentity).not.toHaveBeenCalled();
    expect(button("Connect Google").disabled).toBe(true);
    expect(button("Connect GitHub").disabled).toBe(true);
  });

  it("locks both providers immediately so a second click cannot replace the OAuth attempt", async () => {
    const pending = deferred<{ url: string }>();
    calls.api.mockReturnValue(pending.promise);
    await render();
    await act(async () => {
      button("Connect Google").click();
      button("Connect GitHub").click();
    });
    expect(calls.api).toHaveBeenCalledTimes(1);
    expect(button("Connect GitHub").disabled).toBe(true);
    expect(removeFor("Email").disabled).toBe(true);
    await act(async () => pending.reject(new ApiError("Connection failed.", 503, "Try again.")));
    expect(button("Connect Google").disabled).toBe(false);
  });

  it("disables removal while a provider connection is pending", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), identity("github")));
    const pending = deferred<{ url: string }>();
    calls.api.mockReturnValue(pending.promise);
    await render();
    await click("Connect Google");
    expect(removeFor("GitHub").disabled).toBe(true);
    await act(async () => pending.reject(new Error("Connection failed")));
    expect(removeFor("GitHub").disabled).toBe(false);
  });

  it("preserves a server error's deployment fix and clears it on retry", async () => {
    calls.api.mockRejectedValueOnce(new ApiError("Identity linking is disabled.", 503, "Enable manual linking in Supabase."));
    await render();
    await click("Connect Google");
    expect(host.textContent).toContain("Identity linking is disabled. Enable manual linking in Supabase.");
    expect(button("Connect Google").disabled).toBe(false);
    const pending = deferred<{ url: string }>();
    calls.api.mockReturnValueOnce(pending.promise);
    await click("Connect Google");
    expect(host.textContent).not.toContain("Identity linking is disabled.");
    await act(async () => pending.reject(new Error("Try later")));
  });

  it("lets a failed initial load retry without enabling unsafe mutations", async () => {
    calls.getUserIdentities.mockRejectedValueOnce(new Error("Offline"));
    await render();
    expect(host.textContent).toContain("Could not load your sign-in methods");
    expect(button("Connect Google").disabled).toBe(true);
    await click("Retry loading sign-in methods");
    expect(calls.getUserIdentities).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain("Could not load your sign-in methods");
    expect(button("Connect Google").disabled).toBe(false);
  });

  it("asks before removing a provider and allows cancellation", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), identity("google")));
    await render();
    await selectRemoval("Google");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Remove Google?");
    expect(calls.unlinkIdentity).not.toHaveBeenCalled();
    await click("Cancel");
    expect(calls.unlinkIdentity).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.closest("[inert]")).not.toBeNull();
  });

  it("locks controls through removal and refresh, then shows the updated list", async () => {
    const google = identity("google");
    calls.getUserIdentities.mockResolvedValueOnce(loaded(identity("email"), google));
    const unlink = deferred<{ error: null }>();
    const refresh = deferred<ReturnType<typeof loaded>>();
    calls.unlinkIdentity.mockReturnValue(unlink.promise);
    calls.getUserIdentities.mockReturnValueOnce(refresh.promise);
    await render();
    await selectRemoval("Google");
    await click("Remove sign-in method");
    expect(calls.unlinkIdentity).toHaveBeenCalledWith(google);
    expect(button("Connect GitHub").disabled).toBe(true);
    expect(removeFor("Google").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')?.closest("[inert]")).toBeNull();
    await act(async () => unlink.resolve({ error: null }));
    expect(button("Connect GitHub").disabled).toBe(true);
    await act(async () => refresh.resolve(loaded(identity("email"))));
    expect(button("Connect Google").disabled).toBe(false);
    expect(host.textContent).toContain("Google was removed from your sign-in methods.");
    expect(removeFor("Email").disabled).toBe(true);
  });

  it("keeps a refresh failure recoverable after successful removal", async () => {
    calls.getUserIdentities
      .mockResolvedValueOnce(loaded(identity("email"), identity("google")))
      .mockRejectedValueOnce(new Error("Offline"));
    await render();
    await selectRemoval("Google");
    await click("Remove sign-in method");
    expect(host.textContent).toContain("Google was removed");
    expect(host.textContent).toContain("Could not load your sign-in methods");
    expect(button("Connect Google").disabled).toBe(true);
    await click("Retry loading sign-in methods");
    expect(button("Connect Google").disabled).toBe(false);
    expect(host.textContent).not.toContain("Could not load your sign-in methods");
  });

  it("shows removal errors inside its dialog and allows retry", async () => {
    calls.getUserIdentities.mockResolvedValue(loaded(identity("email"), identity("google")));
    calls.unlinkIdentity.mockResolvedValueOnce({ error: { code: "manual_linking_disabled", message: "Disabled" } });
    await render();
    await selectRemoval("Google");
    await click("Remove sign-in method");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(LINKING_DISABLED);
    expect(button("Remove sign-in method").disabled).toBe(false);
    await click("Cancel");
    expect(host.textContent).not.toContain(LINKING_DISABLED);
  });

  it("announces a completed provider connection", async () => {
    window.history.replaceState(null, "", "/account?identity=linked");
    await render();
    expect(host.textContent).toContain("The provider is connected.");
  });

  it.each([
    ["identity_link_failed", "The provider could not be connected"],
    ["identity_link_expired", "connection attempt expired"],
    ["identity_link_conflict", "already connected to another account"],
    ["identity_link_cancelled", "connection was cancelled"],
    ["identity_link_mismatch", "sign-in session changed"],
  ])("explains callback failure %s without rendering raw provider text", async (code, message) => {
    window.history.replaceState(null, "", `/account?identity_error=${code}`);
    await render();
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain(code);
  });

  it("uses fixed fallback copy for unrecognized query values and clears it on a new attempt", async () => {
    window.history.replaceState(null, "", "/account?identity_error=untrusted-provider-message&identity=linked");
    await render();
    expect(host.textContent).toContain("The provider could not be connected");
    expect(host.textContent).not.toContain("untrusted-provider-message");
    expect(host.textContent).not.toContain("The provider is connected");
    const pending = deferred<{ url: string }>();
    calls.api.mockReturnValue(pending.promise);
    await click("Connect Google");
    expect(host.textContent).not.toContain("The provider could not be connected");
    await act(async () => pending.reject(new Error("Try later")));
  });
});
