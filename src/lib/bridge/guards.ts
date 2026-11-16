/**
 * Shared deployment guards. Provider refusal precedes any snapshot; deletion
 * policy applies to managed stateful resources; production approvals preserve
 * requester separation and the existing audited sole-admin exception.
 * No cloud I/O occurs here beyond the bridge's prerequisite/recorded-state probes.
 */
import { roleOf, type ActionContext } from "@/lib/actions/core";
import { db, q, revisionManifestAsync } from "@/lib/db/store";
import { isStatefulKind } from "@/lib/domain/graph";
import { emptyManifest, type Changeset, type Deployment, type Environment } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { executionRoute, type ExecutionRoute } from "@/lib/bridge/deploy";
import { fixList, missingSummary } from "@/lib/bridge/readiness";

export async function providerBlock(env: Environment, route?: ExecutionRoute): Promise<string | undefined> {
  route ??= await executionRoute(env);
  if (route.kind === "workflow") return undefined;
  const providerId = q.connection(env.connectionId)?.provider ?? "sandbox";
  const provider = providerRegistry().get(providerId);
  // Not registered yet (engine not booted): the engine still refuses honestly.
  if (route.kind === "engine" && (!provider || provider.availability === "available")) return undefined;
  const displayName = provider?.displayName ?? providerId;
  const fix = route.kind === "unlinked" ? " Connect this account keylessly with connection.createAws."
    : route.kind === "unverified" ? " Run connection.verifyAws before deploying."
    : route.kind === "not_ready" ? ` Missing: ${missingSummary(route.readiness)}. ${fixList(route.readiness).join(" ")}` : "";
  if (providerId === "aws" || provider?.availability === "preview")
    return (
      `${displayName} is a Preview provider: Zenith plans this deployment and exports runnable Terraform for it, but it never applies changes to your account through this connection while these prerequisites are missing. ` +
      `Export the Terraform from Source → Export (or Settings → Export) and run it with your own tooling, or point ${env.name} at a Sandbox connection to watch the full flow.${fix}`
    );
  return (
    `${displayName} is a Planned provider: Zenith cannot plan, apply or export for it yet. ` +
    `Point ${env.name} at a Sandbox connection to deploy now, or at AWS to export runnable Terraform.${fix}`
  );
}

export function connectionBlock(env: Environment): string | undefined {
  const conn = q.connection(env.connectionId);
  if (!conn)
    return (
      `${env.name} is not pointed at a cloud connection, so there is nothing to deploy through. ` +
      `Pick one for ${env.name} in Settings → Environments, or connect a cloud in Settings → Connections first.`
    );
  if (conn.status === "disconnected")
    return (
      `${conn.label} is disconnected, so ${env.name} cannot be deployed to. ` +
      `Start the service behind it (LocalStack needs Docker running), re-run the check in Settings → Connections, or point ${env.name} at a healthy connection.`
    );
  return undefined;
}

export async function statefulDeletionBlock(
  env: Environment,
  cs: Changeset,
  via: "deploy" | "rollback" = "deploy"
): Promise<string | undefined> {
  if (env.policies.allowStatefulDeletion) return undefined;
  const deployed = (env.deployedRevisionId ? await revisionManifestAsync(env.deployedRevisionId) : undefined) ?? emptyManifest();
  const doomed = cs.items
    .filter((i) => i.op === "delete" && i.nodeType === "resource")
    .map((i) => deployed.resources.find((r) => r.id === i.nodeId))
    .filter((r): r is NonNullable<typeof r> => !!r && r.ownership === "managed" && isStatefulKind(r.kind));
  if (!doomed.length) return undefined;
  const names = doomed.map((r) => `"${r.name}" (${r.kind})`).join(", ");
  return (
    `This plan removes ${names} from ${env.name}, which destroys the data in ${doomed.length > 1 ? "them" : "it"} — ` +
    `and a rollback restores the system definition, not the data. ` +
    `${
      via === "rollback"
        ? `Pick a revision that still has ${doomed.length > 1 ? "them" : "it"}`
        : `Put ${doomed.length > 1 ? "them" : "it"} back in the editor`
    }, or turn on "Allow stateful deletion" for ${env.name} in Settings → Environments if you mean to lose the data.`
  );
}

export function approvalSeparation(
  ctx: ActionContext,
  d: Deployment,
  env: Environment | undefined
): { blocked?: string; selfApproved?: boolean } {
  if (!env || env.class !== "production" || d.actor.id !== ctx.actor.id) return {};
  const otherAdmins = db().members.filter(
    (m) => m.workspaceId === ctx.workspaceId && m.role === "admin" && m.id !== ctx.actor.id
  );
  if (ctx.actor.type === "user" && otherAdmins.length === 0 && roleOf(ctx.actor, ctx.workspaceId) === "admin")
    return { selfApproved: true };
  return {
    blocked:
      `${env.name} is a production environment and you started this deployment, so you cannot also approve it — ` +
      `on production the approval has to come from a second person. ` +
      `Ask another admin to approve it from the Deploys page, or add one in Settings → Members.`,
  };
}
