/**
 * The agent integrations screen.
 *
 * Two things were wrong with it and both are structural rather than cosmetic.
 * It rendered its own `<main>` inside the product layout's, so the page had two
 * main landmarks and "skip to content" stopped meaning one place. And it was
 * hand-rolled from raw utility classes — including one (`text-muted-foreground`)
 * this product never defined, so the text it was meant to quieten rendered at
 * full strength. What it approves is a security decision, so the refusals, the
 * waiting and the reasons a control is off all have to survive a rewrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import IntegrationControl from "@/app/(product)/integrations/integration-control";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hour = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const PREPARED = {
  id: "op_ready",
  digest: "a".repeat(64),
  action: "deployment.deploy",
  subject: "u1",
  phase: "prepared",
  expiresAt: hour(6),
  target: { projectId: "p1", environmentId: "e1" },
  plan: { summary: "Deploy Atlas to Development", details: ["1 service changed"], approvalRole: "editor" },
};
const EXPIRED = {
  ...PREPARED,
  id: "op_stale",
  digest: "b".repeat(64),
  expiresAt: hour(-1),
  plan: { ...PREPARED.plan, summary: "Deploy Atlas to Production" },
};
const ADMIN_ONLY = {
  ...PREPARED,
  id: "op_admin",
  digest: "c".repeat(64),
  plan: { ...PREPARED.plan, summary: "Promote to Production", approvalRole: "admin" },
};
const BLOCKED = {
  ...PREPARED,
  id: "op_blocked",
  digest: "d".repeat(64),
  plan: { ...PREPARED.plan, summary: "Deploy without a connection", blocked: "No cloud connection." },
};

const GRANT = {
  clientId: "client-one",
  projectIds: ["p1"],
  appIds: [],
  scopes: ["read", "plan"],
  expiresAt: hour(24),
};

const baseState = (over: Record<string, unknown> = {}) => ({
  workspaceId: "w1",
  subject: "u1",
  role: "admin",
  resource: "https://zenith.test/api/agent/v2/mcp",
  oauthConfigured: true,
  projects: [{ id: "p1", name: "Atlas" }],
  grants: [GRANT],
  operations: [PREPARED],
  ...over,
});

let root: Root;
let host: HTMLDivElement;
let sent: { url: string; method: string; body: unknown }[];
let state: Record<string, unknown>;
/** what the next mutation replies with; `undefined` means "accepted" */
let refuse: string | undefined;

beforeEach(() => {
  sent = [];
  state = baseState();
  refuse = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") return { ok: true, status: 200, json: async () => state };
      if (refuse)
        return { ok: false, status: 403, json: async () => ({ error: { message: refuse } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    })
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Rendered the way the product layout renders it: inside the one `<main>`. */
async function renderInLayout() {
  await act(async () =>
    root.render(
      <main id="main">
        <IntegrationControl />
      </main>
    )
  );
  await settle();
}

const button = (label: string | RegExp) =>
  [...host.querySelectorAll("button")].find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")
  );
const card = (id: string) => host.querySelector(`#${id}`)!.closest("section")!;
const press = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};

describe("landmarks and headings", () => {
  it("adds no second main landmark inside the layout's", async () => {
    await renderInLayout();
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(host.querySelector("main")!.id).toBe("main");
  });

  it("starts at h1 and steps down without skipping a level", async () => {
    await renderInLayout();
    const levels = [...host.querySelectorAll("h1,h2,h3")].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  });

  it("names each region, so the screen is navigable by landmark", async () => {
    await renderInLayout();
    const named = [...host.querySelectorAll("section[aria-labelledby]")].map(
      (s) => host.querySelector(`#${s.getAttribute("aria-labelledby")}`)?.textContent
    );
    expect(named).toEqual([
      "Connect an OAuth client",
      "Authorized clients",
      "Proposals awaiting review",
    ]);
  });
});

describe("reviewing a proposal", () => {
  it("sends exactly the review payload the API expects, and nothing else", async () => {
    await renderInLayout();
    await press(button("Approve exact proposal")!);
    const post = sent.find((r) => r.method === "POST")!;
    expect(post.url).toBe("/api/integrations/agent/review");
    expect(post.body).toEqual({ operationId: "op_ready", digest: PREPARED.digest, approve: true });
  });

  it("rejects through the same endpoint with approve:false", async () => {
    await renderInLayout();
    await press(button("Reject")!);
    expect(sent.find((r) => r.method === "POST")!.body).toEqual({
      operationId: "op_ready",
      digest: PREPARED.digest,
      approve: false,
    });
  });

  it("moves focus to the outcome, because the control it came from is gone", async () => {
    await renderInLayout();
    const approve = button("Approve exact proposal")!;
    approve.focus();
    state = baseState({ operations: [] }); // approved proposals leave the queue
    await press(approve);
    const notice = document.activeElement as HTMLElement;
    expect(notice.textContent).toContain("Exact proposal approved");
    expect(notice.tabIndex).toBe(-1);
  });

  it("keeps a refusal on screen until it is dismissed", async () => {
    await renderInLayout();
    refuse = "Approval is not allowed from this account.";
    await press(button("Approve exact proposal")!);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Approval is not allowed from this account.");

    // still there after an unrelated re-render
    await press(button(/Refresh status/)!);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("not allowed");

    await press(button("Dismiss")!);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("says a control is working rather than only looking disabled", async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => (release = r));
    (fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return { ok: true, status: 200, json: async () => state };
        await pending;
        return { ok: true, status: 200, json: async () => ({}) };
      }
    );
    await renderInLayout();
    const approve = button("Approve exact proposal")!;
    await act(async () => approve.click());
    expect(approve.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector('[aria-busy="true"].product-page')).not.toBeNull();
    await act(async () => {
      release(undefined);
      await settle();
    });
  });
});

describe("controls that are off say why, in text", () => {
  it("states the expiry in the page, not only in a tooltip", async () => {
    state = baseState({ operations: [EXPIRED] });
    await renderInLayout();
    const approve = [...card("op_stale").querySelectorAll("button")].find(
      (b) => b.textContent === "Approve exact proposal"
    )!;
    expect(approve.disabled).toBe(true);
    expect(card("op_stale").textContent).toMatch(/expired, so it can no longer be approved/i);
    expect(approve.getAttribute("title")).toMatch(/expired/i);
  });

  it("states that an admin has to approve this one", async () => {
    state = baseState({ role: "editor", operations: [ADMIN_ONLY] });
    await renderInLayout();
    expect(card("op_admin").textContent).toMatch(/needs an admin's approval/i);
  });

  it("states what blocks a blocked proposal, and refuses approval", async () => {
    state = baseState({ operations: [BLOCKED] });
    await renderInLayout();
    const approve = [...card("op_blocked").querySelectorAll("button")].find(
      (b) => b.textContent === "Approve exact proposal"
    )!;
    expect(approve.disabled).toBe(true);
    expect(card("op_blocked").textContent).toContain("No cloud connection.");
  });

  it("explains a scope a viewer may not grant, and keeps read locked on", async () => {
    state = baseState({ role: "viewer" });
    await renderInLayout();
    const box = (label: string) =>
      [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (i) => host.querySelector(`label[for="${i.id}"]`)?.textContent === label
      )!;
    expect(box("read").disabled).toBe(true);
    expect(box("write").disabled).toBe(true);
    const described = host.querySelector(`#${box("write").getAttribute("aria-describedby")}`)!;
    expect(described.textContent).toMatch(/viewer, so you cannot grant it/i);
  });

  it("will not authorize a grant with no project chosen, and says so", async () => {
    await renderInLayout();
    const authorize = button("Authorize selected access")!;
    expect(authorize.disabled).toBe(true);
    expect(host.textContent).toMatch(/Choose at least one project/);
  });
});

describe("revoking a client", () => {
  it("sends the grant back unchanged apart from the revocation", async () => {
    await renderInLayout();
    await press(button("Revoke")!);
    const post = sent.find((r) => r.method === "POST")!;
    expect(post.url).toBe("/api/integrations/agent/grants");
    expect(post.body).toEqual({
      clientId: "client-one",
      projectIds: ["p1"],
      environmentIds: undefined,
      appIds: [],
      scopes: ["read", "plan"],
      days: 1,
      revoked: true,
    });
  });

  it("turns the control off once there is nothing left to withdraw", async () => {
    state = baseState({ grants: [{ ...GRANT, revoked: true }] });
    await renderInLayout();
    const revoke = button("Revoke")!;
    expect(revoke.disabled).toBe(true);
    expect(revoke.getAttribute("title")).toMatch(/already revoked/i);
  });
});

describe("every control can be reached and named", () => {
  it("gives each button an accessible name and keeps it focusable", async () => {
    await renderInLayout();
    for (const b of host.querySelectorAll("button")) {
      const name = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
      expect(name.length).toBeGreaterThan(0);
      if (!b.disabled) {
        b.focus();
        expect(document.activeElement).toBe(b);
      }
    }
  });

  it("labels every form control", async () => {
    await renderInLayout();
    for (const input of host.querySelectorAll<HTMLInputElement>("input")) {
      const labelled =
        host.querySelector(`label[for="${input.id}"]`) ??
        (input.getAttribute("aria-labelledby")
          ? host.querySelector(`#${input.getAttribute("aria-labelledby")}`)
          : null);
      expect(labelled?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("says it is loading before the first answer arrives", async () => {
    (fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      () => new Promise(() => {})
    );
    await act(async () =>
      root.render(
        <main id="main">
          <IntegrationControl />
        </main>
      )
    );
    expect(host.querySelector('[role="status"]')!.getAttribute("aria-label")).toMatch(/loading/i);
  });

  it("offers a way back when the screen itself could not load", async () => {
    (fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "Store offline." } }) })
    );
    await renderInLayout();
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Store offline.");
    expect(button("Try again")).toBeTruthy();
  });
});
