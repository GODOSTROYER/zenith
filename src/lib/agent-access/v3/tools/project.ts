/**
 * Project reads: `zenith_get_topology`, `zenith_get_capabilities`,
 * `zenith_compare_revisions` and `zenith_estimate_cost`.
 *
 * Each one asks the broker (`authorizeRead`) before it reads anything, then
 * reads the product store through `ProjectReads`, which filters by workspace
 * and project. They describe DESIRED state (manifests, revisions, the derived
 * graph) and say so; what is running is the query tools' business.
 *
 * Where text came from a person or a repository (service names, env var names,
 * revision messages, binding notes, changeset explanations) it is returned under
 * `untrusted_data`; `data` carries counts, ids, enums, digests and numbers.
 */
import { digest } from "@/lib/controlplane/digest";
import { diffManifests } from "@/lib/domain/graph";
import type { AnyManifest } from "@/lib/domain/types";
import { catalogDigest, catalogFor, TOOL_CATALOG } from "../catalog";
import { CONTRACT_VERSION, SERVER_NAME, SERVER_VERSION } from "../contract";
import { authorizeReadOrThrow, graphFor, pickManifest, requireEnvironment, requireProject, requireRevision, type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { assertInGrant, environmentInGrant } from "../principal";
import type { CompareRevisionsArgs, EstimateCostArgs, GetCapabilitiesArgs, GetTopologyArgs } from "../schemas";
import { offeredCatalogSummary } from "@/lib/offered-catalog";
import { tryEstimate } from "./estimate";

const DEFAULT_MAX_NODES = 200;
const REVISIONS_LISTED = 20;
const MAX_CHANGE_ITEMS = 200;

/** Structure only: no env values, no config values, no source credentials. */
function manifestSummary(manifest: AnyManifest) {
  return {
    services: manifest.services.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      sourceType: s.source.type,
      size: s.size,
      replicas: s.replicas,
      ...(s.port !== undefined ? { port: s.port } : {}),
      ownership: s.ownership,
      envVarNames: s.env.map((e) => e.key),
    })),
    resources: manifest.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, ownership: r.ownership })),
    routes: manifest.routes.map((r) => ({ id: r.id, host: r.host, pathPrefix: r.pathPrefix, tls: r.tls, managedDns: r.managedDns })),
    bindings: manifest.bindings.map((b) => ({ id: b.id, from: b.from, to: b.to, capability: b.capability, ...(b.note ? { note: b.note } : {}) })),
  };
}

/* ------------------------------- get_topology ------------------------------- */

export async function getTopology(args: GetTopologyArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  await authorizeReadOrThrow(ctx, "topology.read", { workspaceId: target.workspaceId, projectId: target.projectId, ...(target.environmentId ? { environmentId: target.environmentId } : {}) });

  const project = await requireProject(ctx, target.workspaceId, target.projectId);
  const environment = target.environmentId ? await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId) : undefined;
  const { manifest, source } = await pickManifest(ctx, { workspaceId: target.workspaceId, project, environment, revisionId: args.revisionId });
  const summary = manifestSummary(manifest);

  const environments = (await ctx.ports.reads.environments(target.workspaceId, target.projectId))
    .filter((e) => e.projectId === target.projectId && environmentInGrant(ctx.principal, e.id))
    .map((e) => ({ id: e.id, class: e.class, provider: e.provider, region: e.region, ...(e.deployedRevisionId ? { deployedRevisionId: e.deployedRevisionId } : {}) }));
  const revisions = await ctx.ports.reads.revisions(target.workspaceId, target.projectId, REVISIONS_LISTED);

  const maxNodes = args.maxNodes ?? DEFAULT_MAX_NODES;
  const notes: string[] = ["This is the DESIRED topology from the manifest, not what is running. Use zenith_query_logs, zenith_query_metrics and zenith_get_operation for runtime."];
  let truncated = false;
  let graphData: Record<string, unknown> | undefined;
  let graphUntrusted: Record<string, unknown> | undefined;
  if (environment) {
    const graph = graphFor(manifest, environment);
    const nodes = graph.nodes.slice(0, maxNodes);
    truncated = graph.nodes.length > nodes.length;
    if (truncated) notes.push(`Only ${nodes.length} of ${graph.nodes.length} graph nodes are listed; raise maxNodes (max 500) to see more.`);
    graphData = { graphDigest: graph.graphDigest, manifestDigest: graph.manifestDigest, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, nodesListed: nodes.length };
    const listed = new Set(nodes.map((n) => n.address));
    graphUntrusted = {
      nodes: nodes.map((n) => ({ address: n.address, kind: n.kind, provider: n.provider, region: n.region, nativeType: n.nativeType, ownership: n.ownership, dependsOn: n.dependsOn, origin: n.origin })),
      edges: graph.edges.filter((e) => listed.has(e.from) && listed.has(e.to)).map((e) => ({ from: e.from, to: e.to, relation: e.relation, ...(e.detail ? { detail: e.detail } : {}) })),
      notes: graph.notes,
    };
  }
  const simulated = environment?.provider === "sandbox";
  if (simulated) notes.push("This environment uses the sandbox provider: its infrastructure is simulated.");

  return {
    data: {
      project: { id: project.id, workspaceId: project.workspaceId },
      ...(environment ? { environment: { id: environment.id, class: environment.class, provider: environment.provider, region: environment.region, ...(environment.deployedRevisionId ? { deployedRevisionId: environment.deployedRevisionId } : {}) } } : {}),
      source,
      manifestDigest: digest(manifest),
      counts: { services: summary.services.length, resources: summary.resources.length, routes: summary.routes.length, bindings: summary.bindings.length },
      ...(graphData ? { graph: graphData } : {}),
      environments,
      revisions: revisions.map((r) => ({ id: r.id, number: r.number, createdAt: r.createdAt, ...(r.deployedTo ? { deployedTo: r.deployedTo.filter((id) => environmentInGrant(ctx.principal, id)) } : {}) })),
    },
    untrusted: {
      manifest: summary,
      ...(graphUntrusted ? { graph: graphUntrusted } : {}),
      revisionMessages: revisions.map((r) => ({ id: r.id, message: r.message })),
    },
    simulated,
    truncated,
    notes,
  };
}

/* ----------------------------- get_capabilities ----------------------------- */

export async function getCapabilities(args: GetCapabilitiesArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  await authorizeReadOrThrow(ctx, "topology.read", { workspaceId: target.workspaceId, projectId: target.projectId, ...(target.environmentId ? { environmentId: target.environmentId } : {}) });

  const listed = new Set(catalogFor(ctx.principal.scopes).map((t) => t.name));
  const autonomy = target.environmentId
    ? await ctx.broker.getAutonomy({ workspaceId: target.workspaceId, environmentId: target.environmentId, principal: ctx.principal.principal })
    : undefined;
  const execution = await ctx.ports.workflows.available();
  const investigator = ctx.ports.investigator;
  const origin = ctx.ports.origin();

  return {
    data: {
      server: { name: SERVER_NAME, version: SERVER_VERSION, contractVersion: CONTRACT_VERSION, catalogDigest: catalogDigest() },
      connection: {
        integrationId: ctx.principal.principal.integrationId,
        onBehalfOf: ctx.principal.principal.onBehalfOf,
        via: ctx.principal.via,
        scopes: ctx.principal.scopes,
        projectIds: ctx.principal.projectIds,
        ...(ctx.principal.environmentIds ? { environmentIds: ctx.principal.environmentIds } : {}),
        expiresAt: ctx.principal.expiresAt,
      },
      tools: TOOL_CATALOG.map((t) => ({
        name: t.name,
        access: t.access,
        capability: t.capability,
        requiredScope: t.requiredScope,
        schemaVersion: t.schemaVersion,
        schemaDigest: t.schemaDigest,
        available: listed.has(t.name),
        ...(listed.has(t.name) ? {} : { unavailableReason: `needs the ${t.requiredScope} scope` }),
      })),
      ...(autonomy
        ? {
            environment: {
              id: autonomy.environmentId,
              class: autonomy.environmentClass,
              autonomy: { level: autonomy.level, name: autonomy.name, summary: autonomy.summary, unattended: autonomy.unattended, isDefault: autonomy.defaulted, version: autonomy.version },
            },
          }
        : {}),
      // What each provider actually offers (supported / preview / unsupported with reasons), derived from the drivers.
      // Per-cell detail: GET /api/platform/v1/capability-catalog.
      offeredCatalog: offeredCatalogSummary(),
      execution: execution.available ? { available: true } : { available: false, reason: execution.reason },
      incidentEngine: investigator.available ? { available: true } : { available: false, reason: investigator.reason ?? "The incident engine is not connected on this deployment." },
      approval: {
        model: "Write tools only propose. A person approves the exact proposal digest in the Zenith web app; execution requires an approved, digest-matching operation. A yes in chat is not an approval.",
        urlTemplate: `${origin}/integrations/operations/{operationId}`,
      },
    },
  };
}

/* ---------------------------- compare_revisions ---------------------------- */

export async function compareRevisions(args: CompareRevisionsArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  await authorizeReadOrThrow(ctx, "topology.read", { workspaceId: target.workspaceId, projectId: target.projectId, ...(target.environmentId ? { environmentId: target.environmentId } : {}) });

  await requireProject(ctx, target.workspaceId, target.projectId);
  const from = await requireRevision(ctx, target.workspaceId, target.projectId, args.fromRevisionId);
  const to = await requireRevision(ctx, target.workspaceId, target.projectId, args.toRevisionId);
  const changes = diffManifests(from.manifest, to.manifest);

  const items = changes.items.slice(0, MAX_CHANGE_ITEMS);
  const truncated = changes.items.length > items.length;
  const count = (op: string) => changes.items.filter((i) => i.op === op).length;
  return {
    data: {
      fromRevision: { id: from.id, number: from.number, manifestDigest: digest(from.manifest) },
      toRevision: { id: to.id, number: to.number, manifestDigest: digest(to.manifest) },
      identical: changes.items.length === 0,
      counts: { create: count("create"), update: count("update"), delete: count("delete"), total: changes.items.length },
      cost: { isEstimate: true, totalDeltaUsdMonthly: changes.totalCostDeltaUsd, projectedMonthlyUsd: changes.projectedMonthlyUsd },
    },
    untrusted: {
      changes: items.map((i) => ({
        op: i.op,
        nodeType: i.nodeType,
        nodeId: i.nodeId,
        nodeName: i.nodeName,
        explanation: i.explanation,
        costDeltaUsd: i.costDeltaUsd,
        risk: i.risk,
        changedFields: (i.fields ?? []).map((f) => f.field),
      })),
      warnings: changes.warnings,
    },
    truncated,
    notes: [
      "Field values are not returned over MCP (they may hold configuration); only which fields changed. The cost figures come from the product cost model and are estimates.",
      ...(truncated ? [`Only ${items.length} of ${changes.items.length} changes are listed.`] : []),
    ],
  };
}

/* ------------------------------- estimate_cost ------------------------------ */

export async function estimateCost(args: EstimateCostArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  assertInGrant(ctx.principal, target);
  await authorizeReadOrThrow(ctx, "cost.estimate", { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId });

  const project = await requireProject(ctx, target.workspaceId, target.projectId);
  const environment = await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId);
  const { manifest, source } = await pickManifest(ctx, { workspaceId: target.workspaceId, project, environment, revisionId: args.revisionId });
  const graph = graphFor(manifest, environment);
  const result = tryEstimate(graph);
  const simulated = environment.provider === "sandbox";
  const base = { source, graphDigest: graph.graphDigest, environment: { id: environment.id, provider: environment.provider, region: environment.region } };
  const notes = [
    "An ESTIMATE of list prices from a static catalog snapshot, before taxes, discounts and free tiers. It is not an invoice.",
    ...(simulated ? ["This environment uses the sandbox provider: nothing is actually provisioned or billed."] : []),
  ];
  if (!result.ok) {
    return { data: { ...base, isEstimate: true, monthlyUsd: null }, unavailable: [{ source: "price-catalog", reason: result.reason }], simulated, notes };
  }
  const e = result.estimate;
  const lines = e.lines.slice(0, 100);
  return {
    data: {
      ...base,
      isEstimate: true,
      monthlyUsd: e.monthlyUsd,
      currency: e.currency,
      catalogVersion: e.catalogVersion,
      computedAt: e.computedAt,
      assumptions: e.assumptions,
      included: e.included,
      excluded: e.excluded,
      lineCount: e.lines.length,
    },
    untrusted: {
      lines: lines.map((l) => ({ address: l.address, description: l.description, sku: l.sku, quantity: l.quantity, unit: l.unit, unitUsd: l.unitUsd, monthlyUsd: l.monthlyUsd, basis: l.basis })),
    },
    simulated,
    truncated: e.lines.length > lines.length,
    notes,
  };
}
