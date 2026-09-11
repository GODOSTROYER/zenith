/**
 * Reopening an app after a restore — the deliberate second step.
 *
 * A restore leaves apps `recovering` and, when it could not prove what was
 * revoked, every grant `needs_reapproval`. Nothing reopens itself. This is the
 * function that does, and it refuses in two different ways for two different
 * reasons:
 *
 *  - **Held grants** are a *judgement*, not a fault. Someone has to look at
 *    who is on the list and say "yes, these people should still have access".
 *    Passing `acknowledgeReapproval: true` is that statement, recorded with
 *    the operator's name — and it does not silently re-activate the grants: it
 *    says the operator has seen that they are held. Re-approving each one is
 *    W5's grant surface.
 *  - **Failed checks** are a *fact*. A corrupt database, a missing artifact or
 *    a schema the active release cannot read are not things an operator can
 *    acknowledge away, so no flag overrides them.
 *
 * The checks run against this process's own authority, which is the point:
 * after a clean-host restore you start the control service with
 * `ORRERY_DATA=<the restored directory>` and reopen from inside it, so what is
 * verified is what will actually be served.
 */
import { HostedError, type ArtifactStore, type HostedApp } from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { LATEST_TRACKER_SCHEMA_VERSION, openAppData } from "@/lib/hosted/data";
import { recordEvent } from "@/lib/hosted/events";

/** One probe and its verdict. Same shape as the health checks, on purpose. */
export interface ReopenCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** How a reopen is asked for. */
export interface ReopenOptions {
  /** Who is reopening it. Recorded on the app and in the event. */
  operator: string;
  /** The operator has seen that grants are held for re-approval and reopens anyway. */
  acknowledgeReapproval?: boolean;
  /** Injected in tests; production uses the configured artifact store. */
  artifacts?: ArtifactStore;
}

/** What a successful reopen answers with. */
export interface ReopenResult {
  app: HostedApp;
  checks: ReopenCheck[];
  grantsNeedingReapproval: number;
  detail: string;
}

/**
 * Run the post-restore checks and, if every one passes, put the app back to
 * `active`.
 *
 * Throws a `HostedError` carrying the full check list in `details` when
 * anything fails, so a script or a screen can show exactly which probe said no.
 */
export async function reopenApp(appId: string, options: ReopenOptions): Promise<ReopenResult> {
  const a = authority();
  const app = a.repos.apps.get(appId);
  if (!app)
    throw new HostedError("not_found", `No hosted app has the id ${appId}.`, {
      fix: "List the restored apps with scripts/hosted/restore.ts's report, or from the control authority, and reopen one of those ids.",
    });

  const held = a.repos.grants.listByApp(appId).filter((grant) => grant.state === "needs_reapproval");
  if (held.length > 0 && options.acknowledgeReapproval !== true)
    throw new HostedError(
      "recovering",
      `${app.slug} has ${held.length} grant(s) held for re-approval after a restore, so it will not be reopened automatically.`,
      {
        fix: "Review who is on the list and re-approve the people who should still have access, then reopen with acknowledgeReapproval: true (scripts/hosted/reopen.ts --acknowledge-reapproval). Reopening does not re-approve anybody; held grants stay held until an owner acts on each one.",
        details: {
          appId,
          heldGrants: held.map((grant) => ({ id: grant.id, email: grant.email, role: grant.role })),
        },
      }
    );

  const checks = await runChecks(app, options.artifacts ?? new FsArtifactStore());
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0)
    throw new HostedError(
      "recovering",
      `${app.slug} did not pass its post-restore checks: ${failed.map((check) => check.detail).join(" ")}`,
      {
        fix: "Fix what the failing check names — restore the artifact store, restore a different backup, or publish a release compatible with the restored schema — then reopen again. An app that fails these checks would serve errors or the wrong bytes.",
        details: { appId, checks },
      }
    );

  const now = new Date().toISOString();
  const reopened = a.tx(() =>
    a.repos.apps.update(appId, { state: "active", stateReason: null }, now)
  );
  if (!reopened)
    throw new HostedError("internal", `App ${appId} disappeared while it was being reopened.`, {
      fix: "Re-read the app and try again; another process changed it at the same moment.",
    });

  recordEvent({
    event: "app.resumed",
    workspaceId: app.workspaceId,
    appId,
    releaseId: app.activeReleaseId ?? undefined,
    logicalId: `reopen:${appId}:${now}`,
    props: {
      operator: options.operator,
      checks: checks.length,
      acknowledgedReapproval: options.acknowledgeReapproval === true,
      grantsHeld: held.length,
    },
  });

  return {
    app: reopened,
    checks,
    grantsNeedingReapproval: held.length,
    detail:
      held.length === 0
        ? `${app.slug} passed ${checks.length} checks and is active again.`
        : `${app.slug} passed ${checks.length} checks and is active again. ${held.length} grant(s) remain held for re-approval and those people still cannot open it.`,
  };
}

/** The four things that have to be true before an app serves again. */
async function runChecks(app: HostedApp, artifacts: ArtifactStore): Promise<ReopenCheck[]> {
  const a = authority();
  const checks: ReopenCheck[] = [];

  checks.push(pragmaCheck("control.quick_check", () => a.db.prepare("PRAGMA quick_check").all()));

  try {
    const data = openAppData(app.id);
    checks.push(pragmaCheck("data.quick_check", () => data.backend.all("PRAGMA quick_check")));
    const version = await data.store.schemaVersion(app.id);
    checks.push({
      id: "schema_version",
      ok: version === LATEST_TRACKER_SCHEMA_VERSION,
      detail:
        version === LATEST_TRACKER_SCHEMA_VERSION
          ? `The restored data is at tracker schema version ${version}, which this build serves.`
          : `The restored data is at tracker schema version ${version} and this build serves version ${LATEST_TRACKER_SCHEMA_VERSION}.`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ id: "data.quick_check", ok: false, detail: `The app's data database could not be opened: ${detail}` });
    checks.push({ id: "schema_version", ok: false, detail: "Not checked: the data database could not be opened." });
  }

  if (!app.activeReleaseId) {
    checks.push({
      id: "active_release",
      ok: false,
      detail: "This app has no active release, so there is nothing for it to serve.",
    });
    return checks;
  }
  const release = a.repos.releases.get(app.activeReleaseId);
  if (!release) {
    checks.push({
      id: "active_release",
      ok: false,
      detail: `The active release pointer names ${app.activeReleaseId}, and the restored authority holds no such release.`,
    });
    return checks;
  }
  checks.push({
    id: "active_release",
    ok: true,
    detail: `Release ${release.number} (${release.id}) is the active pointer, status ${release.status}.`,
  });

  try {
    const verdict = await artifacts.verify(release.artifactDigest);
    checks.push({
      id: "artifact_verified",
      ok: verdict.ok,
      detail: verdict.ok
        ? `Artifact ${release.artifactDigest.slice(0, 12)} re-hashed from its stored bytes and matches: ${verdict.detail}`
        : `Artifact ${release.artifactDigest.slice(0, 12)} did not verify: ${verdict.detail}`,
    });
  } catch (error) {
    checks.push({
      id: "artifact_verified",
      ok: false,
      detail: `Artifact ${release.artifactDigest.slice(0, 12)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return checks;
}

/** `PRAGMA quick_check` as a check row. One row saying `ok` is the only pass. */
function pragmaCheck(id: string, read: () => unknown[]): ReopenCheck {
  try {
    const rows = read() as { quick_check?: unknown }[];
    const ok = rows.length === 1 && String(rows[0]?.quick_check) === "ok";
    return {
      id,
      ok,
      detail: ok
        ? "PRAGMA quick_check reported ok."
        : `PRAGMA quick_check reported: ${rows.map((row) => String(row?.quick_check)).join("; ") || "no result"}`,
    };
  } catch (error) {
    return { id, ok: false, detail: `PRAGMA quick_check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
