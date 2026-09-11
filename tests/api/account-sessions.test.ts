/**
 * DELETE /api/account/sessions — "everywhere" has to mean both session systems.
 *
 * Hosted app sessions are opaque cookies this server issued; Supabase knows
 * nothing about them. Ending the identity without ending those would leave a
 * browser that keeps opening apps after it has been signed out, so the order is
 * part of the contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string } | null,
  order: [] as string[],
  ended: 2,
  signOutError: null as { message: string } | null,
  signOutScope: undefined as string | undefined,
}));

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({ user: state.user }),
  intParam: () => 0,
}));

vi.mock("@/lib/hosted/access", () => ({
  terminateAppSessionsForSubject: (subject: string, reason: string) => {
    state.order.push(`sessions:${subject}:${reason}`);
    return state.ended;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signOut: async (opts?: { scope?: string }) => {
        state.order.push("signOut");
        state.signOutScope = opts?.scope;
        return { error: state.signOutError };
      },
    },
  }),
}));

const { DELETE } = await import("@/app/api/account/sessions/route");
const run = () => (DELETE as unknown as () => Promise<{ appSessionsEnded: number }>)();

beforeEach(() => {
  state.user = { id: "u-me", email: "me@example.com", name: "Mika" };
  state.order = [];
  state.ended = 2;
  state.signOutError = null;
  state.signOutScope = undefined;
});

describe("sign out everywhere", () => {
  it("ends the hosted app sessions before the identity, and globally", async () => {
    expect(await run()).toEqual({ appSessionsEnded: 2 });
    expect(state.order).toEqual(["sessions:u-me:signed_out", "signOut"]);
    expect(state.signOutScope).toBe("global");
  });

  it("says what did and did not end when the identity refuses", async () => {
    state.signOutError = { message: "network down" };
    await expect(run()).rejects.toMatchObject({
      status: 502,
      message: "Your other sessions were not all ended: network down",
    });
  });

  it("refuses a caller with no account", async () => {
    state.user = null;
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(state.order).toEqual([]);
  });
});
