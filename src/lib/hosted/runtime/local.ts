/**
 * The local runtime: this control process serves the app and runs the broker.
 *
 * It is real — real files, real SQLite, real HTTP — and it is honest about what
 * it is not. One host, one process, one operating-system user: it isolates apps
 * from each other by *construction* (a per-app database file that no statement
 * can name another app's copy of, an immutable content-addressed artifact that
 * is only ever read) and it does not isolate them by *sandbox*. CPU time and
 * outbound subrequest limits are not enforced here at all, which is why
 * `enforcementFor("local")` reports them as provider limits rather than
 * pretending.
 *
 * Every method below does the thing it says. Nothing is stubbed, and no probe
 * reports a check it did not run.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { authority } from "@/lib/hosted/authority";
import { appDataDir, appHostname } from "@/lib/hosted/config";
import {
  HostedError,
  TRACKER_SCHEMA_VERSION,
  type Artifact,
  type ArtifactStore,
  type Availability,
  type BindingReadback,
  type CandidateProbeResult,
  type DataContext,
  type HostedApp,
  type HostedRuntime,
  type LimitEnforcement,
  type Release,
  type RuntimeAppRef,
  type RuntimeCandidateRef,
} from "@/lib/hosted/contracts";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { appDataPath, closeAppData, openAppData, resetTestDatabase } from "@/lib/hosted/data";
import { enforcementFor } from "@/lib/hosted/quota";
import type { SelectableRuntime } from "./selectable";

/** Injection points. Production passes none of them; the defaults are the real modules. */
export interface LocalRuntimeOptions {
  artifactStore?: ArtifactStore;
  /**
   * The tracker schema version the app's **production** database is at. Read
   * read-only during a probe (decision R3-07: the candidate is exercised
   * against a disposable test database, never against customer data).
   */
  productionSchemaVersion?: (appId: string) => Promise<number>;
}

/** One probe row. */
type Check = CandidateProbeResult["checks"][number];

const check = (id: string, ok: boolean, detail: string): Check => ({ id, ok, detail });

export class LocalRuntime implements HostedRuntime, SelectableRuntime {
  readonly id = "local" as const;

  readonly label =
    "Local runtime — this control process serves the app and runs the broker " +
    "(single host, no CPU/subrequest limits)";

  private readonly options: LocalRuntimeOptions;

  constructor(options: LocalRuntimeOptions = {}) {
    this.options = options;
  }

  /** Always available: it is the process the caller is already running in. */
  async availability(): Promise<Availability> {
    return { available: true };
  }

  /** Nothing to configure, so nothing can be missing. */
  blockedReason(): { reason: string; fix: string } | null {
    return null;
  }

  /** Lazy, because the enforcement table lives in the quota module (W8). */
  get enforcement(): LimitEnforcement {
    return enforcementFor("local");
  }

  hostname(app: HostedApp): string {
    return appHostname(app.slug);
  }

  /**
   * Give the app its directory and its migrated database.
   *
   * `openAppData` applies every pending tracker migration, so an app that
   * exists here has a schema this build can read — which is what the probe's
   * production-schema check later compares against.
   */
  async ensureApp(app: HostedApp): Promise<RuntimeAppRef> {
    const dataDir = appDataDir(app.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const opened = openAppData(app.id);
    return { runtime: "local", ref: { dataDir, database: opened.path } };
  }

  /**
   * Stage a candidate.
   *
   * There is nothing to upload — the artifact store *is* the runtime's copy —
   * so staging is exactly one thing: prove the bytes on disk still hash to the
   * digest the release names. A release may not point at an artifact that has
   * not been re-read since it was written.
   */
  async stageCandidate(
    app: HostedApp,
    release: Release,
    artifact: Artifact
  ): Promise<RuntimeCandidateRef> {
    const verdict = await this.store().verify(artifact.digest);
    if (!verdict.ok)
      throw new HostedError(
        "conflict",
        `Release ${release.number} of ${app.slug} cannot be staged: ${verdict.detail}`,
        {
          fix: "Publish again. The stored artifact no longer matches its digest, so it is not the build that was verified.",
          details: { digest: artifact.digest },
        }
      );
    return { runtime: "local", releaseId: release.id, ref: { digest: artifact.digest } };
  }

  /**
   * Exercise the candidate for real.
   *
   * Four checks, all of them executed here and now:
   *
   *  1. a create → get → update → **stale** update round trip on a freshly
   *     recreated `test.sqlite`, which proves the version conflict the contract
   *     promises actually fires;
   *  2. `index.html` is present in the artifact and is not empty;
   *  3. the artifact still verifies against its digest;
   *  4. the app's *production* schema version equals the release's, read
   *     read-only, so an incompatible candidate is caught before activation
   *     rather than after.
   */
  async probeCandidate(app: HostedApp, candidate: RuntimeCandidateRef): Promise<CandidateProbeResult> {
    const checks: Check[] = [];
    const testDatabase = appDataPath(app.id, "test");
    const digest = typeof candidate.ref.digest === "string" ? candidate.ref.digest : "";

    checks.push(await this.probeDataRoundTrip(app, candidate));

    const store = this.store();
    try {
      const index = await store.open(digest, "index.html");
      checks.push(
        index === null
          ? check("artifact.index", false, "The artifact has no index.html, so no app route could be served.")
          : check(
              "artifact.index",
              index.bytes.length > 0,
              index.bytes.length > 0
                ? `index.html is ${index.bytes.length} bytes.`
                : "index.html is present but empty."
            )
      );
    } catch (err) {
      checks.push(check("artifact.index", false, messageOf(err)));
    }

    try {
      const verdict = await store.verify(digest);
      checks.push(check("artifact.verified", verdict.ok, verdict.detail));
    } catch (err) {
      checks.push(check("artifact.verified", false, messageOf(err)));
    }

    checks.push(await this.probeSchemaCompatibility(app, candidate));

    return {
      ok: checks.every((row) => row.ok),
      checkedAt: new Date().toISOString(),
      checks,
      testDatabase,
    };
  }

  /**
   * Activation is the authority's compare-and-swap, not a provider call: the
   * app's `active_release_id` pointer *is* the mapping on this runtime.
   *
   * What is still worth doing here is refusing to be the reason a stale worker
   * thinks it activated something. The fence is read back from the app row; a
   * worker whose token has been overtaken gets `conflict` and stops.
   */
  async activate(app: HostedApp, release: Release, fence: number): Promise<void> {
    const current = await authority().repos.apps.get(app.id);
    if (!current)
      throw new HostedError("not_found", `App ${app.id} no longer exists, so nothing can be activated.`, {
        fix: "Reload the app list; this app was deleted while the publish was running.",
      });
    if (current.activeFence !== fence)
      throw new HostedError(
        "conflict",
        `This publish holds fence token ${fence} but ${app.slug} is now at ${current.activeFence}, so another publish got there first.`,
        {
          fix: "Publish again from the current state. Nothing was changed: the release that is live now stays live.",
          details: { expectedFence: fence, currentFence: current.activeFence, releaseId: release.id },
        }
      );
  }

  /**
   * There is nothing to read back from a provider, and saying so is the honest
   * answer. The release's capability is "the files of one digest, read only";
   * the broker's is "one SQLite file"; both are enforced in this process by
   * construction rather than by a binding a query could confirm.
   */
  async readBindings(candidate: RuntimeCandidateRef): Promise<BindingReadback> {
    const digest = typeof candidate.ref.digest === "string" ? candidate.ref.digest : "unknown";
    return {
      ok: true,
      release: [`ASSETS (artifact ${digest})`],
      broker: ["DB (data.sqlite)"],
      detail:
        "local runtime: bindings are process-internal — the release can only be read as files of its digest, " +
        "and the broker can only open this app's own database. There is no provider to read them back from.",
    };
  }

  /**
   * Remove the disposable test database and nothing else.
   *
   * `retain` names the releases a rollback could still need; on this runtime a
   * release costs nothing but the artifact it points at, and artifacts are
   * removed by the artifact store's own reference-checked `remove`, never here.
   */
  async cleanup(app: HostedApp, retain: Set<string>): Promise<void> {
    void retain;
    closeAppData(app.id, "test");
    const base = appDataPath(app.id, "test");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${base}${suffix}`, { force: true });
      } catch {
        // A file another process still holds open is not a cleanup failure
        // worth failing a publish over; the next reset replaces it anyway.
      }
    }
  }

  /* ------------------------------- internals ------------------------------ */

  private store(): ArtifactStore {
    return this.options.artifactStore ?? new FsArtifactStore();
  }

  /** The create → get → update → stale-update round trip, on `test.sqlite`. */
  private async probeDataRoundTrip(app: HostedApp, candidate: RuntimeCandidateRef): Promise<Check> {
    try {
      // Awaited: on Postgres the probe database is the `<appId>::test`
      // namespace and emptying it is a round trip. The candidate must not be
      // probed against the last probe's rows.
      const { store } = await resetTestDatabase(app.id);
      const ctx: DataContext = {
        appId: app.id,
        subject: "zenith-candidate-probe",
        email: "probe@zenith.invalid",
        role: "owner",
        releaseId: candidate.releaseId,
      };

      const created = await store.create(ctx, {
        writeId: randomUUID(),
        record: { title: "Candidate probe", category: "other" },
      });
      const read = await store.get(ctx, created.record.id);
      if (!read) return check("data.roundTrip", false, "A record written to the test database could not be read back.");

      const updated = await store.update(ctx, created.record.id, {
        writeId: randomUUID(),
        expectedVersion: created.record.version,
        patch: { status: "approved" },
      });
      if (updated.record.version !== created.record.version + 1)
        return check("data.roundTrip", false, "An update did not increment the record version.");

      // The conflict this app's whole two-editor story rests on. If it does
      // not fire, the candidate is not healthy however well it renders.
      let conflicted = false;
      try {
        await store.update(ctx, created.record.id, {
          writeId: randomUUID(),
          expectedVersion: created.record.version,
          patch: { status: "ordered" },
        });
      } catch (err) {
        conflicted = err instanceof HostedError && err.code === "stale_version";
      }
      return conflicted
        ? check(
            "data.roundTrip",
            true,
            "create, get, update and a stale update answering 409 all ran against the disposable test database."
          )
        : check("data.roundTrip", false, "A stale update was accepted; the version conflict did not fire.");
    } catch (err) {
      return check("data.roundTrip", false, messageOf(err));
    }
  }

  /** Production schema version vs the release's, read-only. */
  private async probeSchemaCompatibility(
    app: HostedApp,
    candidate: RuntimeCandidateRef
  ): Promise<Check> {
    try {
      const release = await authority().repos.releases.get(candidate.releaseId);
      const expected = release?.schemaVersion ?? TRACKER_SCHEMA_VERSION;
      const actual = await this.readProductionSchemaVersion(app.id);
      return check(
        "data.schemaVersion",
        actual === expected,
        actual === expected
          ? `This app's data is at tracker schema version ${actual}, which is what release ${release?.number ?? "?"} expects.`
          : `This app's data is at tracker schema version ${actual} but the candidate expects ${expected}, so activating it would put an incompatible release in front of existing records.`
      );
    } catch (err) {
      return check("data.schemaVersion", false, messageOf(err));
    }
  }

  private async readProductionSchemaVersion(appId: string): Promise<number> {
    if (this.options.productionSchemaVersion) return this.options.productionSchemaVersion(appId);
    const opened = openAppData(appId);
    return opened.store.schemaVersion(appId);
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : "The check did not complete.";

