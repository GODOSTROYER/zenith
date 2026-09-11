/**
 * The Account screen's two rules that are not the API's.
 *
 * Typing your own address is what turns the delete button on — a dialog that
 * arms on a click is one misclick away from an account nobody can get back. And
 * where the screen can already tell the deletion would be refused, the refusal
 * leads, the typing field is gone, and the copy names where the fix is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeleteAccountCard, soleAdminBlock } from "@/app/(product)/account/account-delete";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ api: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: calls.api,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: calls.replace, refresh: calls.refresh }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.api.mockReset();
  calls.replace.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
/** The dialog's confirm is the last button with this label; the card's is the first. */
const confirmButton = () => buttons("Delete my account").at(-1)!;
const typeEmail = async (value: string) => {
  const field = document.querySelector<HTMLInputElement>('input[placeholder="me@example.com"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("deleting your account from the screen", () => {
  it("keeps confirm disabled until your own address is typed exactly", async () => {
    await render(<DeleteAccountCard email="me@example.com" workspaceCount={2} />);
    await act(async () => buttons("Delete my account")[0].click());

    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().title).toBe("Type me@example.com to confirm.");

    await typeEmail("me@example.co");
    expect(confirmButton().disabled).toBe(true);

    await typeEmail("me@example.com");
    expect(confirmButton().disabled).toBe(false);

    calls.api.mockResolvedValue(undefined);
    await act(async () => confirmButton().click());
    expect(calls.api).toHaveBeenCalledWith("/api/account", { method: "DELETE" });
    expect(calls.replace).toHaveBeenCalledWith("/login");
  });

  it("says what goes and what stays before anything can be typed", async () => {
    await render(<DeleteAccountCard email="me@example.com" workspaceCount={3} />);
    await act(async () => buttons("Delete my account")[0].click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("It removes you from 3 workspaces");
    expect(text).toContain("Hosted apps you can open stop opening");
    expect(text).toContain("Activity history keeps your name on what you already did");
  });

  it("leads with the refusal and offers no way to type past it", async () => {
    await render(
      <DeleteAccountCard
        email="me@example.com"
        workspaceCount={1}
        blocked={soleAdminBlock("Atlas")}
      />
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "You are the only admin of Atlas. Make someone else an admin first from Settings → Members, then delete your account."
    );
    expect(buttons("Delete my account")[0].disabled).toBe(true);
    expect(document.querySelector('input[placeholder="me@example.com"]')).toBeNull();
  });

  it("moves a 409 from the API into the refusal slot rather than the error list", async () => {
    await render(<DeleteAccountCard email="me@example.com" workspaceCount={1} />);
    await act(async () => buttons("Delete my account")[0].click());
    await typeEmail("me@example.com");

    calls.api.mockRejectedValue(
      Object.assign(new Error("You are the only admin of Orbit."), {
        status: 409,
        fix: "Make someone else an admin first from Settings → Members, then delete your account.",
      })
    );
    await act(async () => confirmButton().click());

    expect(document.body.textContent).toContain("You are the only admin of Orbit.");
    expect(confirmButton().disabled).toBe(true);
    expect(calls.replace).not.toHaveBeenCalled();
  });
});
