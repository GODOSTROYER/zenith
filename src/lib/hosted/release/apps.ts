/**
 * Creating and reading hosted apps.
 *
 * Creation is one transaction, and the reason is the grant. An app whose row
 * committed without its owner grant is an app nobody can publish to, invite to
 * or suspend — a locked room with the key inside — and the only way to be sure
 * that cannot happen is to write both in the same `tx()`. The runtime is asked
 * to prepare its side *after* the commit, because a provider call inside a
 * transaction holds a SQLite write lock across the network.
 *
 * When that runtime call fails the app still exists: the record is the durable
 * truth and the runtime is derived from it, so the honest outcome is an app
 * that says on its face why it is not ready yet (`stateReason`) rather than a
 * creation that half-happened and reported success.
 */
import { authority, nowIso } from "@/lib/hosted/authority";
import { appHostname, appOrigin, hostedConfig } from "@/lib/hosted/config";
import {
  HostedError,
  RESERVED_SLUGS,
  isValidAppSlug,
  type AppGrant,
  type HostedApp,
  type HostedJob,
  type Release,
  type Subject,
} from "@/lib/hosted/contracts";
import { releaseDeps } from "./deps";
import { emit, requireApp, requireAppIn } from "./shared";

/** How many releases past the active one a cleanup sweep keeps for rollback. */
export const RETAINED_RELEASES = 3;

/** What creating an app needs. `email` is the creator's verified address, for display only. */
export interface CreateAppInput {
  workspaceId: string;
  name: string;
  slug: string;
  createdBy: Subject;
  email: string;
}

const NAME_FIX = "Give the app a name between 1 and 60 characters — it is what the workspace list shows.";

const SLUG_FIX =
  "A slug is 3–40 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit. " +
  "It becomes the app's hostname, so it has to be a legal DNS label.";

/**
 * Create an app, its owner grant and its creation event in one transaction,
 * then ask the runtime to prepare its side.
 *
 * Asynchronous because of that last step alone: everything durable has already
 * committed by the time the runtime is called, and a runtime that refuses only
 * costs the app a `stateReason`.
 */
export async function createApp(input: CreateAppInput): Promise<HostedApp> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60)
    throw new HostedError("invalid_input", `"${input.name}" is not a usable app name.`, { fix: NAME_FIX });

  const slug = input.slug.trim().toLowerCase();
  if (!isValidAppSlug(slug))
    throw new HostedError(
      "invalid_input",
      RESERVED_SLUGS.has(slug)
        ? `"${slug}" is reserved for the platform, so no app can take it.`
        : `"${input.slug}" is not a usable app slug.`,
      { fix: RESERVED_SLUGS.has(slug) ? `Pick another slug — ${SLUG_FIX}` : SLUG_FIX }
    );

  const a = authority();
  const runtime = hostedConfig().ZENITH_RUNTIME;
  const created = await a.tx(async (repos) => {
    const taken = await repos.apps.getBySlug(slug);
    if (taken)
      throw new HostedError("conflict", `The slug "${slug}" is already an app on this install.`, {
        fix: `Every app has its own hostname, so slugs are unique across the install. Pick another one — "${slug}-2" or a name closer to what this app does.`,
        details: { slug },
      });

    const app = await repos.apps.insert({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      slug,
      name,
      createdBy: input.createdBy,
      runtime,
    });
    // The owner grant is why this is a transaction: an app without one is an
    // app nobody can operate.
    const grant = await repos.grants.insert({
      id: crypto.randomUUID(),
      appId: app.id,
      subject: input.createdBy,
      email: input.email.trim().toLowerCase(),
      role: "owner",
      grantedBy: input.createdBy,
    });
    await emit({
      event: "app.created",
      workspaceId: app.workspaceId,
      appId: app.id,
      subject: input.createdBy,
      outcome: "ok",
      logicalId: app.id,
      props: { runtime, slug: app.slug },
    });
    return { app, grant };
  });

  try {
    await releaseDeps.runtime().ensureApp(created.app);
  } catch (err) {
    // The app is real and the grant is real; only the runtime is not ready.
    // Say so on the record rather than pretending the creation failed.
    const reason =
      err instanceof HostedError
        ? `${err.message}${err.fix ? ` ${err.fix}` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    const patched = await a.repos.apps.update(created.app.id, { stateReason: reason });
    return patched ?? { ...created.app, stateReason: reason };
  }
  return (await a.repos.apps.get(created.app.id)) ?? created.app;
}

/** One app, or null. */
export const getApp = (appId: string): Promise<HostedApp | null> => authority().repos.apps.get(appId);

/** One app, refused with `not_found` when it is missing or belongs elsewhere. */
export const requireOwnedApp = (appId: string, workspaceId: string): Promise<HostedApp> =>
  requireAppIn(appId, workspaceId);

/** Every app in a workspace, oldest first. */
export const listApps = (workspaceId: string): Promise<HostedApp[]> =>
  authority().repos.apps.listByWorkspace(workspaceId);

/** What a screen needs about one app in a single read. */
export interface AppSummary {
  app: HostedApp;
  /** The release the stable hostname points at, or null before the first activation. */
  activeRelease: Release | null;
  releases: Release[];
  /** The publish, rollback or state change running right now, or null. */
  runningJob: HostedJob | null;
  /** The most recent jobs, newest first — the publish history a screen lists. */
  recentJobs: HostedJob[];
  hostname: string;
  origin: string;
  /** Active grants, so a list card can say who has access without an owner-only read. */
  grantCount: number;
  /** Pending invitations. */
  inviteCount: number;
}

/**
 * App, active release, history and running job in one read.
 *
 * TODO(ceiling): the hostname comes from `ZENITH_APP_DOMAIN` rather than from
 * `HostedRuntime.hostname(app)`. The two agree for both runtimes today (the
 * naming rule is the contract, not a runtime detail), and reading it from
 * config means a summary still renders when the runtime is unavailable —
 * which is exactly when someone needs to look at this screen.
 */
export async function appSummary(
  appId: string,
  opts: { jobs?: number; releases?: number } = {}
): Promise<AppSummary> {
  const a = authority();
  const app = await requireApp(appId);
  const releases = await a.repos.releases.listByApp(app.id, { limit: opts.releases ?? 50 });
  return {
    app,
    activeRelease: app.activeReleaseId ? await a.repos.releases.get(app.activeReleaseId) : null,
    releases,
    runningJob: await a.repos.jobs.runningFor(app.id),
    recentJobs: await a.repos.jobs.listByApp(app.id, { limit: opts.jobs ?? 20 }),
    hostname: appHostname(app.slug),
    origin: appOrigin(app.slug),
    grantCount: (await a.repos.grants.listByApp(app.id, { activeOnly: true })).length,
    inviteCount: (await a.repos.invites.listByApp(app.id, { state: "pending" })).length,
  };
}

/** Every grant on an app, newest first. Read directly; W5 owns the writes. */
export const appGrants = (appId: string): Promise<AppGrant[]> =>
  authority().repos.grants.listByApp(appId);

/**
 * The releases a cleanup sweep must keep: whatever is serving, plus the most
 * recent few, because those are what a rollback can still select.
 */
export async function retainedReleases(
  appId: string,
  keep: number = RETAINED_RELEASES
): Promise<Set<string>> {
  const a = authority();
  const app = await requireApp(appId);
  const retain = new Set<string>();
  if (app.activeReleaseId) retain.add(app.activeReleaseId);
  for (const release of await a.repos.releases.listByApp(appId, { limit: keep }))
    retain.add(release.id);
  return retain;
}

/** Move an app between states, recording why. Used by the suspend/resume jobs. */
export async function setAppState(
  appId: string,
  state: HostedApp["state"],
  reason: string | null
): Promise<HostedApp> {
  const updated = await authority().repos.apps.update(appId, { state, stateReason: reason }, nowIso());
  if (!updated)
    throw new HostedError("not_found", `No hosted app ${appId} exists.`, {
      fix: "The app was deleted while this job was queued. Nothing was changed.",
    });
  return updated;
}
