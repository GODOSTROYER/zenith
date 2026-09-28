import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WaitlistQueue } from "@/app/admin/waitlist/waitlist-queue";
import type { WaitlistAdmissionBatch, WaitlistAdmissionPreview, WaitlistEntry } from "@/lib/waitlist/types";
import { WaitlistJoinForm } from "@/app/waitlist/waitlist-join-form";
import { AdminEntry } from "@/app/admin/admin-entry";
import AdminPage from "@/app/admin/page";
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
  id: `entry-${position}`, email: `builder${position}@example.test`, name: "", features: [], occupation: "Engineer",
  useCase: "Build a team deployment workflow", position, status,
  createdAt: "2026-09-26T10:00:00.000Z", admittedAt: status === "admitted" ? "2026-09-26T11:00:00.000Z" : null,
  admittedBy: status === "admitted" ? "operator" : null,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const queue = (entries: WaitlistEntry[], nextCursor: number | null = null) => json({ entries, total: 2, queued: 2, admitted: 0, nextCursor });
const PREVIEW_ID = "a736b7c6-1e6d-4836-8aa9-c8f5979c6aed";
const REQUEST_ID = "c81969c6-d906-4355-8135-477e6aad42df";
const STORAGE_KEY = "zenith:waitlist:pending-approval:operator";
const preview = (mode: WaitlistAdmissionPreview["mode"] = "next", count = 2, entries = [entry(1), entry(2)]): WaitlistAdmissionPreview => ({
  id: PREVIEW_ID, mode, count, entries, createdAt: "2026-09-28T10:00:00.000Z", expiresAt: "2026-09-28T10:15:00.000Z",
});
const historyBatch = (): WaitlistAdmissionBatch => ({
  requestId: REQUEST_ID, actorId: "operator", requestedCount: 2, admittedCount: 1,
  createdAt: "2026-09-28T10:01:00.000Z", mode: "selected",
});
const readResponse = (url: string, entries = [entry(1), entry(2)]) => url.startsWith("/api/admin/waitlist/history?") ? json({ batches: [] }) : queue(entries);
const requestsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => url === `/api/admin/waitlist/${path}`);
const requestBodies = (path: string) => requestsTo(path).map(([, options]) => JSON.parse(String(options.body)));
const button = (label: string, scope: ParentNode = document.body) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => !item.closest("[inert]") && (item.textContent?.trim() === label || item.getAttribute("aria-label") === label))!;
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(item => !item.closest("[inert]"))!;
const checkbox = (label: string) => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => [...(item.labels ?? [])].some(control => control.textContent === label))!;
const render = async (node: ReactNode) => act(async () => root.render(node));
const click = async (label: string, scope?: ParentNode) => act(async () => button(label, scope).click());
async function edit(selector: string, value: string) {
  await act(async () => {
    const control = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const input = (name: string, value: string) => edit(`[name="${name}"]`, value);

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

it("reviews every profile field and previews only that person before approval", async () => {
  const person = { ...entry(1), name: "Ada Builder", features: ["Deploy my app", "Team collaboration"] };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview("selected", 1, [person]));
    if (url.endsWith("/admit")) return json({ count: 1, requestId: requestBodies("admit").at(-1).requestId });
    return readResponse(url, [person, entry(2, "admitted")]);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Open details for builder1@example.test");
  const details = dialog();
  const fields = Object.fromEntries([...details.querySelectorAll("dl > div")].map(field => [field.querySelector("dt")?.textContent, field.querySelector("dd")?.textContent]));
  expect(fields).toMatchObject({
    "Email address": person.email, Name: person.name, Profession: person.occupation,
    "Feature interests": "Deploy my appTeam collaboration", "What they want to build": person.useCase,
  });
  expect(details.textContent).toContain("Queue position #1");
  expect(details.querySelector("time")?.dateTime).toBe(person.createdAt);
  await click("Approve this person", details);
  expect(requestBodies("preview")).toEqual([{ mode: "selected", entryIds: [person.id] }]);
  expect(requestsTo("admit")).toHaveLength(0);
  expect(dialog().textContent).toContain("Approve 1 person?");
  expect(dialog().textContent).toContain(person.email);
  await click("Confirm 1 person", dialog());
  expect(requestBodies("admit")).toEqual([{ previewId: PREVIEW_ID, requestId: expect.stringMatching(/^[\da-f-]{36}$/i) }]);
  expect(host.textContent).toContain("1 person approved");
  expect(host.textContent).toContain("No email was sent automatically");
  expect(dialog()).toBeUndefined();
  await click("Open details for builder2@example.test");
  expect(dialog().textContent).toContain("Access approved");
  expect(button("Approve this person", dialog())).toBeUndefined();
});

it("selects queued people across pages and previews the explicit selection", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview("selected", 2, [entry(1), entry(3)]));
    if (url.includes("history?")) return json({ batches: [] });
    if (url.includes("after=2")) return queue([entry(3)]);
    return queue([entry(1), entry(2, "admitted")], 2);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  expect(button("Approve selected").disabled).toBe(true);
  expect(checkbox("Select builder2@example.test")).toBeUndefined();
  await act(async () => checkbox("Select queued people on this page").click());
  expect(host.textContent).toContain("1 selected");
  await click("Next");
  await act(async () => checkbox("Select builder3@example.test").click());
  expect(host.textContent).toContain("2 selected");
  await click("Approve selected");
  expect(requestBodies("preview")).toEqual([{ mode: "selected", entryIds: ["entry-1", "entry-3"] }]);
  expect(requestsTo("admit")).toHaveLength(0);
  await click("Cancel", dialog());
  expect(dialog()).toBeUndefined();
  expect(requestsTo("admit")).toHaveLength(0);
  await click("Clear");
  expect(host.textContent).toContain("0 selected");
  expect(button("Approve selected").disabled).toBe(true);
});

it.each([
  { action: "Approve top 50", selection: { mode: "next", count: 50 }, exactCount: 2 },
  { action: "Approve next", selection: { mode: "next", count: 17 }, exactCount: 2 },
  { action: "Approve all", selection: { mode: "all" }, exactCount: 1005 },
])("$action reviews the server's exact count before changing access", async ({ action, selection, exactCount }) => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview(selection.mode as WaitlistAdmissionPreview["mode"], exactCount));
    if (url.endsWith("/admit")) return json({ count: exactCount, requestId: requestBodies("admit").at(-1).requestId });
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await edit('[aria-label="Search waitlist"]', "Ada");
  await click("Search");
  if (action === "Approve next") await edit('[aria-label="Custom batch size"]', "17");
  await click(action);
  expect(requestBodies("preview")).toEqual([selection]);
  expect(requestsTo("admit")).toHaveLength(0);
  expect(dialog().textContent).toContain("Approve " + exactCount.toLocaleString() + " people?");
  expect(dialog().textContent).toContain("Later signups will not be included");
  if (exactCount > 2) expect(dialog().textContent).toContain("Showing the first 2 of 1,005 people");
  await click("Confirm " + exactCount.toLocaleString() + " people", dialog());
  expect(requestBodies("admit")).toEqual([{ previewId: PREVIEW_ID, requestId: expect.any(String) }]);
  expect(host.textContent).toContain(exactCount.toLocaleString() + " people approved");
});

it("keeps one preview and one approval in flight despite duplicate clicks", async () => {
  let finishPreview!: (response: Response) => void;
  let finishApproval!: (response: Response) => void;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return new Promise<Response>(resolve => { finishPreview = resolve; });
    if (url.endsWith("/admit")) return new Promise<Response>(resolve => { finishApproval = resolve; });
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await act(async () => { button("Approve top 50").click(); button("Approve all").click(); });
  expect(requestsTo("preview")).toHaveLength(1);
  expect(button("Approve all").disabled).toBe(true);
  await act(async () => finishPreview(json(preview())));
  const confirm = button("Confirm 2 people", dialog());
  await act(async () => { confirm.click(); confirm.click(); });
  expect(requestsTo("admit")).toHaveLength(1);
  expect(button("Retry same approval", dialog()).disabled).toBe(true);
  expect(button("Cancel", dialog()).disabled).toBe(true);
  await act(async () => finishApproval(json({ count: 2, requestId: requestBodies("admit")[0].requestId })));
  expect(host.textContent).toContain("2 people approved");
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/admin/waitlist/history?limit=50")).toHaveLength(2);
});

it("retries a lost response with the same preview and request before allowing a new approval", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview());
    if (url.endsWith("/admit")) {
      if (requestsTo("admit").length === 1) throw new Error("Connection lost");
      return json({ count: 1, requestId: requestBodies("admit").at(-1).requestId });
    }
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Approve top 50");
  await click("Confirm 2 people", dialog());
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(button("Cancel", dialog()).disabled).toBe(true);
  expect(button("Approve all").disabled).toBe(true);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await click("Close dialog", dialog());
  expect(dialog().textContent).toContain("awaiting confirmation");
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY)!)).toEqual({ ...requestBodies("admit")[0], count: 2, mode: "next" });
  await click("Retry same approval", dialog());
  expect(requestBodies("admit")[1]).toEqual(requestBodies("admit")[0]);
  expect(requestsTo("preview")).toHaveLength(1);
  expect(host.textContent).toContain("1 person had already been approved");
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(button("Approve all").disabled).toBe(false);
  await click("Approve top 50");
  await click("Confirm 2 people", dialog());
  expect(requestBodies("admit")[2].requestId).not.toBe(requestBodies("admit")[0].requestId);
});

it.each([
  { count: 2, requestId: REQUEST_ID },
  { unexpected: true },
])("restores an uncertain approval after a mismatched or malformed acknowledgement: %j", async acknowledgement => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview("all"));
    if (url.endsWith("/admit")) return requestsTo("admit").length === 1 ? json(acknowledgement) : json({ count: 2, requestId: requestBodies("admit").at(-1).requestId });
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Approve all");
  await click("Confirm 2 people", dialog());
  expect(dialog().textContent).toContain("Approval could not be confirmed");
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(<WaitlistQueue operatorId="operator" />);
  expect(host.textContent).toContain("Approval of 2 people is awaiting confirmation");
  expect(button("Approve top 50").disabled).toBe(true);
  await click("Retry same approval");
  expect(requestBodies("admit")[1]).toEqual(requestBodies("admit")[0]);
  expect(requestsTo("preview")).toHaveLength(1);
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
});

it.each([
  { previewId: "invalid", requestId: REQUEST_ID, count: 2, mode: "next" },
  { previewId: PREVIEW_ID, requestId: "invalid", count: 2, mode: "all" },
  { previewId: PREVIEW_ID, requestId: REQUEST_ID, count: -1, mode: "selected" },
  { previewId: PREVIEW_ID, requestId: REQUEST_ID, count: 2, mode: "invalid" },
])("ignores malformed saved approvals and keeps another operator's request isolated: %j", async saved => {
  const other = { previewId: PREVIEW_ID, requestId: REQUEST_ID, count: 2, mode: "all" };
  sessionStorage.setItem("zenith:waitlist:pending-approval:other-operator", JSON.stringify(other));
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  fetchMock.mockImplementation(async (url: string) => readResponse(url));
  await render(<WaitlistQueue operatorId="operator" />);
  expect(button("Approve top 50").disabled).toBe(false);
  expect(button("Retry same approval")).toBeUndefined();
  expect(JSON.parse(sessionStorage.getItem("zenith:waitlist:pending-approval:other-operator")!)).toEqual(other);
});

it("retains the exact in-memory retry when browser storage is unavailable", async () => {
  for (const method of ["getItem", "setItem", "removeItem"] as const) vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error("Storage disabled"); });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview());
    if (url.endsWith("/admit")) {
      if (requestsTo("admit").length === 1) throw new Error("Response lost");
      return json({ count: 2, requestId: requestBodies("admit").at(-1).requestId });
    }
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Approve top 50");
  await click("Confirm 2 people", dialog());
  expect(dialog().textContent).toContain("Keep this page open until confirmed");
  await click("Retry same approval", dialog());
  expect(requestBodies("admit")[1]).toEqual(requestBodies("admit")[0]);
  expect(host.textContent).toContain("2 people approved");
});

it.each([
  { code: "preview_expired", message: "Review expired. Please review again." },
  { code: "conflict", message: "This preview has already been approved." },
])("recovers terminal preview conflicts without trapping a saved retry: %j", async error => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/preview")) return json(preview());
    if (url.endsWith("/admit")) return json({ error }, 409);
    return readResponse(url);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  await click("Approve top 50");
  await click("Confirm 2 people", dialog());
  expect(dialog()).toBeUndefined();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(error.message);
  expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(button("Approve all").disabled).toBe(false);
  await click("Approve all");
  expect(requestBodies("preview")).toEqual([{ mode: "next", count: 50 }, { mode: "all" }]);
});

it("loads cursor pages, resets selection and pagination for filters/search, and recovers list errors", async () => {
  let fail = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("history?")) return json({ batches: [] });
    if (fail) return json({ error: { message: "Temporary queue error" } }, 503);
    if (url.includes("status=admitted")) return queue([entry(2, "admitted")]);
    if (url.includes("q=Builder")) return json({ entries: [entry(2)], total: 2, queued: 2, admitted: 0, matched: 1, nextCursor: null });
    if (url.includes("after=1")) return queue([entry(2)]);
    return queue([entry(1)], 1);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  expect(button("Previous").disabled).toBe(true);
  await act(async () => checkbox("Select builder1@example.test").click());
  await click("Next");
  expect(host.textContent).toContain("Page 2");
  expect(host.textContent).toContain("builder2@example.test");
  expect(host.textContent).not.toContain("builder1@example.test");
  await click("Approved");
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/waitlist?limit=25&status=admitted");
  expect(host.textContent).toContain("Page 1");
  expect(host.textContent).toContain("0 selected");
  await click("Everyone");
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/waitlist?limit=25");
  await click("Next");
  await act(async () => checkbox("Select builder2@example.test").click());
  await edit('[aria-label="Search waitlist"]', "  Builder  ");
  await click("Search");
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/waitlist?limit=25&q=Builder");
  expect(host.textContent).toContain("Page 1 · 1 matching people");
  expect(host.textContent).toContain("0 selected");
  fail = true;
  await click("Refresh");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Temporary queue error");
  expect(button("Approve top 50").disabled).toBe(true);
  fail = false;
  await click("Try again");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("builder2@example.test");
});

it("rejects invalid batch sizes and disables empty queues and empty preview confirmations", async () => {
  let emptyQueue = false;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("history?")) return json({ batches: [] });
    if (url.endsWith("/preview")) return json(preview("next", 0, []));
    return emptyQueue ? json({ entries: [], total: 0, queued: 0, admitted: 0, nextCursor: null }) : queue([entry(1)]);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  for (const value of ["1001", "1.5", "0", ""]) {
    await edit('[aria-label="Custom batch size"]', value);
    expect(button("Approve next").disabled).toBe(true);
  }
  expect(requestsTo("preview")).toHaveLength(0);
  await edit('[aria-label="Custom batch size"]', "1");
  expect(button("Approve next").disabled).toBe(false);
  await click("Approve next");
  expect(button("Confirm 0 people", dialog()).disabled).toBe(true);
  await click("Cancel", dialog());
  emptyQueue = true;
  await click("Refresh");
  expect(host.textContent).toContain("You’re all caught up");
  for (const label of ["Approve top 50", "Approve next", "Approve all"]) expect(button(label).disabled).toBe(true);
  expect(requestsTo("admit")).toHaveLength(0);
});

it("shows completed approval metadata and the actual people from its history detail", async () => {
  const batch = historyBatch();
  const approved = { ...entry(1, "admitted"), name: "Ada Builder" };
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/admin/waitlist/history/" + REQUEST_ID)) return json({ batch, entries: [approved], nextOffset: null });
    if (url.includes("history?")) return json({ batches: [batch] });
    return queue([entry(2)]);
  });
  await render(<WaitlistQueue operatorId="operator" />);
  const history = host.querySelector("#approval-history")!;
  expect(history.textContent).toContain("1 person approved");
  expect(history.textContent).toContain("Selected people · 2 people reviewed");
  expect(history.querySelector("time")?.dateTime).toBe(batch.createdAt);
  await click("View people", history);
  expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/admin/waitlist/history/" + REQUEST_ID + "?offset=0&limit=100");
  expect(dialog().textContent).toContain("People in this approval");
  expect(dialog().textContent).toContain(approved.name);
  expect(dialog().textContent).toContain(approved.email);
  expect(dialog().textContent).not.toContain("builder2@example.test");
  expect(dialog().textContent).toContain("Reference: " + REQUEST_ID);
  await click("Close", dialog());
  expect(dialog()).toBeUndefined();
});

it("submits the account email and answers, preserving retry after throttling", async () => {
  fetchMock.mockResolvedValueOnce(json({ error: { message: "Limited" } }, 429)).mockResolvedValueOnce(json({ accepted: true }, 202));
  await render(<WaitlistJoinForm email="builder@example.test" emailReadOnly />);
  expect(host.querySelector<HTMLInputElement>('[name="email"]')?.readOnly).toBe(true);
  await click("Other");
  expect(host.querySelector<HTMLInputElement>('[name="occupation"]')?.maxLength).toBe(120);
  await input("occupation", "  Engineer  ");
  await input("name", "  Builder  ");
  await click("Something else");
  await input("customFeature", "  Deploy team apps  ");
  await click("Join the waitlist");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("too many requests");
  expect(button("Join the waitlist").disabled).toBe(false);
  await click("Join the waitlist");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ email: "builder@example.test", name: "Builder", occupation: "Engineer", features: ["Deploy team apps"] });
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Your request has been received");
  expect(host.textContent).not.toMatch(/position|#\d/i);
});

it("accepts email alone, rejects invalid email, and exposes only optional profile choices", async () => {
  fetchMock.mockResolvedValue(json({ accepted: true }, 202));
  await render(<WaitlistJoinForm />);
  expect([...host.querySelectorAll<HTMLInputElement>("input[required]")].map(control => control.name)).toEqual(["email"]);
  await input("email", "invalid-email");
  await click("Join the waitlist");
  expect(fetchMock).not.toHaveBeenCalled();
  await input("email", "visitor@example.test");
  await click("Join the waitlist");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "visitor@example.test", name: "", occupation: "", features: [] });
  expect(document.activeElement).toBe(host.querySelector('[role="status"]'));
});

it("saves selected interests and prevents duplicate submissions while a request is in flight", async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  await render(<WaitlistJoinForm email="visitor@example.test" />);
  await click("Developer");
  await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await click("Join the waitlist");
  expect(button("Saving your place").disabled).toBe(true);
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ email: "visitor@example.test", name: "", occupation: "Developer", features: ["Deploy my app"] });
  await act(async () => finish(json({ accepted: true }, 202)));
  expect(host.textContent).toContain("Your place is safe");
});

it("keeps intake public while requiring operator authorization for administration", async () => {
  auth.user = null;
  expect((await AdminPage()).type).toBe(AdminEntry);
  await expect(WaitlistAdminPage()).rejects.toThrow("redirect:/admin");
  await render(await WaitlistPage({}));
  expect(host.querySelector<HTMLInputElement>('[name="email"]')?.readOnly).toBe(false);
  auth.user = { id: "member", email: "member@example.test", name: "Member" };
  auth.operator = false;
  const denied = await AdminPage();
  expect(denied.type).toBe(AdminEntry);
  expect(denied.props).toMatchObject({ accessDenied: true });
  await expect(WaitlistAdminPage()).rejects.toThrow("redirect:/admin");
  auth.operator = true;
  const owner = await AdminPage();
  expect(owner.type).not.toBe(AdminEntry);
  expect(owner.props.children.props.operatorId).toBe("member");
  await expect(WaitlistAdminPage()).rejects.toThrow("redirect:/admin#waitlist");
});

it("sends admitted users to the auth continuation and pauses intake without losing the recheck action", async () => {
  auth.allowed = true;
  await expect(WaitlistPage({})).rejects.toThrow("redirect:/auth/continue");
  auth.allowed = false;
  auth.enabled = false;
  await render(await WaitlistPage({}));
  expect(host.textContent).toContain("New waitlist requests are paused");
  expect(host.querySelector('a[href="/auth/continue"]')?.textContent).toContain("Check your access again");
  expect(host.querySelector('form[action="/auth/signout"]')).not.toBeNull();
  expect(host.querySelector('[name="occupation"]')).toBeNull();
});

it("preserves safe invitation continuations and prevents waitlist redirect loops", async () => {
  const next = "/apps/accept?token=invite";
  auth.user = null;
  await render(await WaitlistPage({ searchParams: Promise.resolve({ next }) }));
  expect(host.querySelector('a[href^="/login"]')?.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(next)}`);
  auth.user = { id: "member", email: "member@example.test", name: "Member" };
  auth.allowed = true;
  await expect(WaitlistPage({ searchParams: Promise.resolve({ next }) })).rejects.toThrow(`redirect:/auth/continue?next=${encodeURIComponent(next)}`);
  await expect(WaitlistPage({ searchParams: Promise.resolve({ next: "/waitlist?next=/overview" }) })).rejects.toThrow("redirect:/auth/continue");
  await expect(WaitlistPage({ searchParams: Promise.resolve({ next: "https://other.example" }) })).rejects.toThrow("redirect:/auth/continue");
});



it("offers only sign-in after joining while preserving an invitation", async () => {
  fetchMock.mockResolvedValue(json({ accepted: true }, 202));
  const next = "/invite?invite=workspace-token";
  await render(<WaitlistJoinForm email="visitor@example.test" next={next} />);
  await click("Join the waitlist");
  expect(host.querySelector('a[href^="/login"]')?.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(next)}`);
  expect(host.querySelector('a[href^="/signup"]')).toBeNull();
  expect(host.textContent).not.toContain("create an account");
});
