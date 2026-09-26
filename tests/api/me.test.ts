import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: null as { id: string } | null, configured: true, mine: [] as string[], gate: false, admitted: false, reads: 0 }));
vi.mock("@/lib/server/context", () => ({
  route: (handler: () => unknown) => handler,
  currentRequest: () => ({ user: state.user }),
  workspacesFor: (user: unknown) => { state.reads++; return user === state.user ? state.mine : []; },
}));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => state.configured }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/access", () => ({ waitlistGateEnabled: () => state.gate, getWaitlistAccess: async () => ({ allowed: state.admitted }) }));
import { GET } from "@/app/api/me/route";
const call = GET as unknown as () => Promise<unknown>;
describe("public entry facts", () => {
  beforeEach(() => { state.user = null; state.configured = true; state.mine = []; state.gate = false; state.admitted = false; state.reads = 0; });
  it("does not infer membership from another workspace existing", async () => {
    state.user = { id: "new-user" };
    expect(await call()).toEqual({ configured: true, signedIn: true, hasWorkspace: false });
  });
  it("reports the verified caller's own workspace without identity details", async () => {
    state.user = { id: "member" }; state.mine = ["own-workspace"];
    expect(await call()).toEqual({ configured: true, signedIn: true, hasWorkspace: true });
  });
  it("does not load workspace state or accept invites for a waiting caller", async () => {
    state.gate = true; state.user = { id: "waiting" }; state.mine = ["invited-workspace"];
    const response = await call() as Response;
    expect(await response.json()).toEqual({ configured: true, signedIn: true, hasWorkspace: false });
    expect(state.reads).toBe(0);
  });
  it("keeps the public probe available for signed-out callers while the gate is enabled", async () => {
    state.gate = true;
    const response = await call() as Response;
    expect(await response.json()).toEqual({ configured: true, signedIn: false, hasWorkspace: false });
    expect(state.reads).toBe(0);
  });
  it("preserves the existing entry response for admitted callers", async () => {
    state.gate = true; state.admitted = true; state.user = { id: "admitted" }; state.mine = ["mine"];
    expect(await call()).toEqual({ configured: true, signedIn: true, hasWorkspace: true });
    expect(state.reads).toBe(1);
  });
});
