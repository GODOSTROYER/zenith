/**
 * `security.reopenFinding` — the way back out of a dismissal.
 *
 * The interesting cases are the refusals: a finding that was never dismissed
 * has no dismissal to undo, and the plan has to say so before a confirm button
 * is offered rather than failing on click.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Actor, Project, SecurityFinding } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-reopen-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, readAudit, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const WS = "ws-reopen";
const actor = (id: string, name = id): Actor => ({ type: "user", id, name });
const ctx = (a: Actor): ActionContext => ({ workspaceId: WS, projectId: "p1", actor: a });

const exec = async (actionId: string, a: Actor, input: unknown) =>
  (await runAction(actionId, ctx(a), input, { mode: "execute" })).result!;
const preview = async (actionId: string, a: Actor, input: unknown) =>
  (await runAction(actionId, ctx(a), input, { mode: "plan" })).plan!;

const FINDING: SecurityFinding = {
  id: "sf_plaintext_1",
  projectId: "p1",
  severity: "high",
  title: "api.API_KEY is stored in plain text",
  detail: "API_KEY looks like a credential but its value lives in the manifest.",
  status: "open",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const eli = actor("u-editor", "Eli");
const vic = actor("u-viewer", "Vic");

/**
 * The project the finding is about. A finding is resolved through it — that is
 * what scopes a finding id to one workspace (see the tenancy note in
 * actions/defs/security) — so the store has to hold the row the scanner would
 * have produced this finding from.
 */
const PROJECT: Project = {
  id: "p1",
  workspaceId: WS,
  name: "Reopen",
  slug: "reopen",
  workingManifest: { version: 1, services: [], resources: [], routes: [], bindings: [] },
  origin: { type: "blank" },
  createdAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  resetDb({
    workspaces: [{ id: WS, name: "Reopen", slug: "reopen", createdAt: new Date().toISOString() }],
    members: [
      { id: "u-editor", workspaceId: WS, name: "Eli", email: "eli@x.dev", role: "editor" },
      { id: "u-viewer", workspaceId: WS, name: "Vic", email: "vic@x.dev", role: "viewer" },
    ],
    projects: [structuredClone(PROJECT)],
    findings: [structuredClone(FINDING)],
  });
});

const stored = () => db().findings[0];

describe("security.reopenFinding", () => {
  it("undoes a dismissal and leaves nothing claiming the finding was handled", async () => {
    const dismissed = await exec("security.dismissFinding", eli, {
      findingId: FINDING.id,
      reason: "Accepted — rotating the key next sprint",
    });
    expect(dismissed.ok).toBe(true);
    expect(stored().status).toBe("dismissed");
    expect(stored().resolvedBy?.name).toBe("Eli");

    const reopened = await exec("security.reopenFinding", eli, { findingId: FINDING.id });
    expect(reopened.ok).toBe(true);
    expect(reopened.summary).toContain("rotating the key next sprint");
    expect(stored().status).toBe("open");
    expect(stored().resolvedAt).toBeUndefined();
    expect(stored().resolvedBy).toBeUndefined();
    expect(stored().resolvedReason).toBeUndefined();
  });

  it("quotes the dismissal in the plan, so the preview says what is being undone", async () => {
    await exec("security.dismissFinding", eli, { findingId: FINDING.id, reason: "behind the VPN" });
    const plan = await preview("security.reopenFinding", eli, { findingId: FINDING.id });
    expect(plan.blocked).toBeUndefined();
    expect(plan.details.join(" ")).toContain("behind the VPN");
    expect(plan.details.join(" ")).toContain("Eli");
    expect(plan.costDeltaUsd).toBe(0);
  });

  it("refuses a finding that was never dismissed, at plan time and again at execute", async () => {
    const plan = await preview("security.reopenFinding", eli, { findingId: FINDING.id });
    expect(plan.blocked).toContain("is open, not dismissed");

    const result = await exec("security.reopenFinding", eli, { findingId: FINDING.id });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Only a dismissed finding can be reopened/);
    expect(stored().status).toBe("open");
  });

  it("names the missing finding and the fix when the id is unknown", async () => {
    const result = await exec("security.reopenFinding", eli, { findingId: "sf_nope" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/was not found/);
    expect(result.error).toMatch(/Reload the Security page/);
  });

  it("is closed to viewers, and the refusal is audited", async () => {
    await exec("security.dismissFinding", eli, { findingId: FINDING.id, reason: "accepted" });
    const result = await exec("security.reopenFinding", vic, { findingId: FINDING.id });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/needs the editor role/);
    expect(result.error).toMatch(/role_denied/);
    expect(stored().status).toBe("dismissed");

    const denied = readAudit({ workspaceId: WS }).find((e) => e.result === "denied");
    expect(denied?.actionId).toBe("security.reopenFinding");

    // A viewer can still see what it would do — planning stays open to everyone.
    const plan = await preview("security.reopenFinding", vic, { findingId: FINDING.id });
    expect(plan.blocked).toMatch(/editor role/);
  });
});
