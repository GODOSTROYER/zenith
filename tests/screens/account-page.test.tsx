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
import { DeleteAccountCard, ownershipBlock, soleAdminBlock } from "@/app/(product)/account/account-delete";
import AccountPage from "@/app/(product)/account/page";
import { ApiError } from "@/lib/client/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ api: vi.fn(), replace: vi.fn(), refresh: vi.fn(), shell: vi.fn() }));
vi.mock("@/lib/client/api", async (original) => ({
  ...(await original<typeof import("@/lib/client/api")>()),
  api: calls.api,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: calls.replace, refresh: calls.refresh }),
}));


vi.mock("@/components/shell/shell-context", () => ({ useShell: calls.shell }));
vi.mock("@/app/(product)/account/account-profile", () => ({
  DisplayNameCard: () => null, EmailCard: () => null, PasswordCard: () => null,
}));
vi.mock("@/app/(product)/account/account-identities", () => ({ IdentitiesCard: () => null }));
vi.mock("@/app/(product)/account/account-sessions", () => ({
  ExportCard: () => null, SessionsCard: () => null,
}));
vi.mock("@/components/screens/section-navigation", () => ({ SectionNavigation: () => null }));

const shellFor = (ownerId: string | undefined, adminIds = ["me", "another-admin"]) => ({
  loading: false,
  refresh: calls.refresh,
  boot: {
    auth: { configured: true },
    user: { id: "me", name: "Me", email: "me@example.com" },
    role: "admin",
    workspace: { id: "atlas", name: "Atlas", ownerId },
    members: adminIds.map((id) => ({ id, role: "admin" })),
    // Switcher rows deliberately have no ownership information.
    workspaces: [{ id: "atlas", name: "Atlas", slug: "atlas", role: "admin" }],
  },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.api.mockReset();
  calls.replace.mockReset();
  calls.refresh.mockReset();
  calls.shell.mockReset();
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
      "You are the only admin of Atlas. Invite another member and transfer workspace ownership from Share, then delete your account."
    );
    expect(buttons("Delete my account")[0].disabled).toBe(true);
    expect(document.querySelector('input[placeholder="me@example.com"]')).toBeNull();
  });

  it("moves a 409 from the API into the refusal slot rather than the error list", async () => {
    await render(<DeleteAccountCard email="me@example.com" workspaceCount={1} />);
    await act(async () => buttons("Delete my account")[0].click());
    await typeEmail("me@example.com");

    calls.api.mockRejectedValue(
      new ApiError(
        "You are the only admin of Orbit.",
        409,
        "Invite another member and transfer workspace ownership from Share, then delete your account."
      )
    );
    await act(async () => confirmButton().click());

    expect(document.body.textContent).toContain("You are the only admin of Orbit.");
    expect(confirmButton().disabled).toBe(true);
    expect(calls.replace).not.toHaveBeenCalled();
  });
});

describe("account deletion ownership protection", () => {
  it("blocks the current workspace owner even when another admin exists", async () => {
    calls.shell.mockReturnValue(shellFor("me"));
    await render(<AccountPage />);
    expect(host.textContent).toContain(ownershipBlock("Atlas"));
    expect(host.textContent).not.toContain("You are the only admin");
    expect(buttons("Delete my account")[0].disabled).toBe(true);
    await act(async () => buttons("Delete my account")[0].click());
    expect(document.querySelector('input[placeholder="me@example.com"]')).toBeNull();
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("leads with ownership transfer even when the owner is also the only admin", async () => {
    calls.shell.mockReturnValue(shellFor("me", ["me"]));
    await render(<AccountPage />);
    expect(host.textContent).toContain(ownershipBlock("Atlas"));
    expect(host.textContent).not.toContain("You are the only admin");
    expect(buttons("Delete my account")[0].disabled).toBe(true);
  });

  it("retains the sole-admin refusal for a legacy workspace without an owner", async () => {
    calls.shell.mockReturnValue(shellFor(undefined, ["me"]));
    await render(<AccountPage />);
    expect(host.textContent).toContain(soleAdminBlock("Atlas"));
    expect(host.textContent).toContain("transfer workspace ownership from Share");
    expect(buttons("Delete my account")[0].disabled).toBe(true);
  });

  it("lets a non-owner with another admin reach typed confirmation", async () => {
    calls.shell.mockReturnValue(shellFor("another-admin"));
    await render(<AccountPage />);
    expect(buttons("Delete my account")[0].disabled).toBe(false);
    await act(async () => buttons("Delete my account")[0].click());
    expect(confirmButton().disabled).toBe(true);
    await typeEmail("me@example.com");
    expect(confirmButton().disabled).toBe(false);
    expect(calls.api).not.toHaveBeenCalled();
  });

  it("honors a server refusal for ownership outside the current workspace", async () => {
    calls.shell.mockReturnValue(shellFor("another-admin"));
    await render(<AccountPage />);
    await act(async () => buttons("Delete my account")[0].click());
    await typeEmail("me@example.com");
    calls.api.mockRejectedValueOnce(
      new ApiError(
        "You own Orbit.",
        409,
        "Transfer workspace ownership from Share before deleting your account."
      )
    );
    await act(async () => confirmButton().click());
    expect(document.body.textContent).toContain(ownershipBlock("Orbit"));
    expect(confirmButton().disabled).toBe(true);
    expect(document.querySelector('input[placeholder="me@example.com"]')).toBeNull();
    expect(calls.replace).not.toHaveBeenCalled();
    expect(calls.api).toHaveBeenCalledOnce();
  });
});
