import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: null as { id: string } | null, configured: true, mine: [] as string[] }));
vi.mock("@/lib/server/context", () => ({
  route: (handler: () => unknown) => handler,
  currentRequest: () => ({ user: state.user }),
  workspacesFor: (user: unknown) => user === state.user ? state.mine : [],
}));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => state.configured }));
import { GET } from "@/app/api/me/route";
describe("public entry facts", () => {
  beforeEach(() => { state.user = null; state.configured = true; state.mine = []; });
  it("does not infer membership from another workspace existing", async () => {
    state.user = { id: "new-user" };
    expect(await (GET as unknown as () => Promise<unknown>)()).toEqual({ configured: true, signedIn: true, hasWorkspace: false });
  });
  it("reports the verified caller's own workspace without identity details", async () => {
    state.user = { id: "member" }; state.mine = ["own-workspace"];
    expect(await (GET as unknown as () => Promise<unknown>)()).toEqual({ configured: true, signedIn: true, hasWorkspace: true });
  });
});
