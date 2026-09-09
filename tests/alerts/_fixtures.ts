/**
 * Shared fixtures for the alert suites (and the logsim health-history suite,
 * which builds the same service and manifest).
 *
 * IMPORTANT: nothing here may import application code at module level. The
 * suites that use this file set `ORRERY_DATA` at their own top level and then
 * `await import("@/lib/db/store")`; a runtime import in here would run first
 * and pin the store to the wrong directory. Type-only imports are erased, so
 * they are safe — keep it that way.
 *
 * For the same reason `seedData()` returns the payload rather than calling
 * `resetDb` itself: the caller owns the store handle it dynamically imported.
 */
import type {
  AlertChannel,
  Deployment,
  Environment,
  Manifest,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";

/** The anchor every alert suite dates its fixtures against. */
export const NOW = Date.parse("2026-09-02T12:00:00.000Z");

export const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

export const ACTOR = { type: "user" as const, id: "local", name: "You" };

/** The one web service the alert fixtures deploy; `chaos` degrades it. */
export const service = (chaos?: string) => ({
  id: "svc-api",
  name: "api",
  kind: "web" as const,
  source: { type: "image" as const, image: "nginx" },
  size: "small" as const,
  replicas: 2,
  port: 3000,
  env: chaos ? [{ key: "ORRERY_CHAOS", value: chaos }] : [],
  ownership: "managed" as const,
});

export const manifest = (chaos?: string, withService = true): Manifest => ({
  version: 1,
  services: withService ? [service(chaos)] : [],
  resources: [],
  routes: [],
  bindings: [],
});

/**
 * A workspace with one project, one environment and one deployed revision.
 * Pass the result straight to `resetDb`.
 *
 * Health is derived from the last deployment as well as the manifest, so a
 * store without one reads as degraded and every rule fires — hence `dep1`.
 */
export function seedData(chaos?: string) {
  const m = manifest(chaos);
  return {
    workspaces: [
      { id: "ws1", name: "Atlas", slug: "atlas", createdAt: ago(500) } as unknown as Workspace,
    ],
    projects: [
      {
        id: "p1",
        workspaceId: "ws1",
        name: "atlas",
        slug: "atlas",
        workingManifest: m,
        createdAt: ago(500),
        origin: { type: "blank" },
      } as Project,
    ],
    environments: [
      {
        id: "env1",
        projectId: "p1",
        name: "sandbox",
        class: "sandbox",
        connectionId: "c1",
        region: "local",
        deployedRevisionId: "rev1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "test",
        createdAt: ago(500),
      } as unknown as Environment,
    ],
    revisions: [
      {
        id: "rev1",
        projectId: "p1",
        number: 1,
        manifest: m,
        message: "r1",
        author: ACTOR,
        createdAt: ago(30),
      } as Revision,
    ],
    deployments: [
      {
        id: "dep1",
        projectId: "p1",
        environmentId: "env1",
        revisionId: "rev1",
        status: "succeeded",
        steps: [],
        outputs: [],
        changeSummary: "first deploy",
        estCostDeltaUsd: 0,
        actor: ACTOR,
        createdAt: ago(20),
        endedAt: ago(20),
      } as unknown as Deployment,
    ],
  };
}

/**
 * A webhook channel record. The caller pushes it into `channelTable()` — the
 * action path that would normally create one is tested separately.
 */
export function channelData(over: Partial<AlertChannel> = {}): AlertChannel {
  return {
    id: over.id ?? "ch1",
    workspaceId: "ws1",
    kind: "webhook",
    name: "ops endpoint",
    target: "https://example.test/hooks/orrery",
    enabled: true,
    createdBy: ACTOR,
    createdAt: ago(60),
    ...over,
  } as AlertChannel;
}
