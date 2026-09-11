/**
 * The release path's contract: `apps`, `artifacts`, `releases` and
 * `backup_manifests`, asserted against every implementation of `Authority`.
 *
 * Same rules as `contract.test.ts`, and for the same reason — the point of two
 * implementations behind one interface is that no call site can tell which it
 * got, and the only way to keep that true is to write the behaviour down once
 * and run it against both. Every `it` is phrased as something a caller relies
 * on: "the number a publish takes is never handed out twice", "a stale fence
 * cannot repoint a live app", "the newest manifest is the one a restore gets".
 *
 * Unlike `contract.test.ts`, the app every scenario hangs off is seeded
 * **through `repos.apps.insert`** rather than raw. That file predates the
 * Postgres `apps` repository and had no choice; this one is partly about that
 * repository, so seeding through it is both the setup and the first assertion.
 *
 * **The Postgres row is skipped unless you ask for it**, with both
 * `ZENITH_CONTRACT_POSTGRES=1` and `SUPABASE_DB_URL`, because it writes to a
 * real Supabase project. Every id is inside this run's namespace (`contract-…`,
 * or the hex namespace for `artifacts.digest`, which the schema constrains to
 * 64 hex characters), and `afterAll` deletes exactly those rows in reverse
 * foreign-key order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDataDir } from "../../_fixtures";

isolatedDataDir("zenith-authority-release-");

const { nowIso } = await import("@/lib/hosted/authority");
const { contractHex, contractId, loadAuthorities } = await import("./_factories");

const authorities = await loadAuthorities();

/** A full provenance record, so the round trip proves the whole nested object survives. */
const provenance = (jobId: string) =>
  ({
    sourceDigest: contractHex(),
    sourceKind: "tarball" as const,
    jobId,
    recipe: {
      id: "vite-react-v1" as const,
      vite: "5.4.0",
      pluginReact: "4.3.1",
      react: "18.3.1",
      node: "20.11.0",
    },
    contractVersion: 1 as const,
    schemaVersion: 1 as const,
    builtBy: "recipe-local" as const,
    buildBoundary: "the runner's own words about its isolation boundary",
    builtAt: nowIso(),
  });

describe.each(authorities)("$name", (factory) => {
  let a: Awaited<ReturnType<typeof factory.open>>;

  const workspaceId = contractId("ws");

  /** Create an app through the repository and answer with its id. */
  const makeApp = async (label: string): Promise<string> => {
    const id = contractId(label);
    await a.repos.apps.insert({
      id,
      workspaceId,
      slug: contractId(`${label}-slug`),
      name: `Contract ${label}`,
      createdBy: contractId("who"),
      runtime: "local",
    });
    return id;
  };

  /** Index an artifact through the repository and answer with its digest. */
  const makeArtifact = async (): Promise<string> => {
    const digest = contractHex();
    await a.repos.artifacts.insert({
      digest,
      byteSize: 4_096,
      fileCount: 12,
      provenance: provenance(contractId("job")),
    });
    return digest;
  };

  beforeAll(async () => {
    a = await factory.open();
  });

  afterAll(async () => {
    await factory.close(a);
  });

  /* --------------------------------- apps ---------------------------------- */

  describe("apps", () => {
    it("hands back exactly what was stored, by id and by slug", async () => {
      const id = contractId("app-round");
      const slug = contractId("app-round-slug");
      const createdAt = nowIso();
      const inserted = await a.repos.apps.insert({
        id,
        workspaceId,
        slug,
        name: "Round trip",
        createdBy: contractId("who"),
        runtime: "cloudflare",
        state: "suspended",
        stateReason: "waiting on the owner",
        createdAt,
      });
      // The record `insert` returns is the record the database holds — not a
      // hopeful copy of the input that a later read would contradict.
      expect(inserted).toEqual({
        id,
        workspaceId,
        slug,
        name: "Round trip",
        contractVersion: 1,
        schemaVersion: 1,
        state: "suspended",
        stateReason: "waiting on the owner",
        createdBy: inserted.createdBy,
        createdAt,
        updatedAt: createdAt,
        activeReleaseId: null,
        activeFence: 0,
        runtime: "cloudflare",
      });
      expect(await a.repos.apps.get(id)).toEqual(inserted);
      expect(await a.repos.apps.getBySlug(slug)).toEqual(inserted);
      expect(await a.repos.apps.getBySlug(contractId("nobody"))).toBeNull();
      expect(await a.repos.apps.get(contractId("nobody"))).toBeNull();
    });

    it("defaults a new app to active with no reason and no release", async () => {
      const id = await makeApp("app-default");
      expect(await a.repos.apps.get(id)).toMatchObject({
        state: "active",
        stateReason: undefined,
        activeReleaseId: null,
        activeFence: 0,
      });
    });

    it("lists a workspace oldest first, and the whole install includes it", async () => {
      const first = contractId("list-a");
      const second = contractId("list-b");
      const ws = contractId("list-ws");
      const base = Date.parse(nowIso());
      for (const [id, offset] of [
        [second, 1_000],
        [first, 0],
      ] as const)
        await a.repos.apps.insert({
          id,
          workspaceId: ws,
          slug: contractId(`${id}-slug`),
          name: id,
          createdBy: contractId("who"),
          runtime: "local",
          createdAt: nowIso(base + offset),
        });
      // Oldest first, and the insert order was deliberately the other way round.
      expect((await a.repos.apps.listByWorkspace(ws)).map((app) => app.id)).toEqual([first, second]);
      expect(await a.repos.apps.listByWorkspace(contractId("empty-ws"))).toEqual([]);
      const all = (await a.repos.apps.listAll()).map((app) => app.id);
      expect(all).toContain(first);
      expect(all).toContain(second);
    });

    it("changes only the fields a patch names, and clears a reason only when told to", async () => {
      const id = await makeApp("app-patch");
      const before = await a.repos.apps.get(id);

      const renamed = await a.repos.apps.update(id, { name: "Renamed" });
      expect(renamed).toMatchObject({ name: "Renamed", state: "active", runtime: "local" });

      const suspended = await a.repos.apps.update(id, {
        state: "suspended",
        stateReason: "the owner asked",
      });
      expect(suspended).toMatchObject({ state: "suspended", stateReason: "the owner asked" });
      // `undefined` leaves the reason alone; only an explicit null clears it.
      expect(await a.repos.apps.update(id, { state: "recovering" })).toMatchObject({
        state: "recovering",
        stateReason: "the owner asked",
      });
      expect(await a.repos.apps.update(id, { stateReason: null })).toMatchObject({
        state: "recovering",
        stateReason: undefined,
      });
      expect(await a.repos.apps.update(id, { runtime: "cloudflare" })).toMatchObject({
        runtime: "cloudflare",
      });
      expect(await a.repos.apps.update(contractId("nobody"), { name: "x" })).toBeNull();

      // An empty patch is a read: nothing moves, not even the stamp.
      const untouched = await a.repos.apps.update(id, {});
      expect(untouched!.updatedAt).toBe((await a.repos.apps.get(id))!.updatedAt);
      expect(untouched!.createdAt).toBe(before!.createdAt);
    });

    it("refuses a second app with a slug that is already taken", async () => {
      const slug = contractId("dup-slug");
      const insert = (id: string) =>
        a.repos.apps.insert({
          id,
          workspaceId,
          slug,
          name: "Slug",
          createdBy: contractId("who"),
          runtime: "local",
        });
      await insert(contractId("slug-a"));
      await expect(insert(contractId("slug-b"))).rejects.toBeDefined();
    });
  });

  /* ------------------------------- artifacts -------------------------------- */

  describe("artifacts", () => {
    it("indexes a digest once, and tells the second caller it was already there", async () => {
      const digest = contractHex();
      const createdAt = nowIso();
      const first = await a.repos.artifacts.insert({
        digest,
        byteSize: 1_048_576,
        fileCount: 42,
        provenance: provenance(contractId("job-a")),
        createdAt,
      });
      expect(first.inserted).toBe(true);
      expect(first.artifact).toEqual({
        digest,
        byteSize: 1_048_576,
        fileCount: 42,
        provenance: first.artifact.provenance,
        createdAt,
      });
      // The whole nested provenance survives the round trip, recipe and all.
      expect(await a.repos.artifacts.get(digest)).toEqual(first.artifact);

      const second = await a.repos.artifacts.insert({
        digest,
        byteSize: 7,
        fileCount: 1,
        provenance: provenance(contractId("job-b")),
      });
      // Create-only: the record handed back is the one that exists, not the one
      // this call tried to write.
      expect(second.inserted).toBe(false);
      expect(second.artifact).toEqual(first.artifact);
    });

    it("stamps a verification exactly once a digest is known", async () => {
      const digest = await makeArtifact();
      expect(await a.repos.artifacts.get(digest)).toMatchObject({ verifiedAt: undefined });
      const at = nowIso();
      expect(await a.repos.artifacts.markVerified(digest, at)).toBe(true);
      expect(await a.repos.artifacts.get(digest)).toMatchObject({ verifiedAt: at });
      expect(await a.repos.artifacts.markVerified(contractHex())).toBe(false);
    });

    it("lists newest first", async () => {
      const base = Date.parse(nowIso());
      const digests: string[] = [];
      for (const offset of [0, 1_000, 2_000]) {
        const digest = contractHex();
        digests.push(digest);
        await a.repos.artifacts.insert({
          digest,
          byteSize: 1,
          fileCount: 1,
          provenance: provenance(contractId("job")),
          createdAt: nowIso(base + offset),
        });
      }
      // Filtered to this scenario's own rows: the table is shared with every
      // other artifact the project holds, and "newest first" is a claim about
      // order, not about what else exists.
      const listed = (await a.repos.artifacts.list({ limit: 500 }))
        .map((artifact) => artifact.digest)
        .filter((digest) => digests.includes(digest));
      expect(listed).toEqual([...digests].reverse());
    });
  });

  /* -------------------------------- releases -------------------------------- */

  describe("releases", () => {
    let appId: string;
    let digest: string;

    beforeAll(async () => {
      appId = await makeApp("rel-app");
      digest = await makeArtifact();
    });

    /** Record a candidate release for this block's app. */
    const makeRelease = async (label: string, fields: { number: number; status?: "candidate" | "active" }) => {
      const id = contractId(label);
      await a.repos.releases.insert({
        id,
        appId,
        number: fields.number,
        artifactDigest: digest,
        jobId: contractId("job"),
        runtime: "local",
        status: fields.status,
      });
      return id;
    };

    it("hands back exactly what was stored, runtime reference and all", async () => {
      const id = contractId("rel-round");
      const createdAt = nowIso();
      const runtimeRef = {
        deploymentId: "dep_abc123",
        previewHost: "candidate.example.test",
        nested: { scriptName: "worker-1", routes: ["/", "/api"] },
      };
      const inserted = await a.repos.releases.insert({
        id,
        appId,
        number: await a.tx((repos) => repos.releases.nextNumber(appId)),
        artifactDigest: digest,
        jobId: contractId("job"),
        runtime: "cloudflare",
        runtimeRef,
        createdAt,
      });
      expect(inserted).toEqual({
        id,
        appId,
        number: inserted.number,
        artifactDigest: digest,
        schemaVersion: 1,
        jobId: inserted.jobId,
        status: "candidate",
        runtime: "cloudflare",
        runtimeRef,
        createdAt,
      });
      const stored = await a.repos.releases.get(id);
      expect(stored).toEqual({
        ...inserted,
        probe: undefined,
        verifiedAt: undefined,
        activatedAt: undefined,
        supersededAt: undefined,
        error: undefined,
      });
      expect(await a.repos.releases.get(contractId("nobody"))).toBeNull();
    });

    it("records a probe result and a runtime reference after the fact", async () => {
      const id = await makeRelease("rel-probe", { number: await a.tx((r) => r.releases.nextNumber(appId)) });
      const probe = {
        ok: false,
        checkedAt: nowIso(),
        checks: [
          { id: "index", ok: true, detail: "200 in 41ms" },
          { id: "session", ok: false, detail: "401 from the session endpoint" },
        ],
        testDatabase: "zenith_test_disposable",
      };
      expect(await a.repos.releases.setProbe(id, probe)).toBe(true);
      expect((await a.repos.releases.get(id))!.probe).toEqual(probe);

      const runtimeRef = { deploymentId: "dep_late", staged: true };
      expect(await a.repos.releases.setRuntimeRef(id, runtimeRef)).toBe(true);
      expect((await a.repos.releases.get(id))!.runtimeRef).toEqual(runtimeRef);

      expect(await a.repos.releases.setProbe(contractId("nobody"), probe)).toBe(false);
      expect(await a.repos.releases.setRuntimeRef(contractId("nobody"), runtimeRef)).toBe(false);
    });

    it("lists an app's releases newest number first", async () => {
      const listing = await makeApp("rel-list-app");
      const ids: string[] = [];
      for (const number of [1, 2, 3]) {
        const id = contractId(`rel-list-${number}`);
        ids.push(id);
        await a.repos.releases.insert({
          id,
          appId: listing,
          number,
          artifactDigest: digest,
          jobId: contractId("job"),
          runtime: "local",
        });
      }
      expect((await a.repos.releases.listByApp(listing)).map((release) => release.id)).toEqual(
        [...ids].reverse()
      );
      expect((await a.repos.releases.listByApp(listing, { limit: 1 })).map((r) => r.number)).toEqual([3]);
      expect(await a.repos.releases.listByApp(contractId("nobody"))).toEqual([]);
    });

    it("never hands the same release number to two publishes at once", async () => {
      // The property a publish depends on, and the one the two stores reach
      // differently: SQLite serialises writers, Postgres has to take the app
      // row's lock. Either way, two concurrent transactions must come out with
      // two different numbers and both must commit.
      const racing = await makeApp("rel-race-app");
      const take = (label: string) =>
        a.tx(async (repos) => {
          const number = await repos.releases.nextNumber(racing);
          return repos.releases.insert({
            id: contractId(label),
            appId: racing,
            number,
            artifactDigest: digest,
            jobId: contractId("job"),
            runtime: "local",
          });
        });
      const [first, second] = await Promise.all([take("race-a"), take("race-b")]);
      expect(new Set([first.number, second.number]).size).toBe(2);
      expect([first.number, second.number].sort()).toEqual([1, 2]);
      // And the next one carries on from there rather than repeating either.
      expect(await a.tx((repos) => repos.releases.nextNumber(racing))).toBe(3);
    });

    it("refuses a second release with a number this app has already used", async () => {
      const collide = await makeApp("rel-collide-app");
      const insert = (id: string) =>
        a.repos.releases.insert({
          id,
          appId: collide,
          number: 1,
          artifactDigest: digest,
          jobId: contractId("job"),
          runtime: "local",
        });
      await insert(contractId("collide-a"));
      // `unique (app_id, number)` is the backstop behind `nextNumber`, and the
      // database is what enforces it on both stores.
      await expect(insert(contractId("collide-b"))).rejects.toBeDefined();
    });

    it("moves the status along with its stamps, and never unsets one", async () => {
      const id = await makeRelease("rel-status", {
        number: await a.tx((r) => r.releases.nextNumber(appId)),
      });
      const verifiedAt = nowIso();
      expect(await a.repos.releases.setStatus(id, "verified", { verifiedAt })).toBe(true);
      expect(await a.repos.releases.get(id)).toMatchObject({ status: "verified", verifiedAt });

      const activatedAt = nowIso(Date.now() + 1_000);
      expect(await a.repos.releases.setStatus(id, "active", { activatedAt })).toBe(true);
      // A stamp a later transition does not name is kept: the history of when
      // this release was verified does not stop being true when it goes live.
      expect(await a.repos.releases.get(id)).toMatchObject({
        status: "active",
        verifiedAt,
        activatedAt,
      });
      expect(await a.repos.releases.setStatus(id, "failed", { error: "the probe never passed" })).toBe(true);
      expect(await a.repos.releases.get(id)).toMatchObject({
        status: "failed",
        verifiedAt,
        activatedAt,
        error: "the probe never passed",
      });
      expect(await a.repos.releases.setStatus(contractId("nobody"), "active")).toBe(false);
    });

    it("supersedes every other active release when one is activated", async () => {
      const app = await makeApp("rel-supersede-app");
      const active = async (label: string, number: number) => {
        const id = contractId(label);
        await a.repos.releases.insert({
          id,
          appId: app,
          number,
          artifactDigest: digest,
          jobId: contractId("job"),
          runtime: "local",
          status: "active",
        });
        return id;
      };
      const old = await active("sup-old", 1);
      const older = await active("sup-older", 2);
      const winner = await active("sup-winner", 3);
      const at = nowIso();

      expect(await a.repos.releases.markSuperseded(app, winner, at)).toBe(2);
      for (const id of [old, older])
        expect(await a.repos.releases.get(id)).toMatchObject({
          status: "superseded",
          supersededAt: at,
        });
      expect(await a.repos.releases.get(winner)).toMatchObject({
        status: "active",
        supersededAt: undefined,
      });
      // Exactly one active release is left, which is the invariant the whole
      // tidy-up exists for — and a second sweep has nothing left to do.
      expect((await a.repos.releases.listByApp(app)).filter((r) => r.status === "active")).toHaveLength(1);
      expect(await a.repos.releases.markSuperseded(app, winner, at)).toBe(0);
    });
  });

  /* ------------------------- the active-release fence ------------------------ */

  describe("the active release pointer", () => {
    it("moves only for the worker holding the current fence", async () => {
      const app = await makeApp("fence-app");
      const digest = await makeArtifact();
      const release = async (label: string, number: number) => {
        const id = contractId(label);
        await a.repos.releases.insert({
          id,
          appId: app,
          number,
          artifactDigest: digest,
          jobId: contractId("job"),
          runtime: "local",
        });
        return id;
      };
      const first = await release("fence-r1", 1);
      const second = await release("fence-r2", 2);

      const at = nowIso();
      expect(await a.repos.apps.setActiveRelease(app, first, 0, at)).toBe(true);
      expect(await a.repos.apps.get(app)).toMatchObject({
        activeReleaseId: first,
        activeFence: 1,
        updatedAt: at,
      });

      // The worker that was asleep still holds fence 0. Silently false, and
      // nothing written — a live hostname must not move for a stale token.
      expect(await a.repos.apps.setActiveRelease(app, second, 0)).toBe(false);
      expect(await a.repos.apps.get(app)).toMatchObject({ activeReleaseId: first, activeFence: 1 });

      expect(await a.repos.apps.setActiveRelease(app, second, 1)).toBe(true);
      expect(await a.repos.apps.get(app)).toMatchObject({ activeReleaseId: second, activeFence: 2 });
      // An app that does not exist is the same silent refusal, not a throw.
      expect(await a.repos.apps.setActiveRelease(contractId("nobody"), second, 0)).toBe(false);
    });
  });

  /* -------------------------------- backups --------------------------------- */

  describe("backup manifests", () => {
    it("hands back exactly what was stored, per-file hashes and all", async () => {
      const id = contractId("backup-round");
      const createdAt = nowIso();
      const files = [
        { name: "authority.sqlite", sha256: contractHex(), bytes: 1_048_576 },
        { name: "artifacts/index.json", sha256: contractHex(), bytes: 2_048 },
      ];
      const manifest = await a.repos.backups.insert({
        id,
        digest: contractHex(),
        byteSize: 1_050_624,
        files,
        revocationSeq: 97,
        keyId: contractId("key"),
        createdAt,
      });
      expect(manifest).toMatchObject({ id, createdAt, byteSize: 1_050_624, revocationSeq: 97, files });
      const listed = (await a.repos.backups.list({ limit: 500 })).find((m) => m.id === id);
      expect(listed).toEqual(manifest);
    });

    it("lists newest first, and the latest is the first of that list", async () => {
      const base = Date.parse(nowIso());
      const ids: string[] = [];
      for (const offset of [0, 1_000, 2_000]) {
        const id = contractId(`backup-${offset}`);
        ids.push(id);
        await a.repos.backups.insert({
          id,
          digest: contractHex(),
          byteSize: offset,
          files: [],
          revocationSeq: offset,
          keyId: contractId("key"),
          createdAt: nowIso(base + offset),
        });
      }
      const listed = (await a.repos.backups.list({ limit: 500 }))
        .map((manifest) => manifest.id)
        .filter((id) => ids.includes(id));
      expect(listed).toEqual([...ids].reverse());
      // `latest()` is not a separate ordering — it is this list's head, which is
      // what makes "the newest manifest" mean one thing on both stores.
      expect(await a.repos.backups.latest()).toEqual((await a.repos.backups.list({ limit: 1 }))[0]);
    });
  });
});
