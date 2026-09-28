import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminEntry } from "@/app/admin/admin-entry";

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signInWithPassword: mocks.signIn } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AdminEntry />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function fill() {
  host.querySelector<HTMLInputElement>('[name="email"]')!.value = "owner@example.test";
  host.querySelector<HTMLInputElement>('[name="password"]')!.value = "test-only-password";
}
function submit() { host.querySelector("form:not([action])")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }

it("starts with empty credentials, owner guidance, reset link and creator attribution", () => {
  expect(host.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe("");
  expect(host.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe("");
  expect(host.querySelector('a[href="/forgot-password?next=%2Fadmin"]')).not.toBeNull();
  expect(host.querySelector('a[href="https://www.arnavbule.in"]')?.textContent).toContain("Arnav Bule");
  expect(host.textContent).toContain("Authorized owners only");
  expect(host.textContent).not.toContain("Approval history");
});

it("signs in with entered credentials and refreshes the server authorization boundary", async () => {
  mocks.signIn.mockResolvedValue({ error: null });
  fill();
  await act(async () => submit());
  expect(mocks.signIn).toHaveBeenCalledWith({ email: "owner@example.test", password: "test-only-password" });
  expect(mocks.replace).toHaveBeenCalledWith("/admin");
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(host.querySelector("button")!.disabled).toBe(false);
});

it("prevents duplicate submissions while sign-in is pending", async () => {
  let finish!: (value: { error: null }) => void;
  mocks.signIn.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fill();
  await act(async () => { submit(); submit(); });
  expect(mocks.signIn).toHaveBeenCalledOnce();
  await act(async () => finish({ error: null }));
  expect(mocks.replace).toHaveBeenCalledOnce();
});

it("shows a safe authentication error and allows retry without navigating", async () => {
  mocks.signIn.mockResolvedValue({ error: { message: "internal provider detail" } });
  fill();
  await act(async () => submit());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Check your email and password");
  expect(host.textContent).not.toContain("internal provider detail");
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(host.querySelector("button")!.disabled).toBe(false);
  mocks.signIn.mockResolvedValue({ error: null });
  await act(async () => submit());
  expect(mocks.replace).toHaveBeenCalledWith("/admin");
});

it("recovers from a network rejection", async () => {
  mocks.signIn.mockRejectedValue(new Error("network"));
  fill();
  await act(async () => submit());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(mocks.replace).not.toHaveBeenCalled();
});

it("shows access denied without the console and lets another owner sign in", async () => {
  await act(async () => root.render(<AdminEntry accessDenied />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("This account cannot open mission control");
  expect(host.textContent).not.toContain("Approval history");
  expect(host.querySelector('a[href="/forgot-password?next=%2Fadmin"]')).not.toBeNull();
  mocks.signIn.mockResolvedValue({ error: null });
  fill();
  await act(async () => submit());
  expect(mocks.replace).toHaveBeenCalledWith("/admin");
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("offers server sign-out with return to the dedicated admin entry", async () => {
  await act(async () => root.render(<AdminEntry accessDenied />));
  const form = host.querySelector<HTMLFormElement>('form[action="/auth/signout"]')!;
  expect(form.method).toBe("post");
  expect(form.querySelector<HTMLInputElement>('[name="next"]')?.value).toBe("/admin");
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.textContent).toContain("Sign out");
  expect(mocks.refresh).not.toHaveBeenCalled();
});
