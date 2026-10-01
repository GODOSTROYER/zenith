/**
 * What a tool handler is given, and the helpers every handler shares.
 *
 * The most important helper is `authorizeReadOrThrow`: every read tool calls it
 * FIRST, before touching the product store or any cloud, so a read is policy
 * checked (workspace membership, scope chain, integration scope, environment
 * autonomy, workspace policy) by the same broker the UI and REST use.
 */
import { BrokerError } from "@/lib/capabilities/errors";
import type { Broker } from "@/lib/capabilities/platform";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { expandManifest, ManifestExpansionError } from "@/lib/resources/expand";
import type { Manifest } from "@/lib/domain/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ToolDescriptor } from "./catalog";
import { McpToolError, notFound } from "./errors";
import type { McpPrincipal } from "./principal";
import type { EnvironmentInfo, McpPorts, ProjectInfo, RevisionInfo } from "./ports";

export interface ToolContext {
  principal: McpPrincipal;
  ports: McpPorts;
  broker: Broker;
  tool: ToolDescriptor;
  signal?: AbortSignal;
}

export interface ScopeRef {
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
}

export interface ReadAuthorization {
  /** The claims of the short read grant; present for an `allow`. Never the compact grant. */
  claims: CapabilityGrantClaims;
  policyVersion: string;
}

/**
 * Ask the broker whether this principal may read `capability` at `scope`.
 * Returns the grant claims on `allow`; anything else is a refusal. The compact
 * grant (a bearer for executing surfaces) is dropped here and never leaves.
 */
export async function authorizeReadOrThrow(ctx: ToolContext, capability: string, scope: ScopeRef, input?: unknown): Promise<ReadAuthorization> {
  const result = await ctx.broker.authorizeRead(
    { capability, scope, ...(input !== undefined ? { input } : {}) },
    ctx.principal.principal
  );
  const { decision } = result;
  if (decision.outcome !== "allow" || !result.claims) {
    throw new BrokerError(
      "policy_denied",
      decision.outcome === "deny" ? "Current policy denies this read." : "This read cannot be authorized: it would need an approval, and reads have none.",
      "Review the reasons. Reads are governed by integration scopes, environment autonomy and workspace policy.",
      { reasons: decision.reasons.slice(0, 10).map((r) => ({ code: r.code, message: r.message })), policyVersion: decision.policyVersion }
    );
  }
  return { claims: result.claims, policyVersion: decision.policyVersion };
}

/* ------------------------------- product reads ------------------------------ */

export async function requireProject(ctx: ToolContext, workspaceId: string, projectId: string): Promise<ProjectInfo> {
  const project = await ctx.ports.reads.project(workspaceId, projectId);
  if (!project || project.workspaceId !== workspaceId || project.id !== projectId) throw notFound();
  return project;
}

export async function requireEnvironment(ctx: ToolContext, workspaceId: string, projectId: string, environmentId: string): Promise<EnvironmentInfo> {
  const env = await ctx.ports.reads.environment(workspaceId, projectId, environmentId);
  if (!env || env.projectId !== projectId || env.id !== environmentId) throw notFound();
  return env;
}

export async function requireRevision(ctx: ToolContext, workspaceId: string, projectId: string, revisionId: string): Promise<RevisionInfo> {
  const revision = await ctx.ports.reads.revision(workspaceId, projectId, revisionId);
  if (!revision || revision.projectId !== projectId || revision.id !== revisionId) throw notFound();
  return revision;
}

export type ManifestSource =
  | { kind: "revision"; revisionId: string; revisionNumber: number }
  | { kind: "deployed_revision"; revisionId: string; revisionNumber: number }
  | { kind: "working_copy" };

/**
 * The manifest a read describes: an explicit saved revision; else the
 * environment's deployed revision (what actually exists there); else the
 * project's working copy.
 */
export async function pickManifest(
  ctx: ToolContext,
  args: { workspaceId: string; project: ProjectInfo; environment?: EnvironmentInfo; revisionId?: string }
): Promise<{ manifest: Manifest; source: ManifestSource }> {
  if (args.revisionId) {
    const revision = await requireRevision(ctx, args.workspaceId, args.project.id, args.revisionId);
    return { manifest: revision.manifest, source: { kind: "revision", revisionId: revision.id, revisionNumber: revision.number } };
  }
  if (args.environment?.deployedRevisionId) {
    const revision = await ctx.ports.reads.revision(args.workspaceId, args.project.id, args.environment.deployedRevisionId);
    if (revision) return { manifest: revision.manifest, source: { kind: "deployed_revision", revisionId: revision.id, revisionNumber: revision.number } };
  }
  return { manifest: args.project.workingManifest, source: { kind: "working_copy" } };
}

/** Expand a manifest for an environment. A manifest that cannot be expanded is a 422, not a crash. */
export function graphFor(manifest: Manifest, environment: EnvironmentInfo): ResourceGraph {
  try {
    return expandManifest(manifest, {
      id: environment.id,
      name: environment.name,
      class: environment.class,
      provider: environment.provider,
      region: environment.region,
      baseDomain: environment.baseDomain,
    });
  } catch (error) {
    if (error instanceof ManifestExpansionError) {
      throw new McpToolError("manifest_invalid", "The manifest cannot be expanded into a resource graph. Fix it in Zenith, then try again.", 422);
    }
    throw error;
  }
}

/** Kinds that are workloads or data stores: what a person means by "the service". */
const SERVICE_KINDS: ReadonlySet<string> = new Set([
  "container_service",
  "scheduled_job",
  "static_site",
  "function",
  "compute_instance",
  "postgres",
  "mysql",
  "redis",
  "queue",
  "object_store",
  "pubsub",
]);

/**
 * The graph addresses a manifest service or resource id was expanded into.
 * An id the graph does not contain is the uniform `not_found`.
 */
export function addressesForService(graph: ResourceGraph, serviceId: string): string[] {
  const addresses = graph.nodes.filter((n) => SERVICE_KINDS.has(n.kind) && n.origin.includes(serviceId)).map((n) => n.address);
  if (addresses.length === 0) throw notFound();
  return addresses;
}

/* --------------------------------- time ranges ------------------------------ */

export interface RangeArgs {
  lastMinutes?: number;
  from?: string;
  to?: string;
}

/** A bounded `[from, to]` window: explicit, or the last N minutes (default 60). */
export function resolveRange(args: RangeArgs, now: Date): { from: string; to: string } {
  const nowMs = now.getTime();
  if (args.lastMinutes !== undefined && (args.from !== undefined || args.to !== undefined)) {
    throw new McpToolError("invalid_input", "Give either lastMinutes or from/to, not both.", 400);
  }
  if (args.to !== undefined && args.from === undefined) {
    throw new McpToolError("invalid_input", "to needs from.", 400);
  }
  if (args.from !== undefined) {
    const from = Date.parse(args.from);
    const to = args.to !== undefined ? Date.parse(args.to) : nowMs;
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new McpToolError("invalid_input", "from and to must be valid timestamps.", 400);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  const minutes = args.lastMinutes ?? 60;
  return { from: new Date(nowMs - minutes * 60_000).toISOString(), to: new Date(nowMs).toISOString() };
}
