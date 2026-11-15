import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewEnvironmentForm } from "@/app/(product)/p/[slug]/settings/environments/new-environment-form";
import type { ProviderInfo } from "@/app/(product)/p/[slug]/settings/shared";
import type { CloudConnection } from "@/lib/domain/types";

vi.mock("@/app/(product)/p/[slug]/settings/access", () => ({ useGate: () => () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection: CloudConnection = {
  id: "cloud-ready", workspaceId: "workspace-test", provider: "aws", label: "Team cloud",
  region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: "2026-11-01T00:00:00Z",
};
const provider: ProviderInfo = {
  id: "aws", displayName: "AWS", availability: "available", tagline: "Team infrastructure",
  regions: [{ id: "us-east-1", label: "US East" }],
};
const providerById = new Map([[provider.id, provider]]);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find((element) => element.textContent?.trim() === text)!;

function connectionControl() {
  const label = [...host.querySelectorAll("label")].find((element) => element.textContent === "Connection")!;
  return host.querySelector<HTMLButtonElement>(`[role="combobox"][aria-labelledby="${label.id}"]`)!;
}

function option(text: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((element) => element.textContent?.includes(text))!;
}

function enterName(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="staging-2"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("New environment connection dropdown", () => {
  it("lets a user return to the built-in sandbox and then choose a cloud again", () => {
    const submit = vi.fn();
    act(() => root.render(<NewEnvironmentForm connections={[connection]} providerById={providerById}
      role="admin" onSubmit={submit} />));
    act(() => button("New environment").click());
    enterName("staging-2");

    expect(connectionControl().textContent).toContain("Team cloud");
    act(() => connectionControl().click());
    const sandbox = option("Sandbox (default)");
    expect(sandbox.getAttribute("aria-disabled")).not.toBe("true");
    act(() => sandbox.click());
    expect(connectionControl().textContent).toContain("Sandbox (default)");
    act(() => button("Preview and create").click());
    expect(submit).toHaveBeenLastCalledWith({ name: "staging-2", class: "staging", connectionId: undefined });

    act(() => connectionControl().click());
    act(() => option("Team cloud").click());
    act(() => button("Preview and create").click());
    expect(submit).toHaveBeenLastCalledWith({ name: "staging-2", class: "staging", connectionId: "cloud-ready" });
  });

  it("shows why a disconnected cloud cannot be selected and keeps the healthy choice", () => {
    const disconnected: CloudConnection = {
      ...connection, id: "cloud-offline", label: "Offline cloud", status: "disconnected",
    };
    act(() => root.render(<NewEnvironmentForm connections={[connection, disconnected]}
      providerById={providerById} role="admin" onSubmit={() => {}} />));
    act(() => button("New environment").click());
    act(() => connectionControl().click());
    const unavailable = option("Offline cloud");
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.textContent).toContain("disconnected");
    act(() => unavailable.click());
    expect(connectionControl().textContent).toContain("Team cloud");
  });
});
