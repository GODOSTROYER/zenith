/**
 * Shared fixtures for the execution tests: ids, manifests, a verified AWS
 * connection, and a builder for `NormalizedPlan`s.
 *
 * The CANARY strings are planted where a leak would hurt (cloud credentials in
 * the fake session, a sensitive plan value, the compact grant) so a test can
 * assert they appear in NOTHING an activity returns, stores or emits.
 */
import type { ProviderConnection } from "@/lib/credentials/types";
import type { Manifest } from "@/lib/domain/types";
import { digest } from "@/lib/controlplane/digest";
import type { NormalizedPlan, PlanResourceChange } from "@/lib/tofu/types";
import type { ManifestV2 } from "@/lib/resources/manifest-v2";

export const WS = "ws-act-1";
export const OTHER_WS = "ws-other-1";
export const PROJECT = "proj-act-1";
export const ENV = "env-act-1";
export const REVISION = "rev-act-1";
export const DEPLOYMENT = "dep-act-1";
export const PRODUCT_CONNECTION = "conn-product-1";
export const PLATFORM_CONNECTION = "pconn-act-1";
export const OP = "op-act-1";

export const CANARY_SECRET = "zk-canary-7f3a9c1e5b2d4a68";
export const CANARY_SESSION_KEY = "sk-session-canary-0a1b2c3d4e5f";
export const CANARY_GRANT = "GRANT-JWS-CANARY-never-stored";

export const connectionConfig = {
  provider: "aws" as const,
  mode: "oidc_web_identity" as const,
  accountId: "123456789012",
  observeRoleArn: "arn:aws:iam::123456789012:role/zenith-observe",
  deployRoleArn: "arn:aws:iam::123456789012:role/zenith-deploy",
  region: "us-east-1",
  stateBucket: "zenith-state-123456789012",
};

export const providerConnection = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: PLATFORM_CONNECTION,
  workspaceId: WS,
  legacyConnectionId: PRODUCT_CONNECTION,
  config: connectionConfig,
  status: "verified",
  createdBy: "user-1",
  createdAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

/* ------------------------------- manifests -------------------------------- */

const svc = (over: Record<string, unknown>) => ({ size: "small", replicas: 1, env: [], ownership: "managed", ...over });

/** A web service behind one TLS route, with a database: the smallest interesting deploy. */
export function webDbManifest(): Manifest {
  return {
    version: 1,
    services: [svc({ id: "svc-web", name: "web", kind: "web", source: { type: "image", image: "ghcr.io/acme/web:1" }, port: 3000, healthPath: "/healthz", replicas: 2 })] as unknown as Manifest["services"],
    resources: [{ id: "res-db", name: "db", kind: "postgres", config: {}, size: "small", ownership: "managed" }] as Manifest["resources"],
    routes: [{ id: "rt-app", host: "app.atlas.zenith.test", pathPrefix: "/", tls: true, managedDns: true }],
    bindings: [
      { id: "b-route", from: "rt-app", to: "svc-web", capability: "http" },
      { id: "b-sql", from: "svc-web", to: "res-db", capability: "sql" },
    ],
  };
}

/** One object store and nothing else: a single managed node. */
export function bucketManifest(name = "assets"): Manifest {
  return { version: 1, services: [], resources: [{ id: `res-${name}`, name, kind: "object_store", config: {}, size: "small", ownership: "managed" }] as Manifest["resources"], routes: [], bindings: [] };
}

/** A service built from git (needs build + registry + pipeline nodes). */
export function builtManifest(): Manifest {
  return {
    version: 1,
    services: [svc({ id: "svc-api", name: "api", kind: "web", source: { type: "git", repo: "github.com/acme/api", ref: "main", dockerfile: "Dockerfile" }, port: 8080, healthPath: "/health" })] as unknown as Manifest["services"],
    resources: [],
    routes: [],
    bindings: [],
  };
}

/** V2 manifest with a release migration on the `web` service. */
export function migratingManifest(command: string[] = ["node", "migrate.js", "--up"], extra: { timeoutSec?: number } = {}): ManifestV2 {
  const base = webDbManifest();
  return {
    version: 2,
    services: base.services,
    resources: base.resources,
    routes: base.routes,
    bindings: base.bindings,
    placement: { provider: "aws", regions: ["us-east-1"] },
    release: { migrate: { service: "web", command, ...extra } },
  };
}

/* ---------------------------------- plans --------------------------------- */

export interface PlanOptions {
  /** seed that makes a different digest */
  seed?: string;
  changes?: PlanResourceChange[];
  configDigest?: string;
  lockDigest?: string;
  empty?: boolean;
}

export const change = (over: Partial<PlanResourceChange> & Pick<PlanResourceChange, "address" | "type" | "action">): PlanResourceChange => ({
  providerName: "registry.opentofu.org/hashicorp/aws",
  changes: [],
  destroysData: false,
  ...over,
});

export function makePlan(opts: PlanOptions = {}): NormalizedPlan {
  const changes = opts.changes ?? [change({ address: "aws_s3_bucket.assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "create" })];
  const count = (action: string): number => changes.filter((c) => c.action === action).length;
  const configDigest = opts.configDigest ?? "c".repeat(64);
  const lockDigest = opts.lockDigest ?? "d".repeat(64);
  return {
    tofuVersion: "1.12.5",
    formatVersion: "1.2",
    configDigest,
    lockDigest,
    planDigest: digest({ seed: opts.seed ?? "plan-1", changes, configDigest, lockDigest }),
    resourceChanges: changes,
    outputChanges: [],
    summary: { create: count("create"), update: count("update"), delete: count("delete"), replace: count("replace"), noop: count("no-op") },
    empty: opts.empty ?? changes.every((c) => c.action === "no-op"),
    diagnostics: [],
    createdAt: "2026-09-30T00:00:00.000Z",
  };
}
