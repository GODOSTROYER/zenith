/**
 * The migration's log and side-file importers.
 *
 * The collection half of `scripts/migrate-to-postgres.ts` is registry-driven —
 * it iterates `rowAdapters()` and encodes each row with the store's own
 * `toRow()`, so it is covered by whatever covers the adapters. What is *not*
 * covered anywhere else is this half: the four things that live in the data
 * directory as logs and side files rather than in `state.json`, each of which
 * has to derive a `workspace_id` that the file store never needed.
 *
 * Four claims:
 *
 *  1. `events.jsonl` → `deployment_events` preserving `seq` and `ts` — the SSE
 *     tail replays from `?after=<seq>`, so a renumbered log replays the wrong
 *     events;
 *  2. `audit.jsonl` → `audit_events` preserving `ts`, keyed on the unique `id`,
 *     which is what makes a re-run idempotent;
 *  3. `revisions/<id>.json` → `revision_manifests`, driven by the revisions in
 *     `state.json` because the table references `revisions.id`;
 *  4. `secrets.json` → `secrets` as a **split, not a decrypt**: the combined
 *     `base64(iv).base64(authTag).base64(ciphertext)` goes into three columns
 *     and `ZENITH_SECRET_KEY` is never read.
 *
 * supabase-js is mocked at `createClient`, so this runs with no project, no
 * keys and no network: what is asserted is the rows the script *offers*, which
 * is the whole of what it decides.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-migrate-", { fast: true });

// Before any application import: `createAdminClient()` refuses without them,
// and these never reach a real project because `createClient` is mocked.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";

/** Every upsert the script offers, in order. */
interface Offer {
  table: string;
  rows: Record<string, unknown>[];
  opts: { onConflict?: string; ignoreDuplicates?: boolean };
}
const offers = vi.hoisted(() => [] as Offer[]);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (
        rows: Record<string, unknown> | Record<string, unknown>[],
        opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
      ) => {
        offers.push({ table, rows: Array.isArray(rows) ? rows : [rows], opts });
        return { error: null };
      },
      select: () => ({ error: null, count: 0 }),
    }),
  }),
}));

const { FileStore } = await import("@/lib/db/file-store");
const { emptyManifest } = await import("@/lib/domain/types");
const { registerCollection } = await import("@/lib/db/pg/registry");
const migrate = await import("../../scripts/migrate-to-postgres");

const CIPHER = {
  iv: Buffer.from("iviviviviviv").toString("base64"),
  tag: Buffer.from("0123456789abcdef").toString("base64"),
  ct: Buffer.from("this is only a fixture").toString("base64"),
};

/** A data directory with one workspace, one project, one deployment, one revision. */
function seed(): void {
  const d = FileStore.db() as unknown as {
    workspaces: Record<string, unknown>[];
    projects: Record<string, unknown>[];
    deployments: Record<string, unknown>[];
    revisions: Record<string, unknown>[];
  };
  d.workspaces.length = 0;
  d.projects.length = 0;
  d.deployments.length = 0;
  d.revisions.length = 0;
  d.workspaces.push({ id: "ws-1", slug: "acme", name: "Acme", createdAt: "2026-01-01T00:00:00.000Z" });
  d.projects.push({ id: "p-1", workspaceId: "ws-1", slug: "api", name: "API" });
  d.deployments.push({ id: "dep-1", projectId: "p-1", environmentId: "e-1", revisionId: "r-1", status: "succeeded", steps: [] });
  d.revisions.push({ id: "r-1", projectId: "p-1", number: 1, manifest: emptyManifest(), message: "first" });
  FileStore.save();
  FileStore.flush();
}

const write = (name: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(DATA, name)), { recursive: true });
  fs.writeFileSync(path.join(DATA, name), body, "utf8");
};

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const offered = (table: string): Record<string, unknown>[] =>
  offers.filter((o) => o.table === table).flatMap((o) => o.rows);

describe("scripts/migrate-to-postgres.ts — the log imports", () => {
  beforeEach(() => {
    offers.length = 0;
    FileStore.reset();
    seed();
  });

  it("moves events.jsonl into deployment_events, preserving seq and ts", async () => {
    write(
      "events.jsonl",
      jsonl([
        { ts: "2026-02-01T00:00:00.000Z", deploymentId: "dep-1", seq: 1, type: "status", status: "applying" },
        { ts: "2026-02-01T00:00:01.000Z", deploymentId: "dep-1", seq: 2, type: "log", stepId: "s-1", line: "hello", stream: "info" },
        // A deployment that is no longer in state.json: there is no workspace
        // to file it under, so it is skipped rather than guessed at.
        { ts: "2026-02-01T00:00:02.000Z", deploymentId: "dep-gone", seq: 1, type: "status", status: "failed" },
      ]) +
        // A torn final line, which is what a crash mid-append leaves behind. It
        // must cost that one event and not the 200,000 before it.
        '{ not json\n'
    );

    const n = await migrate.importEvents(migrate.tenants(FileStore.db()));
    expect(n).toBe(2);

    const rows = offered("deployment_events");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      deployment_id: "dep-1",
      seq: 1,
      workspace_id: "ws-1",
      ts: "2026-02-01T00:00:00.000Z",
    });
    // The promoted columns are out of the bag, exactly as `toRow` does it.
    expect(rows[0].body).toEqual({ type: "status", status: "applying" });
    expect(rows[1]).toMatchObject({ seq: 2, ts: "2026-02-01T00:00:01.000Z" });
    // The composite primary key is what makes a re-run a no-op.
    expect(offers.find((o) => o.table === "deployment_events")?.opts).toMatchObject({
      onConflict: "deployment_id,seq",
      ignoreDuplicates: true,
    });
  });

  it("moves audit.jsonl into audit_events, preserving ts and keying on id", async () => {
    write(
      "audit.jsonl",
      jsonl([
        {
          ts: "2026-02-02T00:00:00.000Z",
          id: "a-1",
          workspaceId: "ws-1",
          projectId: "p-1",
          actor: { type: "user", id: "u-1", name: "Ada" },
          actionId: "project.create",
          input: { name: "API" },
          result: "ok",
          summary: "Created API",
        },
        // No workspace: an audit row that cannot be filed is left behind.
        { ts: "2026-02-02T00:00:01.000Z", id: "a-2", actionId: "x", result: "ok", actor: { type: "system", id: "s", name: "s" }, input: {}, summary: "" },
      ])
    );

    const n = await migrate.importAudit();
    expect(n).toBe(1);

    const [row] = offered("audit_events");
    expect(row).toMatchObject({
      id: "a-1",
      workspace_id: "ws-1",
      ts: "2026-02-02T00:00:00.000Z",
      project_id: "p-1",
      environment_id: null,
      actor_type: "user",
      action_id: "project.create",
      result: "ok",
    });
    // `seq` is the database's bigserial, never the file's — the file has none.
    expect(row).not.toHaveProperty("seq");
    // The actor survives whole in `data`; only its type is promoted.
    expect(row.data).toMatchObject({
      actor: { type: "user", id: "u-1", name: "Ada" },
      summary: "Created API",
    });
    expect(offers.find((o) => o.table === "audit_events")?.opts).toMatchObject({
      onConflict: "id",
      ignoreDuplicates: true,
    });
  });

  it("moves revisions/<id>.json into revision_manifests", async () => {
    // The table references `revisions.id`, so the import refuses to run until a
    // `revisions` collection is registered. Registering a minimal one here
    // makes the claim deterministic whichever packages have landed.
    registerCollection({
      collection: "revisions",
      table: "revisions",
      key: (r) => ({ id: r.id }),
      tenant: () => "ws-1",
      promote: () => ({}),
      rename: {},
      hydrate: (row) => ({ id: String(row.id) }),
      prefetch: { round: 2, filter: () => ({ kind: "all" }) },
      rows: (db) => db.revisions as unknown as { id: string }[],
    });

    const n = await migrate.importRevisionManifests(migrate.tenants(FileStore.db()));
    expect(n).toBe(1);

    const [row] = offered("revision_manifests");
    expect(row).toMatchObject({ revision_id: "r-1", workspace_id: "ws-1" });
    expect(row.manifest).toEqual(emptyManifest());
    expect(offers.find((o) => o.table === "revision_manifests")?.opts).toMatchObject({
      onConflict: "revision_id",
      ignoreDuplicates: true,
    });
  });

  it("splits secrets.json into iv / auth_tag / ciphertext without decrypting", async () => {
    write(
      "secrets.json",
      JSON.stringify({
        version: 1,
        workspaces: {
          "ws-1": {
            "vault:p-1/s-1/STRIPE_API_KEY": {
              ref: "vault:p-1/s-1/STRIPE_API_KEY",
              cipher: `${CIPHER.iv}.${CIPHER.tag}.${CIPHER.ct}`,
              createdAt: "2026-01-02T00:00:00.000Z",
              createdBy: "Ada",
              updatedAt: "2026-01-03T00:00:00.000Z",
              updatedBy: "Ada",
              version: 3,
            },
            "vault:p-1/s-1/BROKEN": { ref: "vault:p-1/s-1/BROKEN", cipher: "not-three-parts" },
          },
        },
      })
    );

    const n = await migrate.importSecrets();
    expect(n).toBe(1);

    const [row] = offered("secrets");
    expect(row).toMatchObject({
      workspace_id: "ws-1",
      ref: "vault:p-1/s-1/STRIPE_API_KEY",
      iv: CIPHER.iv,
      auth_tag: CIPHER.tag,
      ciphertext: CIPHER.ct,
      key_version: 1,
      version: 1,
    });
    // The combined string never survives into the row, and the secret's own
    // rotation count stays in `meta` rather than colliding with the row's
    // concurrency `version`.
    expect(row).not.toHaveProperty("cipher");
    expect(row.meta).toMatchObject({ version: 3, updatedBy: "Ada" });
    expect(JSON.stringify(row)).not.toContain("not-three-parts");
    expect(offers.find((o) => o.table === "secrets")?.opts).toMatchObject({
      onConflict: "workspace_id,ref",
      ignoreDuplicates: true,
    });
  });

  it("offers nothing at all when the data directory has no logs", async () => {
    for (const f of ["events.jsonl", "audit.jsonl", "secrets.json"])
      fs.rmSync(path.join(DATA, f), { force: true });
    expect(await migrate.importEvents(migrate.tenants(FileStore.db()))).toBe(0);
    expect(await migrate.importAudit()).toBe(0);
    expect(await migrate.importSecrets()).toBe(0);
    expect(offered("deployment_events")).toHaveLength(0);
    expect(offered("audit_events")).toHaveLength(0);
    expect(offered("secrets")).toHaveLength(0);
  });
});
