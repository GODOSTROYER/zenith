/**
 * The audience: the last owner cannot be removed and the control says so before
 * it is pressed, and an invitation that was never sent hands over the link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { DeliveryNote } from "@/app/(product)/apps/delivery-note";
import { delivery, grant, invite, loaded } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  grants: undefined as unknown,
  invites: undefined as unknown,
}));

vi.mock("@/lib/client/hosted", async (original) => ({
  ...(await original<typeof import("@/lib/client/hosted")>()),
  useHostedGrants: () => state.grants,
  useHostedInvites: () => state.invites,
}));

import { AudiencePanel } from "@/app/(product)/apps/audience-panel";

let root: Root;
let host: HTMLDivElement;
const noise: string[] = [];

const buttons = (label: string): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll("button")).filter((b) => b.textContent?.includes(label));

const renderPanel = async (canManage = true) => {
  await act(async () =>
    root.render(
      <ToastProvider renderToaster={false}>
        <AudiencePanel
          appId="app-1"
          appName="Equipment requests"
          canManage={canManage}
          manageDisabledReason="Only an owner of Equipment requests can do this."
          onChanged={() => {}}
        />
      </ToastProvider>
    )
  );
};

beforeEach(() => {
  noise.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args) => void noise.push(String(args[0])));
  vi.spyOn(console, "warn").mockImplementation((...args) => void noise.push(String(args[0])));
  state.grants = loaded({ grants: [grant()] });
  state.invites = loaded({ invites: [invite()] });
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

describe("Audience", () => {
  it("refuses to remove the only owner and says what to do first", async () => {
    await renderPanel();
    const revoke = buttons("Revoke")[0];
    expect(revoke.disabled).toBe(true);
    expect(revoke.title).toContain("is the only owner of Equipment requests");
    expect(revoke.title).toContain("Make someone else an owner first");

    const role = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Role for owner@example.com"]'
    )!;
    expect(role.disabled).toBe(true);
  });

  it("allows removing an owner once there is a second one", async () => {
    state.grants = loaded({
      grants: [grant(), grant({ id: "grant-2", subject: "sub-2", email: "second@example.com" })],
    });
    await renderPanel();
    for (const revoke of buttons("Revoke")) expect(revoke.disabled).toBe(false);
  });

  it("tells a non-owner who to ask instead of showing an empty list", async () => {
    await renderPanel(false);
    expect(host.textContent).toContain("Only an owner of Equipment requests can do this.");
    expect(host.querySelector("table")).toBeNull();
  });
});

describe("Invitation delivery", () => {
  const renderNote = async (props: Parameters<typeof DeliveryNote>[0]) => {
    await act(async () =>
      root.render(
        <ToastProvider renderToaster={false}>
          <DeliveryNote {...props} />
        </ToastProvider>
      )
    );
  };

  it("hands over the link, once, when the email failed", async () => {
    await renderNote({
      delivery: delivery({ state: "failed", transport: "none", error: "No mail transport is configured." }),
      acceptUrl: "http://localhost:3400/apps/accept?token=abc123",
      email: "guest@example.com",
    });

    const text = host.textContent ?? "";
    expect(text).toContain("Not sent");
    expect(text).toContain("No mail transport is configured.");
    expect(text).toContain("This link is shown once");
    expect(text).toContain("http://localhost:3400/apps/accept?token=abc123");
    expect(buttons("Copy invite link")).toHaveLength(1);
  });

  it("offers no link when the email was accepted, because there is nothing to hand over", async () => {
    await renderNote({ delivery: delivery({ state: "sent" }), email: "guest@example.com" });
    expect(host.textContent).toContain("Email accepted by the mail server (delivery not confirmed)");
    expect(buttons("Copy invite link")).toHaveLength(0);
  });
});
