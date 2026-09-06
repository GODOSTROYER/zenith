import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthForm } from "@/components/auth/auth-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({
  createClient: vi.fn(),
  signIn: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  search: "",
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: calls.createClient }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_OAUTH_PROVIDERS: [], OAUTH_PROVIDER_LABEL: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: calls.replace, refresh: calls.refresh }),
  useSearchParams: () => new URLSearchParams(calls.search),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  vi.resetAllMocks();
  calls.search = "next=%2Fp%2Fdemo%2Factivity";
  calls.createClient.mockImplementation(() => ({ auth: { signInWithPassword: calls.signIn } }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AuthForm mode="login" />));
  await act(async () => {
    for (const [type, value] of [["email", "builder@example.test"], ["password", "synthetic-test-password"]]) {
      const input = host.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const submitButton = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function submit() { await act(async () => submitButton().click()); }

it("shows client initialization failures and releases the submit button for retry", async () => {
  calls.createClient.mockImplementationOnce(() => { throw new Error("Auth client initialization failed"); });
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Auth client initialization failed");
  expect(submitButton().disabled).toBe(false);
  expect(calls.signIn).not.toHaveBeenCalled();
  expect(calls.replace).not.toHaveBeenCalled();

  calls.signIn.mockResolvedValue({ error: null });
  await submit();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(calls.replace).toHaveBeenCalledWith("/p/demo/activity");
});

it("explains invalid credentials and permits another sign-in attempt", async () => {
  calls.signIn.mockResolvedValueOnce({ error: new Error("Invalid login credentials") });
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("That email and password do not match");
  expect(submitButton().disabled).toBe(false);
  expect(calls.replace).not.toHaveBeenCalled();

  calls.signIn.mockResolvedValueOnce({ error: null });
  await submit();
  expect(calls.signIn).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(calls.replace).toHaveBeenCalledWith("/p/demo/activity");
});

it("keeps sign-in busy until authentication succeeds, then navigates and refreshes", async () => {
  let complete!: (result: { error: null }) => void;
  calls.signIn.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  await submit();
  expect(calls.signIn).toHaveBeenCalledWith({ email: "builder@example.test", password: "synthetic-test-password" });
  expect(submitButton().disabled).toBe(true);
  expect(submitButton().getAttribute("aria-busy")).toBe("true");
  expect(calls.replace).not.toHaveBeenCalled();
  await act(async () => complete({ error: null }));
  expect(calls.replace).toHaveBeenCalledWith("/p/demo/activity");
  expect(calls.refresh).toHaveBeenCalledOnce();
  expect(submitButton().disabled).toBe(false);
});

it("shows a redirected verification error on the existing form without clearing its input", async () => {
  calls.search += "&error=auth_unavailable";
  await act(async () => root.render(<AuthForm mode="login" />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("verify your session");
  expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe("builder@example.test");
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("synthetic-test-password");

  calls.signIn.mockResolvedValue({ error: new Error("Invalid login credentials") });
  await submit();
  await act(async () => root.render(<AuthForm mode="login" />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("That email and password do not match");
  calls.search = "next=%2Fp%2Fdemo%2Factivity";
  await act(async () => root.render(<AuthForm mode="login" />));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps repeated server verification failures visible when the redirect URL is unchanged", async () => {
  calls.search += "&error=auth_unavailable";
  await act(async () => root.render(<AuthForm mode="login" />));
  let complete!: (result: { error: null }) => void;
  calls.signIn.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  await submit();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => complete({ error: null }));
  // The browser accepted the password, but middleware returns the same error URL.
  await act(async () => root.render(<AuthForm mode="login" />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("verify your session");
  expect(submitButton().disabled).toBe(false);
});
