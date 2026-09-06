import type { Bootstrap } from "@/components/shell/shell-context";
import { emptyManifest } from "@/lib/domain/types";

export function starterBoot(over: Partial<Bootstrap> = {}): Bootstrap {
  return {
    workspace: { id: "w1", name: "Team", slug: "team", createdAt: "2026-01-01" },
    workspaces: [{ id: "w1", name: "Team", slug: "team", role: "admin" }],
    user: { id: "u1", name: "User", email: "user@example.test" }, role: "admin", auth: { configured: true },
    projects: [], environments: [], deployments: [], members: [], settings: {}, catalog: [],
    providers: [
      { id: "sandbox", displayName: "Sandbox", availability: "available", tagline: "Simulated", regions: [] },
      { id: "localstack", displayName: "LocalStack", availability: "available", tagline: "Local", regions: [] },
      { id: "aws", displayName: "AWS", availability: "preview", tagline: "Preview", regions: [] },
      { id: "azure", displayName: "Azure", availability: "planned", tagline: "Later", regions: [] },
    ],
    connections: [{ id: "c1", workspaceId: "w1", provider: "sandbox", label: "Sandbox", region: "local-1", status: "healthy", grantedPermissions: ["No cloud access"], createdAt: "2026-01-01" }],
    ...over,
  };
}
export function starterProject() {
  return { id: "p1", workspaceId: "w1", name: "Project", slug: "project", workingManifest: emptyManifest(), origin: { type: "blank" as const }, createdAt: "2026-01-01" };
}
export function starterEnvironment() {
  return { id: "e1", projectId: "p1", name: "sandbox", class: "sandbox" as const, connectionId: "c1", region: "local-1", policies: { approvalRequired: false, allowStatefulDeletion: false }, baseDomain: "example.test", createdAt: "2026-01-01" };
}
