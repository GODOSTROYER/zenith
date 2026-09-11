/**
 * GET /api/account/export — your data, and only yours.
 *
 * The export is built from `workspacesFor(user)`, so the test that matters is
 * the negative one: a workspace the caller does not belong to, and an audit row
 * somebody else wrote, must not appear in the file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-account-export-", { fast: true });

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string } | null,
}));

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({ user: state.user }),
  intParam: () => 0,
}));

const { GET } = await import("@/app/api/account/export/route");
const { appendAudit, db, resetDb } = await import("@/lib/db/store");
const { id } = await import("@/lib/domain/types");
type Manifest = import("@/lib/domain/types").Manifest;
const type = await import("@/lib/server/account");

interface Body {
  user: { id: string; email: string };
  notes: string[];
  workspaces: {
    workspace: { id: string; name: string };
    membership: { role: string } | null;
    projects: { id: string; revisions: { number: number }[]; environments: { id: string }[] }[];
    audit: { actionId: string; summary: string }[];
  }[];
}

const read = async (): Promise<{ res: Response; body: Body }> => {
  const res = await (GET as unknown as () => Promise<Response>)();
  return { res, body: JSON.parse(await res.text()) as Body };
};

const manifest = (): Manifest => ({ version: 1, services: [], resources: [], routes: [], bindings: [] });

const audit = (workspaceId: string, actorId: string, summary: string) =>
  appendAudit({
    ts: "2026-02-01T00:00:00.000Z",
    id: id(),
    workspaceId,
    actor: { type: "user", id: actorId, name: actorId },
    actionId: "deploy.start",
    input: { ok: true },
    result: "ok",
    summary,
  });

beforeEach(() => {
  state.user = { id: "u-me", email: "me@example.com", name: "Mika" };
  resetDb({
    workspaces: [
      { id: "w-mine", name: "Atlas", slug: "atlas", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "w-theirs", name: "Orbit", slug: "orbit", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    members: [
      { id: "u-me", workspaceId: "w-mine", name: "Mika", email: "me@example.com", role: "editor" },
      { id: "u-them", workspaceId: "w-theirs", name: "Ada", email: "ada@example.com", role: "admin" },
    ],
    projects: [
      {
        id: "p-mine",
        workspaceId: "w-mine",
        name: "Checkout",
        slug: "checkout",
        workingManifest: manifest(),
        createdAt: "2026-01-02T00:00:00.000Z",
        origin: { type: "blank" },
      },
      {
        id: "p-theirs",
        workspaceId: "w-theirs",
        name: "Ledger",
        slug: "ledger",
        workingManifest: manifest(),
        createdAt: "2026-01-02T00:00:00.000Z",
        origin: { type: "blank" },
      },
    ],
  });
});

describe("account export", () => {
  it("is served as a download, not a page", async () => {
    const { res } = await read();
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="zenith-account-/);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("contains only the workspaces the caller belongs to", async () => {
    const { body } = await read();
    expect(body.workspaces.map((w) => w.workspace.name)).toEqual(["Atlas"]);
    expect(body.workspaces[0].membership?.role).toBe("editor");
    expect(body.workspaces[0].projects.map((p) => p.id)).toEqual(["p-mine"]);
    expect(JSON.stringify(body)).not.toContain("Ledger");
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
  });

  it("carries the caller's own audit rows and nobody else's", async () => {
    audit("w-mine", "u-me", "Mika deployed Checkout");
    audit("w-mine", "u-them", "Ada deployed Checkout");
    const { body } = await read();
    expect(body.workspaces[0].audit.map((a) => a.summary)).toEqual(["Mika deployed Checkout"]);
  });

  it("says in the file what it leaves out", async () => {
    const { body } = await read();
    expect(body.notes.join(" ")).toContain("No secret values");
    expect(body.user).toMatchObject({ id: "u-me", email: "me@example.com" });
  });

  it("refuses a caller with no account rather than exporting an empty file", async () => {
    state.user = null;
    await expect((GET as unknown as () => Promise<Response>)()).rejects.toMatchObject({
      status: 401,
    });
  });

  it("keeps the audit page bounded", () => {
    expect(type.EXPORT_AUDIT_LIMIT).toBeGreaterThan(0);
    expect(db().workspaces).toHaveLength(2);
  });
});
