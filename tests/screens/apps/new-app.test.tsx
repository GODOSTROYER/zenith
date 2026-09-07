/**
 * Creating an app: the URL name rule has to be readable before the button is
 * pressed, and a reserved name has to say it is reserved.
 *
 * Workstream W9 (hosted R3)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/toast";
import { deriveSlug, slugProblem } from "@/components/apps/slug";
import { listPayload, loaded, shell } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  apps: undefined as unknown,
  shell: undefined as unknown,
  push: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  useHostedApps: () => state.apps,
  createHostedApp: state.create,
}));
vi.mock("@/components/shell/shell-context", () => ({ useShell: () => state.shell }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push, refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import NewAppPage from "@/app/(product)/apps/new/page";

const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const button = (host: HTMLElement, label: string): HTMLButtonElement =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label))!;

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  state.apps = loaded(listPayload());
  state.shell = shell("editor");
  state.push.mockClear();
  state.create.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(noise).toEqual([]);
  vi.restoreAllMocks();
});

describe("URL name rule", () => {
  it("derives a first guess from the app name", () => {
    expect(deriveSlug("Equipment Requests!")).toBe("equipment-requests");
    expect(deriveSlug("  Field visits — 2026  ")).toBe("field-visits-2026");
    expect(deriveSlug("!!!")).toBe("");
  });

  it("explains each refusal in terms of what to change", () => {
    expect(slugProblem("")).toContain("Give the app a URL name");
    expect(slugProblem("ab")).toContain("at least 3 characters");
    expect(slugProblem("a".repeat(41))).toContain("at most 40 characters");
    expect(slugProblem("bad_name")).toContain("Lowercase letters, digits and hyphens only");
    expect(slugProblem("-leading")).toContain("Start and end with a letter or a digit");
    expect(slugProblem("api")).toContain("reserved for the platform");
    expect(slugProblem("equipment-requests")).toBeUndefined();
  });
});

describe("New app screen", () => {
  it("shows the address as the name is typed", async () => {
    await act(async () =>
      root.render(
        <ToastProvider renderToaster={false}>
          <NewAppPage />
        </ToastProvider>
      )
    );
    const name = host.querySelector<HTMLInputElement>('input[placeholder="Equipment requests"]')!;
    await act(async () => typeInto(name, "Field visits"));

    expect(host.textContent).toContain("http://field-visits.apps.localhost/");
    expect(button(host, "Create app").disabled).toBe(false);
  });

  it("refuses a reserved URL name and says so before the button is pressed", async () => {
    await act(async () =>
      root.render(
        <ToastProvider renderToaster={false}>
          <NewAppPage />
        </ToastProvider>
      )
    );
    const name = host.querySelector<HTMLInputElement>('input[placeholder="Equipment requests"]')!;
    await act(async () => typeInto(name, "Admin console"));
    const slug = host.querySelector<HTMLInputElement>('input[placeholder="equipment-requests"]')!;
    await act(async () => typeInto(slug, "api"));

    expect(host.textContent).toContain("reserved for the platform");
    const create = button(host, "Create app");
    expect(create.disabled).toBe(true);
    expect(create.title).toContain("reserved for the platform");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("says the address appears later when there is no app to read the domain from", async () => {
    state.apps = loaded(listPayload({ apps: [] }));
    await act(async () =>
      root.render(
        <ToastProvider renderToaster={false}>
          <NewAppPage />
        </ToastProvider>
      )
    );
    expect(host.textContent).toContain("cannot show the domain");
    expect(host.textContent).not.toContain("apps.localhost");
  });

  it("tells a workspace viewer who can create an app instead of failing later", async () => {
    state.shell = shell("viewer");
    await act(async () =>
      root.render(
        <ToastProvider renderToaster={false}>
          <NewAppPage />
        </ToastProvider>
      )
    );
    const create = button(host, "Create app");
    expect(create.disabled).toBe(true);
    expect(create.title).toContain("Creating an app needs the editor role in Kepler Labs");
  });
});
