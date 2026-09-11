/**
 * The setup every W7 test repeats: import the hosted modules after
 * `isolatedDataDir()` has pinned ORRERY_DATA, open the authority, and wire the
 * release module's collaborators to doubles that answer.
 *
 * The imports are dynamic because `@/lib/env` reads ORRERY_DATA on first use
 * and the artifact store resolves its root from it — a static import at the
 * top of a test file would pin the developer's real `.data` directory.
 *
 * Not a test file — vitest only collects `*.test.ts`.
 */
import path from "node:path";
import type { ArtifactStore, HostedApp } from "@/lib/hosted/contracts";
import { buildRunnerDouble, runtimeDouble, usageDouble, type RuntimeDoubleOptions } from "./_doubles";

export interface Harness {
  authority: typeof import("@/lib/hosted/authority");
  release: typeof import("@/lib/hosted/release");
  contracts: typeof import("@/lib/hosted/contracts");
  artifacts: typeof import("@/lib/hosted/artifacts");
  data: typeof import("@/lib/hosted/data");
  store: ArtifactStore;
}

/** Import the hosted modules and open the authority in the isolated directory. */
export async function harness(dataDir: string): Promise<Harness> {
  const authority = await import("@/lib/hosted/authority");
  const release = await import("@/lib/hosted/release");
  const contracts = await import("@/lib/hosted/contracts");
  const artifacts = await import("@/lib/hosted/artifacts");
  const data = await import("@/lib/hosted/data");
  authority.openAuthority();
  return {
    authority,
    release,
    contracts,
    artifacts,
    data,
    store: new artifacts.FsArtifactStore(path.join(dataDir, "artifacts")),
  };
}

export interface WiringOptions extends Omit<RuntimeDoubleOptions, "store"> {
  /** A build-runner double to use instead of the default one. */
  build?: ReturnType<typeof buildRunnerDouble>;
  /** Build with whatever `ZENITH_BUILD_RUNNER` selects — a real compile. */
  useRealBuildRunner?: boolean;
  paused?: { paused: boolean; reason?: string };
  /** What the app's records are on, for the rollback schema check. */
  schemaVersion?: number;
  /** Who holds the owner grant, for `requireAppRole`. Undefined means everyone does. */
  owner?: string;
}

/**
 * Point the release module at doubles and return them, plus the undo.
 *
 * Everything that reaches outside the release module is replaced: the runtime,
 * the build runner, the grant check, the usage ledger. What is *not* replaced
 * is the authority, the artifact store, the source validator and the release
 * pipeline itself — those are what the tests are about.
 */
export function wire(h: Harness, opts: WiringOptions = {}) {
  const runtime = runtimeDouble({ store: h.store, ...opts });
  const build = opts.build ?? buildRunnerDouble();
  const usage = usageDouble(opts.paused);
  const real = h.release.releaseDeps.buildRunner;
  const restore = h.release.setReleaseDepsForTests({
    runtime: () => runtime.runtime,
    buildRunner: opts.useRealBuildRunner ? real : () => build.runner,
    artifactStore: () => h.store,
    recordUsage: usage.recordUsage as never,
    buildsPaused: usage.buildsPaused,
    appSchemaVersion: () => Promise.resolve(opts.schemaVersion ?? 1),
    requireAppRole: (appId, subject) => {
      if (opts.owner && subject !== opts.owner)
        throw new h.contracts.HostedError("forbidden", `${subject} does not hold an owner grant on ${appId}.`, {
          fix: "Ask an owner of this app to give you the owner role, or have them publish.",
        });
      return grantFor(appId, subject);
    },
    activeGrant: (appId, subject) =>
      opts.owner && subject !== opts.owner ? null : grantFor(appId, subject),
  });
  return { runtime, build, usage, restore };
}

/** A synthetic owner grant, for the checks that only look at the role. */
const grantFor = (appId: string, subject: string) =>
  ({
    id: `grant-${appId}`,
    appId,
    subject,
    email: `${subject}@example.test`,
    role: "owner" as const,
    state: "active" as const,
    grantedBy: subject,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

/** Create an app through the real `createApp`, so its owner grant is real too. */
export async function makeApp(
  h: Harness,
  input: { workspaceId: string; slug: string; name: string; subject: string; email?: string }
): Promise<HostedApp> {
  return h.release.createApp({
    workspaceId: input.workspaceId,
    slug: input.slug,
    name: input.name,
    createdBy: input.subject,
    email: input.email ?? `${input.subject}@example.test`,
  });
}

/** Queue a publish and run it to completion, returning the finished job. */
export async function publishOnce(
  h: Harness,
  input: { app: HostedApp; actor: string; jobId?: string; fixture?: string }
) {
  const jobId = input.jobId ?? crypto.randomUUID();
  await h.release.admitPublish({
    jobId,
    appId: input.app.id,
    workspaceId: input.app.workspaceId,
    actor: input.actor,
    source: { kind: "fixture", name: input.fixture ?? "minimal-app" },
  });
  return h.release.runJobOnce(jobId);
}
