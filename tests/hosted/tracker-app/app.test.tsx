/**
 * The whole screen, rendered against the in-memory broker.
 *
 * These are the moments a customer actually feels: the list arriving, a save
 * that says "saving" until the server answers and only then says "saved", two
 * people editing the same row, an access level that offers nothing it cannot
 * do, and a keyboard that can get out of the drawer it got into.
 *
 * No testing library: react-dom/client, act, and the DOM the app really
 * renders.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../../fixtures/tracker-app/src/app";
import { configureApi, resetApi } from "../../../fixtures/tracker-app/src/api";
import { makeBroker, seedRecord, type Broker, type BrokerOptions } from "./broker";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;
let broker: Broker;
let minted = 0;
let noise: string[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function show(options: BrokerOptions = {}): Promise<Broker> {
  broker = makeBroker(options);
  configureApi({
    fetch: broker.fetch,
    sleep: async () => {},
    navigate: () => {},
    newWriteId: () => {
      minted += 1;
      return `write-${minted}`;
    },
  });
  await act(async () => {
    root.render(<App />);
  });
  await settle();
  return broker;
}

const text = (): string => host.textContent ?? "";

function all<T extends Element>(selector: string): T[] {
  return Array.from(host.querySelectorAll<T>(selector));
}

function one<T extends Element>(selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error(`no element matched ${selector}`);
  return found;
}

function findButton(label: string): HTMLButtonElement | null {
  return (
    all<HTMLButtonElement>("button").find((node) => (node.textContent ?? "").trim() === label) ??
    null
  );
}

function button(label: string): HTMLButtonElement {
  const found = findButton(label);
  if (!found) {
    throw new Error(
      `no button labelled "${label}"; saw ${all<HTMLButtonElement>("button")
        .map((node) => `"${(node.textContent ?? "").trim()}"`)
        .join(", ")}`
    );
  }
  return found;
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    (node as HTMLElement).click();
  });
  await settle();
}

function setValue(node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function type(selector: string, value: string): Promise<void> {
  await act(async () => {
    setValue(one<HTMLInputElement>(selector), value);
  });
  await settle();
}

async function press(node: Element, key: string): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  minted = 0;
  noise = [];
  for (const level of ["error", "warn"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      noise.push(`${level}: ${args.map(String).join(" ")}`);
    });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  resetApi();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const seen = [...noise];
  vi.restoreAllMocks();
  // Every screen in this file must render without a single console complaint.
  expect(seen).toEqual([]);
});

describe("the list", () => {
  it("shows what the host returned, newest first, with the release in the footer", async () => {
    await show({
      seed: [
        seedRecord(1, { title: "Second monitor" }),
        seedRecord(2, { title: "Standing desk", status: "approved" }),
      ],
    });

    const titles = all(".row-title").map((node) => node.textContent);
    expect(titles).toEqual(["Standing desk", "Second monitor"]);
    expect(text()).toContain("release rel_2026090701");
    expect(text()).toContain("Approved");
    expect(one(".footer").textContent).toContain("schema v1");
  });

  it("pages with the cursor the host gave it", async () => {
    const seed = Array.from({ length: 30 }, (_, i) => seedRecord(i + 1));
    await show({ seed });

    expect(all(".row-title")).toHaveLength(25);
    await click(button("Load more"));
    expect(all(".row-title")).toHaveLength(30);
    expect(findButton("Load more")).toBeNull();
  });

  it("re-reads the list when a filter changes", async () => {
    await show({
      seed: [
        seedRecord(1, { title: "Second monitor" }),
        seedRecord(2, { title: "Standing desk", status: "approved" }),
      ],
    });

    await act(async () => {
      setValue(one<HTMLSelectElement>("#filter-status"), "approved");
    });
    await settle();

    expect(all(".row-title").map((node) => node.textContent)).toEqual(["Standing desk"]);
    const last = broker.calls.filter((call) => call.method === "GET").at(-1);
    expect(last?.path).toContain("status=approved");
  });

  it("says so when there is nothing to show", async () => {
    await show({ seed: [] });
    expect(text()).toContain("No requests yet");
  });
});

describe("creating a request", () => {
  it("stays pending until the host answers, then says saved", async () => {
    await show({ seed: [seedRecord(1)] });

    await click(button("New request"));
    await type("#new-title", "Docking station");
    await type("#new-requested-for", "Priya");

    const release = broker.hold();
    await click(button("Add request"));

    expect(findButton("Saving\u2026")?.disabled).toBe(true);
    expect(text()).toContain("Saving your request");
    expect(text()).not.toContain("Request saved.");
    expect(broker.records.map((item) => item.title)).not.toContain("Docking station");

    await act(async () => {
      release();
    });
    await settle();

    expect(text()).toContain("Request saved.");
    expect(all(".row-title").map((node) => node.textContent)).toContain("Docking station");
    expect(broker.records.map((item) => item.title)).toContain("Docking station");
    expect((one("#new-title") as HTMLInputElement).value).toBe("");
  });

  it("checks the limits before sending anything", async () => {
    await show({ seed: [] });
    await click(button("New request"));
    await click(button("Add request"));

    expect(text()).toContain("Give the request a short title.");
    expect(broker.calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("two people editing the same request", () => {
  it("keeps the draft, shows what changed, and re-bases on demand", async () => {
    await show({ seed: [seedRecord(1, { title: "Laptop for Priya" })] });

    await click(one(".row-button"));
    await type("#edit-title", "Laptop for Priya, 16in");

    broker.editElsewhere("req-1", { status: "approved" });

    await click(button("Save changes"));

    expect(text()).toContain("Someone changed this while you were editing");
    expect((one("#edit-title") as HTMLInputElement).value).toBe("Laptop for Priya, 16in");
    const conflictRow = one(".conflict-table tbody tr");
    expect(conflictRow.textContent).toContain("Status");
    expect(conflictRow.textContent).toContain("Approved");
    expect(conflictRow.textContent, "a field this person never touched is not claimed as theirs").toContain(
      "Not changed by you"
    );
    expect(broker.records[0].title).toBe("Laptop for Priya");

    const before = [...broker.writeIds];
    await click(button("Reload and keep my edits"));

    expect(text()).toContain("Changes saved.");
    expect(text()).not.toContain("Someone changed this while you were editing");
    expect(broker.writeIds).toHaveLength(before.length + 1);
    expect(broker.writeIds.at(-1), "a re-based write is a new intent").not.toBe(before.at(-1));
    expect(broker.records[0].title, "the draft survived").toBe("Laptop for Priya, 16in");
    expect(broker.records[0].status, "the other edit survived").toBe("approved");
    expect(
      one<HTMLSelectElement>("#edit-status").value,
      "the form is re-read from the version that committed"
    ).toBe("approved");

    // A second save must not quietly push the stale draft value back.
    await type("#edit-requested-for", "Priya Raman");
    await click(button("Save changes"));
    expect(broker.records[0].status).toBe("approved");
    expect(broker.records[0].requestedFor).toBe("Priya Raman");
  });

  it("can drop the draft and take the version the host holds", async () => {
    await show({ seed: [seedRecord(1, { title: "Laptop for Priya" })] });

    await click(one(".row-button"));
    await type("#edit-title", "Laptop for Priya, 16in");
    broker.editElsewhere("req-1", { title: "Laptop for Priya (approved)", status: "approved" });
    await click(button("Save changes"));

    await click(button("Discard my edits"));

    expect((one("#edit-title") as HTMLInputElement).value).toBe("Laptop for Priya (approved)");
    expect(text()).not.toContain("Someone changed this while you were editing");
    expect(broker.records[0].version).toBe(2);
  });
});

describe("what each role is offered", () => {
  it("offers a viewer nothing it cannot do, and says why", async () => {
    await show({ role: "viewer", seed: [seedRecord(1)] });

    expect(findButton("New request")).toBeNull();
    expect(text()).toContain("Your access is view-only");

    await click(one(".row-button"));
    const save = button("Save changes");
    expect(save.disabled).toBe(true);
    expect(save.title).toContain("view-only");
    expect(one<HTMLInputElement>("#edit-title").disabled).toBe(true);
  });

  it("shows the removed-access state when a read is refused", async () => {
    broker = makeBroker({ seed: [seedRecord(1)] });
    broker.refuseNext(/data\/v1\/requests/, 403, "forbidden", "That grant was revoked.");
    configureApi({ fetch: broker.fetch, sleep: async () => {}, navigate: () => {} });
    await act(async () => {
      root.render(<App />);
    });
    await settle();

    expect(text()).toContain("Your access to this app was removed");
    expect(one<HTMLAnchorElement>("a.link").getAttribute("href")).toBe("/_zenith/auth/signin");
    expect(findButton("New request")).toBeNull();
  });

  it("offers a retry when the host is not answering", async () => {
    broker = makeBroker({ seed: [seedRecord(1, { title: "Second monitor" })] });
    broker.refuseNext(/data\/v1\/requests/, 503, "runtime_unavailable", "Not answering.", 3);
    configureApi({ fetch: broker.fetch, sleep: async () => {}, navigate: () => {} });
    await act(async () => {
      root.render(<App />);
    });
    await settle();

    expect(text()).toContain("The host is not answering");
    await click(button("Try again"));
    expect(text()).toContain("Second monitor");
  });
});

describe("the keyboard", () => {
  it("opens the drawer on the close control, and Escape gives focus back to the row", async () => {
    await show({ seed: [seedRecord(1, { title: "Laptop for Priya" })] });

    const trigger = one<HTMLButtonElement>(".row-button");
    await click(trigger);

    const drawer = one("[role='dialog']");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.getAttribute("aria-labelledby")).toBe("drawer-title");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close request details");

    await press(document.activeElement ?? drawer, "Escape");

    expect(host.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Tab inside the drawer", async () => {
    await show({ seed: [seedRecord(1)] });
    await click(one(".row-button"));

    const drawer = one<HTMLElement>("[role='dialog']");
    const focusable = Array.from(
      drawer.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    await press(last, "Tab");
    expect(document.activeElement).toBe(focusable[0]);

    await press(focusable[0], "Tab");
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("labels every control it renders", async () => {
    await show({ seed: [seedRecord(1)] });
    await click(button("New request"));

    for (const control of all<HTMLElement>("input, select, textarea")) {
      const id = control.getAttribute("id");
      expect(id, "every control needs an id to be labelled").toBeTruthy();
      const label = host.querySelector(`label[for="${id}"]`);
      expect(label, `no label for #${id}`).not.toBeNull();
    }
  });

  it("counts down the characters left in a bounded field", async () => {
    await show({ seed: [] });
    await click(button("New request"));
    expect(one(".field-counter").textContent).toBe("120 left");
    await type("#new-title", "Docking station");
    expect(one(".field-counter").textContent).toBe("105 left");
  });
});

describe("leaving", () => {
  it("ends the session with the host and stops offering the app", async () => {
    await show({ seed: [seedRecord(1)] });

    await click(button("Sign out"));

    expect(broker.calls.some((call) => call.path === "/_zenith/auth/signout")).toBe(true);
    expect(text()).toContain("You are signed out");
    expect(findButton("Sign out")).toBeNull();
    expect(one<HTMLAnchorElement>("a.link").getAttribute("href")).toBe("/_zenith/auth/signin");
  });
});
