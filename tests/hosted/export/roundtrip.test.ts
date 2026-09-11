/**
 * Export and import: the "you can leave" round trip (G21, G27).
 *
 * Two claims are checked here, and they are deliberately different in
 * strength. Data comes back *identical* — the same ids, the same versions, the
 * same timestamps — because a record whose history was re-created is not the
 * same record. Access comes back as *intent*: everyone on the manifest arrives
 * held for re-approval under a placeholder subject, because a grant is bound
 * to an identity-provider subject and those do not travel.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";
import path from "node:path";

const dataDir = isolatedDataDir("zenith-export-roundtrip-");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { EXPORT_FORMAT, exportApp, importApp, importedSubject } = await import("@/lib/hosted/export");
const { TRACKER_LIMITS } = await import("@/lib/hosted/contracts");
const { closeAllAppData, openAppData } = await import("@/lib/hosted/data");
const {
  EDITOR,
  OWNER,
  VIEWER,
  dataContext,
  seedActiveRelease,
  seedApp,
  seedArtifact,
  seedGrant,
  seedRecord,
  uuid,
} = await import("../backup/_ops-fixtures");

const a = openAuthority();
const app = await seedApp(a, { slug: "export-source", workspaceId: "ws-export", createdBy: OWNER.subject });
await seedGrant(a, app.id, OWNER, "owner");
await seedGrant(a, app.id, EDITOR, "editor");
const revoked = await seedGrant(a, app.id, VIEWER, "viewer");
await a.tx((repos) => repos.grants.revoke(revoked.id, OWNER.subject, "left"));
await a.tx((repos) =>
  repos.invites.insert({
    id: uuid(),
    appId: app.id,
    email: "pending@acme.example",
    role: "editor",
    tokenHash: "a".repeat(64),
    createdBy: OWNER.subject,
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
  })
);

afterAll(async () => {
  closeAllAppData();
  closeAuthority();
  removeDir(dataDir);
});

/** More than one page, so the export has to follow its own cursor. */
const RECORD_COUNT = TRACKER_LIMITS.listMax + 7;

describe("exportApp", () => {
  it("pages through every record, not just the first page", async () => {
    for (let n = 0; n < RECORD_COUNT; n++)
      await seedRecord(app.id, { title: `Item ${String(n).padStart(3, "0")}`, quantity: (n % 9) + 1 });

    const bundle = await exportApp(app.id, { subject: OWNER.subject, email: OWNER.email });
    expect(bundle.format).toBe(EXPORT_FORMAT);
    expect(bundle.records).toHaveLength(RECORD_COUNT);
    expect(new Set(bundle.records.map((record) => record.id)).size).toBe(RECORD_COUNT);
    expect(RECORD_COUNT).toBeGreaterThan(TRACKER_LIMITS.listMax);
  });

  it("carries the access manifest without a subject, a token or a session", async () => {
    const bundle = await exportApp(app.id);
    expect(bundle.access.grants.map((grant) => `${grant.email}:${grant.role}:${grant.state}`).sort()).toEqual([
      `${EDITOR.email}:editor:active`,
      `${OWNER.email}:owner:active`,
      `${VIEWER.email}:viewer:revoked`,
    ]);
    expect(bundle.access.invites).toEqual([
      expect.objectContaining({ email: "pending@acme.example", role: "editor", state: "pending" }),
    ]);

    // The manifest names people by email and role, never by subject.
    const manifest = JSON.stringify(bundle.access);
    expect(manifest).not.toContain(OWNER.subject);
    expect(manifest).not.toContain(EDITOR.subject);
    // No invitation token hash anywhere in the file: this cannot be replayed.
    expect(JSON.stringify(bundle)).not.toContain("a".repeat(64));
    expect(bundle.limitations.join(" ")).toMatch(/cannot be replayed to open the app/);
    // And the file says plainly that it is still customer data — record
    // authorship is part of the frozen contract and travels with the records.
    expect(bundle.limitations.join(" ")).toMatch(/not anonymous/);
    expect(bundle.records[0].createdBy).toBe(OWNER.subject);
  });

  it("lists the artifact's files and says the source is not included", async () => {
    const artifact = await seedArtifact(a, path.join(dataDir, "artifacts"), { marker: "export" });
    await seedActiveRelease(a, app.id, artifact.digest);

    const bundle = await exportApp(app.id);
    expect(bundle.artifact?.digest).toBe(artifact.digest);
    expect(bundle.artifact?.files.map((file) => file.path).sort()).toEqual(["assets/app.js", "index.html"]);
    expect(bundle.source.included).toBe(false);
    expect(bundle.source.reason).toMatch(/cannot hand back the code/);
    expect(bundle.source.artifactFiles).toEqual(bundle.artifact?.files.map((file) => file.path));
    expect(bundle.activeRelease?.id).toBeTruthy();
    expect(bundle.releases).toHaveLength(1);
  });

  it("records that the export happened", async () => {
    const events = await a.repos.events.listSince({ appId: app.id, event: "export.completed" }, { limit: 10 });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].props?.records).toBe(RECORD_COUNT);
  });

  it("refuses an app that does not exist", async () => {
    await expect(exportApp("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/No hosted app has the id/);
  });
});

describe("importApp", () => {
  it("recreates every record exactly, and every person as held for re-approval", async () => {
    const bundle = await exportApp(app.id);
    const result = await importApp(bundle, {
      workspaceId: "ws-import",
      slug: "export-target",
      createdBy: "55555555-5555-4555-8555-555555555555",
      email: "New.Owner@acme.example",
    });

    expect(result.records.imported).toBe(RECORD_COUNT);
    expect(result.records.skipped).toEqual([]);
    // Three people on the manifest plus one invitation; the importer is the owner.
    expect(result.access).toEqual({ owner: 1, fromGrants: 3, fromInvites: 1 });

    /* The records are the same records. */
    const imported = openAppData(result.app.id);
    const ctx = dataContext(result.app.id, { subject: "55555555-5555-4555-8555-555555555555", email: "new.owner@acme.example" });
    const seen = new Map<string, { title: string; version: number; createdAt: string; createdBy: string }>();
    let cursor: string | undefined;
    for (;;) {
      const page = await imported.store.list(ctx, { limit: TRACKER_LIMITS.listMax, cursor });
      for (const record of page.items)
        seen.set(record.id, {
          title: record.title,
          version: record.version,
          createdAt: record.createdAt,
          createdBy: record.createdBy,
        });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(RECORD_COUNT);
    for (const original of bundle.records) {
      const copy = seen.get(original.id);
      expect(copy).toBeDefined();
      expect(copy).toMatchObject({
        title: original.title,
        version: original.version,
        createdAt: original.createdAt,
        createdBy: original.createdBy,
      });
    }

    /* Access is intent, and nothing more. */
    const grants = await a.repos.grants.listByApp(result.app.id);
    expect(grants.filter((grant) => grant.state === "active")).toHaveLength(1);
    expect(grants.find((grant) => grant.state === "active")?.email).toBe("new.owner@acme.example");
    const held = grants.filter((grant) => grant.state === "needs_reapproval");
    expect(held).toHaveLength(4);
    expect(held.map((grant) => grant.email).sort()).toEqual(
      [EDITOR.email, OWNER.email, VIEWER.email, "pending@acme.example"].sort()
    );
    // The placeholder can never be matched by a real caller.
    expect(held.find((grant) => grant.email === EDITOR.email)?.subject).toBe(
      importedSubject("grant", EDITOR.email)
    );
    expect(held.find((grant) => grant.email === "pending@acme.example")?.subject).toBe(
      importedSubject("invite", "pending@acme.example")
    );
    for (const grant of held) expect(await a.repos.grants.activeFor(result.app.id, grant.subject)).toBeNull();

    /* And the app itself is new: no release, no artifact, nothing serving. */
    expect(result.app.activeReleaseId).toBeNull();
    expect(await a.repos.releases.listByApp(result.app.id)).toEqual([]);
    expect(result.limitations.join(" ")).toMatch(/None of them can open this app/);
    expect(result.limitations.join(" ")).toMatch(/Sessions were not imported/);
  });

  it("refuses a slug that is already taken", async () => {
    const bundle = await exportApp(app.id);
    await expect(
      importApp(bundle, {
        workspaceId: "ws-import",
        slug: "export-target",
        createdBy: OWNER.subject,
        email: OWNER.email,
      })
    ).rejects.toThrow(/already taken/);
  });

  it("refuses a file that is not an export of this format", async () => {
    await expect(
      importApp(
        { format: "some-other-tool/2", records: [] },
        { workspaceId: "ws-import", slug: "nope", createdBy: OWNER.subject, email: OWNER.email }
      )
    ).rejects.toThrow(/not a Zenith app export/);
  });

  it("refuses a record that does not match the frozen contract, and imports nothing", async () => {
    await expect(
      importApp(
        {
          format: EXPORT_FORMAT,
          records: [
            {
              id: "r1",
              title: "Fine",
              category: "not-a-category",
              quantity: 1,
              version: 1,
              createdBy: "x",
              createdByEmail: "x@y.z",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedBy: "x",
              updatedByEmail: "x@y.z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        { workspaceId: "ws-import", slug: "bad-records", createdBy: OWNER.subject, email: OWNER.email }
      )
    ).rejects.toThrow(/not a Zenith app export/);
    expect(await a.repos.apps.getBySlug("bad-records")).toBeNull();
  });
});
