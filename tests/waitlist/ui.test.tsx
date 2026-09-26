import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WaitlistQueue } from "@/app/admin/waitlist/waitlist-queue";
import type { WaitlistEntry } from "@/lib/waitlist/types";
import { WaitlistJoinForm } from "@/app/waitlist/waitlist-join-form";
import WaitlistAdminPage from "@/app/admin/waitlist/page";
import WaitlistPage from "@/app/waitlist/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({
  user: { id: "operator", email: "builder@example.test", name: "Builder" } as { id: string; email: string; name: string } | null,
  operator: true,
  allowed: false,
  enabled: true,
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => auth.user }));
vi.mock("@/lib/waitlist/access", () => ({
  isWaitlistOperator: () => auth.operator,
  getWaitlistAccess: async () => ({ allowed: auth.allowed, reason: auth.allowed ? "admitted" : "waiting" }),
}));
vi.mock("@/lib/waitlist/config", () => ({ waitlistEnabled: () => auth.enabled }));
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => { throw new Error(`redirect:${destination}`); },
  notFound: () => { throw new Error("not-found"); },
}));

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();
const entry = (position: number, status: WaitlistEntry["status"] = "queued"): WaitlistEntry => ({
  id: `entry-${position}`, email: `builder${position}@example.test`, occupation: "Engineer",
  useCase: "Build a team deployment workflow", position, status,
  createdAt: "2026-09-26T10:00:00.000Z", admittedAt: status === "admitted" ? "2026-09-26T11:00:00.000Z" : null,
  admittedBy: status === "admitted" ? "operator" : null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const queue = (entries: WaitlistEntry[], nextCursor: number | null = null) => json({ entries, total: 2, queued: 2, admitted: 0, nextCursor });
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
const render = async (node: ReactNode) => act(async () => root.render(node));
const click = async (label: string) => act(async () => button(label).click());
async function input(name: string, value: string) {
  await act(async () => {
    const control = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  auth.user = { id: "operator", email: "builder@example.test", name: "Builder" };
  auth.operator = true;
  auth.allowed = false;
  auth.enabled = true;
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retries an unconfirmed admission with the same batch key before allowing a new batch", async () => {
  const batches: Array<{ count: number; requestId: string }> = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.includes("/admit")) {
      batches.push(JSON.parse(String(options?.body)));
      if (batches.length === 1) throw new Error("Connection lost");
      return json({ admitted: [entry(1, "admitted")], count: 1 });
    }
    return queue([entry(1), entry(2)]);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  expect(host.textContent).toContain("Build a team deployment workflow");
  await click("Admit next 100");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(host.querySelector<HTMLInputElement>('[name="count"]')?.disabled).toBe(true);
  await click("Retry batch of 100");
  expect(batches).toHaveLength(2);
  expect(batches[0]).toEqual(batches[1]);
  expect(batches[0].count).toBe(100);
  expect(batches[0].requestId).toMatch(/^[\da-f-]{36}$/i);
  expect(host.textContent).toContain("1 person admitted");
  expect(host.textContent).toContain("No notification emails were sent");
  expect(host.querySelector<HTMLInputElement>('[name="count"]')?.disabled).toBe(false);
  await input("count", "25");
  await click("Admit next 25");
  expect(batches[2].count).toBe(25);
  expect(batches[2].requestId).not.toBe(batches[0].requestId);
});

it("loads cursor pages, resets pagination when filtering, and recovers a list error", async () => {
  let fail = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (fail) return json({ error: { message: "Temporary queue error" } }, 503);
    if (url.includes("status=admitted")) return queue([entry(2, "admitted")]);
    if (url.includes("after=1")) return queue([entry(2)]);
    return queue([entry(1)], 1);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  expect(button("Previous").disabled).toBe(true);
  await click("Next");
  expect(host.textContent).toContain("Page 2");
  expect(host.textContent).toContain("builder2@example.test");
  expect(host.textContent).not.toContain("builder1@example.test");
  await click("Admitted");
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/waitlist?status=admitted&limit=100");
  expect(host.textContent).toContain("Page 1");
  fail = true;
  await click("Refresh");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Temporary queue error");
  expect(button("Admit next 100").disabled).toBe(true);
  fail = false;
  await click("Try loading again");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("builder2@example.test");
});

it("disables out-of-range batches and admission for an empty queue", async () => {
  fetchMock.mockResolvedValue(queue([entry(1)]));
  await render(<WaitlistQueue operatorId="operator" />);
  await input("count", "1001");
  expect(button("Admit next batch").disabled).toBe(true);
  await input("count", "1.5");
  expect(button("Admit next batch").disabled).toBe(true);
  await input("count", "1");
  expect(button("Admit next 1").disabled).toBe(false);
  fetchMock.mockResolvedValue(json({ entries: [], total: 0, queued: 0, admitted: 0, nextCursor: null }));
  await click("Refresh");
  expect(host.textContent).toContain("The queue is empty");
  expect(button("Admit next 1").disabled).toBe(true);
});

it("submits the account email and answers, preserving retry after throttling", async () => {
  fetchMock.mockResolvedValueOnce(json({ error: { message: "Limited" } }, 429)).mockResolvedValueOnce(json({ accepted: true }, 202));
  await render(<WaitlistJoinForm email="builder@example.test" />);
  expect(host.querySelector<HTMLInputElement>('[name="email"]')?.readOnly).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[name="occupation"]')?.maxLength).toBe(120);
  await input("occupation", "  Engineer  ");
  await input("useCase", "  Deploy team apps  ");
  await click("Join the waitlist");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Too many requests");
  expect(button("Join the waitlist").disabled).toBe(false);
  await click("Join the waitlist");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ email: "builder@example.test", occupation: "Engineer", useCase: "Deploy team apps" });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Your request has been received");
  expect(host.textContent).not.toMatch(/position|#\d|admitted/i);
});

it("requires a session for both pages and operator authorization for administration", async () => {
  auth.user = null;
  await expect(WaitlistAdminPage()).rejects.toThrow("redirect:/login?next=/admin/waitlist");
  await expect(WaitlistPage()).rejects.toThrow("redirect:/login?next=/waitlist");
  auth.user = { id: "member", email: "member@example.test", name: "Member" };
  auth.operator = false;
  await expect(WaitlistAdminPage()).rejects.toThrow("not-found");
  auth.operator = true;
  await expect(WaitlistAdminPage()).resolves.toBeTruthy();
});

it("sends admitted users to the auth continuation and pauses intake without losing the recheck action", async () => {
  auth.allowed = true;
  await expect(WaitlistPage()).rejects.toThrow("redirect:/auth/continue");
  auth.allowed = false;
  auth.enabled = false;
  await render(await WaitlistPage());
  expect(host.textContent).toContain("New waitlist requests are currently paused");
  expect(host.querySelector('a[href="/waitlist"]')?.textContent).toBe("Check access again");
  expect(host.querySelector('form[action="/auth/signout"]')).not.toBeNull();
  expect(host.querySelector('[name="occupation"]')).toBeNull();
});


it("restores an unconfirmed batch after remount and clears it only after confirmed success", async () => {
  const batches: Array<{ count: number; requestId: string }> = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (!url.includes("/admit")) return queue([entry(1)]);
    batches.push(JSON.parse(String(options?.body)));
    if (batches.length === 1) throw new Error("Response lost");
    return json({ admitted: [entry(1, "admitted")], count: 1 });
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await input("count", "20");
  await click("Admit next 20");
  expect(JSON.parse(sessionStorage.getItem("zenith:waitlist:pending-admission:operator")!)).toEqual(batches[0]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(<WaitlistQueue operatorId="operator" />);
  expect(host.querySelector<HTMLInputElement>('[name="count"]')?.value).toBe("20");
  await click("Retry batch of 20");
  expect(batches[1]).toEqual(batches[0]);
  expect(sessionStorage.getItem("zenith:waitlist:pending-admission:operator")).toBeNull();
});

it("ignores another operator's pending batch and rejects malformed stored requests", async () => {
  const batch = { count: 20, requestId: "c81969c6-d906-4355-8135-477e6aad42df" };
  sessionStorage.setItem("zenith:waitlist:pending-admission:other-operator", JSON.stringify(batch));
  sessionStorage.setItem("zenith:waitlist:pending-admission:operator", JSON.stringify({ ...batch, count: 1001 }));
  fetchMock.mockResolvedValue(queue([entry(1)]));
  await render(<WaitlistQueue operatorId="operator" />);
  expect(button("Admit next 100").disabled).toBe(false);
  expect(host.textContent).not.toContain("Retry batch");
  expect(JSON.parse(sessionStorage.getItem("zenith:waitlist:pending-admission:other-operator")!)).toEqual(batch);
});


it("retains the in-memory retry if browser storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  const batches: string[] = [];
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (!url.includes("/admit")) return queue([entry(1)]);
    batches.push(String(options?.body));
    if (batches.length === 1) throw new Error("Response lost");
    return json({ admitted: [entry(1, "admitted")], count: 1 });
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Admit next 100");
  expect(host.textContent).toContain("Keep this page open until the batch is confirmed");
  await click("Retry batch of 100");
  expect(batches[1]).toBe(batches[0]);
  expect(host.textContent).toContain("1 person admitted");
});
