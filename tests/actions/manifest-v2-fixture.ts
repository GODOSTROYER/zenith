/** Product fixtures: no cloud credentials or runtime store imports. */
import type { ActionContext } from "@/lib/actions/core";
import type { Database } from "@/lib/db/types";
import type { AnyManifest, Manifest } from "@/lib/domain/types";
import { ManifestV2 } from "@/lib/resources/manifest-v2";

export const AT = "2026-10-01T00:00:00.000Z";
export const ctx: ActionContext = {
  workspaceId: "ws", projectId: "proj", environmentId: "env",
  actor: { type: "user", id: "editor", name: "Editor" },
};

export function v1(): Manifest {
  return { version: 1, services: [{
    id: "svc-web", name: "web", kind: "web", source: { type: "image", image: "example/web:1" },
    size: "small", replicas: 1, port: 3000, env: [], ownership: "managed",
  }], resources: [], routes: [], bindings: [] };
}

export function v2() {
  return ManifestV2.parse({ ...v1(), version: 2,
    placement: { provider: "auto", regions: [], zones: 2 },
    constraints: { budgetUsdMonthly: 200 },
    policies: { deletion: "approval", backup: "daily" },
    providerConfig: { aws: { natGateways: "single", multiAz: true } },
    nodePlacement: { "svc-web": { provider: "sandbox", region: "sim-a" } },
    native: [{ id: "topic", provider: "aws", type: "aws:sns_topic", config: {} }],
    release: { migrate: { service: "web", command: ["node", "migrate.js"], timeoutSec: 30 } },
  });
}

export function productSeed(manifest: AnyManifest): Partial<Database> {
  return {
    workspaces: [{ id: "ws", name: "Test", slug: "test", createdAt: AT }],
    members: [{ id: "editor", workspaceId: "ws", name: "Editor", email: "editor@example.test", role: "editor" }],
    projects: [{ id: "proj", workspaceId: "ws", name: "Test", slug: "test", createdAt: AT, origin: { type: "blank" }, workingManifest: manifest }],
    connections: [{ id: "conn", workspaceId: "ws", provider: "sandbox", label: "Sandbox", region: "sim-a", status: "healthy", grantedPermissions: [], createdAt: AT }],
    environments: [{ id: "env", projectId: "proj", name: "Sandbox", class: "sandbox", connectionId: "conn", region: "sim-a", baseDomain: "test.zenith.test", createdAt: AT,
      policies: { approvalRequired: false, allowStatefulDeletion: false } }],
  };
}
