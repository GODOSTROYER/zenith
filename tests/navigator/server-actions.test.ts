import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth/session";
import type { NavigatorRun, Project } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

const session = vi.hoisted(() => ({
  user: null as SessionUser | null,
  configured: true,
  workspaceId: "ws-a",
  normalize: vi.fn(async (text: string) => ({ text, mode: "deterministic" as const })),
  execute: vi.fn(() => ({ ok: true, summary: "Read the selected project." })),
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.user }));
vi.mock("@/lib/supabase/env", async (original) => ({
  ...await original<typeof import("@/lib/supabase/env")>(),
  isSupabaseConfigured: () => session.configured,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: session.workspaceId }) }) }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/navigator/llm", () => ({ normalizeGoal: session.normalize }));
vi.mock("@/lib/navigator/verification", () => ({ verifyRun: async () => ({ note: "No provider checks in this fixture." }) }));

tempDataDir("orrery-nav-boundary-");
const { db, resetDb } = await import("@/lib/db/store");
const { emptyManifest } = await import("@/lib/domain/types");
const { defineAction } = await import("@/lib/actions/core");
const { createRunAction, executeRunAction, cancelRunAction, setAutonomyAction } = await import("@/lib/navigator/server-actions");
const AT = "2026-09-01T10:00:00.000Z";
const ada: SessionUser = { id: "u-a", name: "Ada", email: "ada@example.test" };
let fixtureSequence = 0;
const runId = (suffix: string) => `run-${suffix}-${fixtureSequence}`;
const project = (suffix: string): Project => ({
  id: `p-${suffix}`, workspaceId: `ws-${suffix}`, name: `Project ${suffix}`, slug: "atlas",
  workingManifest: emptyManifest(), createdAt: AT, origin: { type: "blank" },
});
const run = (suffix: string): NavigatorRun => ({
  id: runId(suffix), projectId: `p-${suffix}`, goal: `Private goal ${suffix}`,
  status: "awaiting_approval", createdAt: AT,
  steps: [{ id: `step-${suffix}`, seq: 0, actionId: "test.boundaryRead", title: "Read project",
    rationale: "Read selected project", input: {}, risk: "low", needsApproval: false, status: "proposed" }],
});

beforeEach(() => {
  // resetDb does not clear the executor's action replay cache.
  fixtureSequence += 1;
  session.user = ada;
  session.workspaceId = "ws-a";
  session.configured = true;
  session.normalize.mockReset().mockImplementation(async (text: string) => ({ text, mode: "deterministic" as const }));
  session.execute.mockReset().mockImplementation(() => ({ ok: true, summary: "Read the selected project." }));
  resetDb({
    workspaces: ["a", "b"].map((suffix) => ({ id: `ws-${suffix}`, name: suffix, slug: suffix, createdAt: AT })),
    members: [
      { ...ada, workspaceId: "ws-a", role: "admin" },
      { id: "u-b", name: "Bo", email: "bo@example.test", workspaceId: "ws-b", role: "admin" },
    ],
    projects: [project("a"), project("b")], navigatorRuns: [run("a"), run("b")],
    settings: { autonomy: "autonomous" },
  });
  defineAction({
    id: "test.boundaryRead", title: "Read project", category: "navigator", risk: "low",
    requiredRole: "viewer", mutates: false, input: z.object({}),
    plan: () => ({ summary: "Read", details: [], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false }),
    execute: session.execute,
  });
});

const operations = {
  create: (suffix: string) => createRunAction(`p-${suffix}`, "add a redis cache"),
  execute: (suffix: string) => executeRunAction(runId(suffix), []),
  cancel: (suffix: string) => cancelRunAction(runId(suffix)),
};

describe("Navigator server action workspace admission", () => {
  for (const [name, invoke] of Object.entries(operations)) {
    it.each(["member of A", "member of both", "stranger"])(`${name} refuses B for %s while A is selected`, async (caller) => {
      if (caller === "member of both") db().members.push({ ...ada, workspaceId: "ws-b", role: "admin" });
      if (caller === "stranger") session.user = { id: "stranger", name: "Stranger", email: "stranger@example.test" };
      const before = JSON.stringify(db());
      const reply = await invoke("b");
      expect(reply.run).toBeUndefined();
      expect(reply.error).toBeTruthy();
      expect(reply.fix).toBeTruthy();
      expect(JSON.stringify(db())).toBe(before);
      expect(session.normalize).not.toHaveBeenCalled();
      expect(session.execute).not.toHaveBeenCalled();
    });

    it(`${name} gives foreign and missing IDs the same refusal`, async () => {
      const foreign = await invoke("b");
      const absent = await invoke("missing");
      expect(foreign).toEqual(absent);
    });

    it(`${name} refuses a signed-out caller when authentication is configured`, async () => {
      session.user = null;
      const before = JSON.stringify(db());
      const reply = await invoke("a");
      expect(reply).toMatchObject({ error: expect.stringMatching(/sign in/i), fix: expect.any(String) });
      expect(reply.run).toBeUndefined();
      expect(JSON.stringify(db())).toBe(before);
      expect(session.normalize).not.toHaveBeenCalled();
      expect(session.execute).not.toHaveBeenCalled();
    });

    it(`${name} works for the selected workspace`, async () => {
      const reply = await invoke("a");
      expect(reply.error).toBeUndefined();
      expect(reply.run?.projectId).toBe("p-a");
    });

    it(`${name} works when the caller selects their second workspace`, async () => {
      db().members.push({ ...ada, workspaceId: "ws-b", role: "viewer" });
      session.workspaceId = "ws-b";
      const reply = await invoke("b");
      expect(reply.error).toBeUndefined();
      expect(reply.run?.projectId).toBe("p-b");
    });

    it(`${name} preserves the local demo workflow`, async () => {
      session.user = null;
      session.configured = false;
      db().members = [];
      const reply = await invoke("a");
      expect(reply.error).toBeUndefined();
      expect(reply.run?.projectId).toBe("p-a");
    });
  }

  it("does not persist or disclose a plan if membership ends during model work", async () => {
    const priorRunIds = db().navigatorRuns.map((candidate) => candidate.id);
    session.normalize.mockImplementationOnce(async (text: string) => {
      await Promise.resolve();
      db().members = db().members.filter((member) => member.id !== ada.id);
      return { text, mode: "deterministic" as const };
    });
    const reply = await createRunAction("p-a", "add a redis cache");
    expect(session.normalize).toHaveBeenCalledOnce();
    expect(reply.run).toBeUndefined();
    expect(reply.error).toBeTruthy();
    expect(db().navigatorRuns.map((candidate) => candidate.id)).toEqual(priorRunIds);
  });

  it("does not disclose the completed run if membership ends during execution", async () => {
    // A unique intent prevents the global replay cache from hiding this step.
    db().navigatorRuns[0].id = "run-revoked-during-execution";
    session.execute.mockImplementationOnce(() => {
      db().members = db().members.filter((member) => member.id !== ada.id);
      return { ok: true, summary: "Read completed while permission changed." };
    });
    const reply = await executeRunAction("run-revoked-during-execution", []);
    expect(session.execute).toHaveBeenCalledOnce();
    expect(reply.run).toBeUndefined();
    expect(reply.error).toBeTruthy();
    expect(db().navigatorRuns[0].steps[0].status).toBe("done");
  });

  it.each(["executing", "done", "cancelled"] as const)("does not reveal a foreign run's %s state", async (status) => {
    db().navigatorRuns[1].status = status;
    for (const invoke of [executeRunAction, (id: string) => cancelRunAction(id)]) {
      const foreign = await invoke(runId("b"), []);
      const missing = await invoke(runId("missing"), []);
      expect(foreign).toEqual(missing);
      expect(foreign.run).toBeUndefined();
    }
    expect(db().navigatorRuns[1].status).toBe(status);
  });

  it("normalizes the selected workspace's existing email membership", async () => {
    db().members.push({ ...ada, id: "pending-subject", workspaceId: "ws-b", role: "viewer" });
    session.workspaceId = "ws-b";
    const reply = await createRunAction("p-b", "add a redis cache");
    expect(reply.error).toBeUndefined();
    expect(reply.run?.projectId).toBe("p-b");
    expect(db().members.find((member) => member.workspaceId === "ws-b" && member.email === ada.email)?.id).toBe(ada.id);
  });

  it("keeps autonomy changes bound to the selected workspace's role", async () => {
    db().members.push({ ...ada, workspaceId: "ws-b", role: "viewer" });
    session.workspaceId = "ws-b";
    const reply = await setAutonomyAction("bounded");
    expect(reply.error).toMatch(/admin/);
    expect(db().settings.autonomy).toBe("autonomous");
  });

  it("refuses signed-out autonomy changes with configured authentication", async () => {
    session.user = null;
    const reply = await setAutonomyAction("bounded");
    expect(reply.error).toMatch(/sign in/i);
    expect(db().settings.autonomy).toBe("autonomous");
  });

  it("never resolves a foreign ID through a selected project's slug", async () => {
    db().projects[0].slug = "p-b";
    const before = JSON.stringify(db());
    const reply = await createRunAction("p-b", "add a redis cache");
    expect(reply.run).toBeUndefined();
    expect(session.normalize).not.toHaveBeenCalled();
    expect(JSON.stringify(db())).toBe(before);
  });

  it("uses canonical IDs even when a foreign slug shadows the selected project's ID", async () => {
    db().projects.reverse();
    db().projects[0].slug = "p-a";
    const reply = await createRunAction("p-a", "add a redis cache");
    expect(reply.error).toBeUndefined();
    expect(reply.run?.projectId).toBe("p-a");
    expect(session.normalize).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: "p-a" }), expect.any(Array));
  });
});
