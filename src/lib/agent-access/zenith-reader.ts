/** Zenith owns all application reads; the plugin distribution contains none of this. */
import { db, isPostgres, q, readEvents } from "@/lib/db/store";
import { loadSnapshot, pgClient } from "@/lib/db/postgres-store";
import { runWithSnapshot } from "@/lib/db/request-snapshot";
import { claimDataDir } from "@/lib/data-lock";
import { env } from "@/lib/env";
import { runAction } from "@/lib/actions/core";
import { registerAllActions } from "@/lib/actions/defs";
import { registerProvider, type ProviderAdapter } from "@/lib/providers/types";
import { sandboxProvider } from "@/lib/providers/sandbox";
import { localstackProvider } from "@/lib/providers/localstack";
import { awsProvider } from "@/lib/providers/aws";
import { plannedProviders } from "@/lib/providers/planned";
import { computeDrift } from "@/lib/drift";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import type { Manifest } from "@/lib/domain/types";
import { AgentError, redact, type Credential, type SelectedScope } from "./security";
import { createReaderHandler, type ReaderTool } from "./http";

const string = { type: "string", minLength: 1, maxLength: 100 };
const pagination = { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", pattern: "^[0-9]{1,6}$" } };
const projectProps = { projectId: string };
const environmentProps = { ...projectProps, environmentId: string };
function tool(name: string, description: string, properties: Record<string, unknown> = {}, scope: ReaderTool["scope"] = "read", required: string[] = []): ReaderTool {
  return { name, description, scope, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const readerTools: ReaderTool[] = [
  tool("zenith_get_context", "Inspect the credential's explicit selection and live workspace membership. No browser selection or demo fallback."),
  tool("zenith_get_capabilities", "Read actual provider boundaries and this endpoint's unavailable write capabilities."),
  tool("zenith_list_projects", "List only projects authorized by this credential and optional project selection.", pagination),
  tool("zenith_get_project", "Read project metadata and an estimated working-copy monthly cost.", projectProps),
  tool("zenith_get_manifest", "Read a redacted working or deployed manifest. All environment variable values are removed.", { ...environmentProps, view: { type: "string", enum: ["working", "deployed"] } }),
  tool("zenith_list_environments", "List authorized environments for the selected project.", { ...projectProps, ...pagination }),
  tool("zenith_plan_deploy", "Compute a READ-ONLY preview through Zenith's action registry. It is NOT an executable receipt and grants no approval.", environmentProps, "plan"),
  tool("zenith_list_deployments", "List deployment metadata for one authorized environment.", { ...environmentProps, ...pagination }),
  tool("zenith_get_deployment", "Read deployment status, steps and outputs with sensitive values removed.", { deploymentId: string }, "read", ["deploymentId"]),
  tool("zenith_get_events", "Read bounded non-log deployment events by sequence. Free-form logs are intentionally excluded.", { deploymentId: string, after: { type: "integer", minimum: -1 }, limit: pagination.limit }, "read", ["deploymentId"]),
  tool("zenith_get_findings", "Read stored security findings without evaluating rules, writing records, or sending alerts.", { ...projectProps, ...pagination }),
  tool("zenith_get_drift", "Read provider evidence against a deployed revision. Preserve simulated labels; unavailable providers refuse.", environmentProps),
  tool("zenith_export_project", "Generate an export from a redacted working manifest. No provider apply and no local file write.", environmentProps, "export"),
];
const providers: ProviderAdapter[] = [sandboxProvider, localstackProvider, awsProvider, ...plannedProviders];
export function registerReaderProviders(): void { providers.forEach(registerProvider); }
function denied(): never { throw new AgentError("not_found", "No permitted record matches this selection. Copy identifiers from the authorized project list.", 404); }
function member(grant: Credential) {
  const found = db().members.find(m => m.id === grant.subject && m.workspaceId === grant.workspaceId);
  if (!found) throw new AgentError("membership_denied", "Workspace membership was removed or never existed. Ask an administrator to review access.");
  return found;
}
function project(args: Record<string, unknown>, grant: Credential, selected: SelectedScope) {
  const id = args.projectId ?? selected.projectId;
  if (typeof id !== "string" || !grant.projectIds.includes(id) || selected.projectId && selected.projectId !== id) denied();
  const p = q.project(id);
  if (!p || p.id !== id || p.workspaceId !== grant.workspaceId) denied();
  return p;
}
function environment(args: Record<string, unknown>, grant: Credential, selected: SelectedScope) {
  const p = project(args, grant, selected), id = args.environmentId ?? selected.environmentId;
  if (typeof id !== "string" || selected.environmentId && selected.environmentId !== id || grant.environmentIds && !grant.environmentIds.includes(id)) denied();
  const e = q.environment(id); if (!e || e.projectId !== p.id) denied(); return e;
}
function deployment(args: Record<string, unknown>, grant: Credential, selected: SelectedScope) {
  if (typeof args.deploymentId !== "string") denied();
  const d = q.deployment(args.deploymentId); if (!d) denied();
  project({ projectId: d.projectId }, grant, selected);
  environment({ projectId: d.projectId, environmentId: d.environmentId }, grant, selected);
  return d;
}
function page<T>(items: T[], args: Record<string, unknown>) {
  const limit = Number(args.limit ?? 50), offset = Number(args.cursor ?? 0);
  return { items: items.slice(offset, offset + limit), ...(items.length > offset + limit ? { nextCursor: String(offset + limit) } : {}) };
}
function validate(name: string, args: Record<string, unknown>) {
  const spec = readerTools.find(t => t.name === name)!;
  const fields = spec.inputSchema.properties as Record<string, Record<string, unknown>>;
  if (Object.keys(args).some(k => !Object.hasOwn(fields, k)) || (spec.inputSchema.required as string[]).some(k => args[k] === undefined))
    throw new AgentError("invalid_arguments", "Supply only the fields declared by this tool, including its required identifiers.", 400);
  for (const [key, value] of Object.entries(args)) {
    const field = fields[key]!;
    if (field.type === "string" && (typeof value !== "string" || value.length > 100 || !value.length)
      || field.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < Number(field.minimum) || field.maximum !== undefined && value > Number(field.maximum))
      || field.pattern && (typeof value !== "string" || !new RegExp(String(field.pattern)).test(value))
      || Array.isArray(field.enum) && !field.enum.includes(value))
      throw new AgentError("invalid_arguments", "Use the declared string, integer, cursor and enum bounds.", 400);
  }
}
export async function callReader(name: string, args: Record<string, unknown>, grant: Credential, selected: SelectedScope): Promise<unknown> {
  validate(name, args); const actor = member(grant);
  switch (name) {
    case "zenith_get_context": return { selected, user: { id: actor.id, name: actor.name, role: actor.role }, credentialId: grant.id, expiresAt: grant.expiresAt, mode: "read-only" };
    case "zenith_get_capabilities": return { contractVersion: 1, mode: "read-only", providers: providers.map(p => ({ id: p.id, availability: p.availability, description: p.tagline })),
      unavailable: { execute: "Durable receipts, atomic execution and trusted approvals are not integrated.", remoteOAuth: "Not implemented; this endpoint is loopback development only.", publishing: "Hosted source uploads and app-owner authorization are not integrated.", logs: "Free-form logs are excluded to reduce secret leakage.", metrics: "No metrics ingestion or automatic provider verification is implied." } };
    case "zenith_list_projects": return page(db().projects.filter(p => p.workspaceId === grant.workspaceId && grant.projectIds.includes(p.id) && (!selected.projectId || selected.projectId === p.id)).sort((a, b) => a.id.localeCompare(b.id)).map(p => ({ id: p.id, name: p.name, slug: p.slug })), args);
    case "zenith_get_project": { const p = project(args, grant, selected); return { id: p.id, name: p.name, slug: p.slug, workspaceId: p.workspaceId, workingMonthlyUsd: monthlyCostUsd(p.workingManifest), costIsEstimate: true }; }
    case "zenith_get_manifest": {
      const p = project(args, grant, selected);
      if (args.view !== "deployed") return { view: "working", manifest: p.workingManifest, redaction: "All literal environment values are removed; vault references remain." };
      const e = environment(args, grant, selected), m = e.deployedRevisionId ? q.revisionManifest(e.deployedRevisionId) : undefined;
      if (!m) throw new AgentError("not_deployed", "No deployed manifest exists here. Inspect the working copy instead.", 409);
      return { view: "deployed", revisionId: e.deployedRevisionId, manifest: m, redaction: "All literal environment values are removed; vault references remain." };
    }
    case "zenith_list_environments": { const p = project(args, grant, selected); return page(q.environmentsOf(p.id).filter(e => (!grant.environmentIds || grant.environmentIds.includes(e.id)) && (!selected.environmentId || selected.environmentId === e.id)).sort((a, b) => a.id.localeCompare(b.id)).map(e => ({ id: e.id, name: e.name, class: e.class, region: e.region, deployedRevisionId: e.deployedRevisionId })), args); }
    case "zenith_plan_deploy": {
      const e = environment(args, grant, selected), p = project(args, grant, selected);
      providers.forEach(registerProvider); registerAllActions();
      const preview = await runAction("deploy.apply", { workspaceId: grant.workspaceId, projectId: p.id, environmentId: e.id, actor: { type: "user", id: actor.id, name: actor.name } }, { projectId: p.id, environmentId: e.id }, { mode: "plan" });
      return { ...preview, executable: false, receipt: null, notice: "Read-only preview, not approval or an executable plan receipt. Continue in Zenith's reviewed UI." };
    }
    case "zenith_list_deployments": { const e = environment(args, grant, selected); return page(q.deploymentsOf(e.id).map(d => ({ id: d.id, status: d.status, revisionId: d.revisionId, createdAt: d.createdAt, changeSummary: d.changeSummary })), args); }
    case "zenith_get_deployment": { const d = deployment(args, grant, selected); return { id: d.id, status: d.status, revisionId: d.revisionId, createdAt: d.createdAt, endedAt: d.endedAt, steps: d.steps, outputs: d.outputs }; }
    case "zenith_get_events": {
      const d = deployment(args, grant, selected), after = Number(args.after ?? -1), limit = Number(args.limit ?? 50);
      const all = readEvents(d.id, after).filter(e => e.type !== "log").sort((a, b) => a.seq - b.seq), events = all.slice(0, limit);
      return { events, ...(all.length > limit ? { nextAfter: events[events.length - 1]!.seq } : {}), logsExcluded: true };
    }
    case "zenith_get_findings": { const p = project(args, grant, selected); return page(db().findings.filter(f => f.projectId === p.id && (!f.environmentId || (!grant.environmentIds || grant.environmentIds.includes(f.environmentId)) && (!selected.environmentId || selected.environmentId === f.environmentId))).sort((a, b) => a.id.localeCompare(b.id)), args); }
    case "zenith_get_drift": {
      const e = environment(args, grant, selected), provider = providers.find(p => p.id === q.connection(e.connectionId)?.provider);
      if (!provider?.observe || provider.availability !== "available") throw new AgentError("provider_unavailable", "This provider cannot supply live read-back here. AWS Preview does not inspect an AWS account.", 501);
      const manifest = e.deployedRevisionId ? q.revisionManifest(e.deployedRevisionId) : undefined;
      if (!manifest) throw new AgentError("not_deployed", "Deploy a revision through Zenith before requesting drift.", 409);
      const live = await provider.observe(e, manifest);
      return { provider: provider.id, simulated: live.simulated, observedAt: live.observedAt, revisionId: e.deployedRevisionId, items: computeDrift(manifest, live) };
    }
    case "zenith_export_project": {
      const p = project(args, grant, selected), e = environment(args, grant, selected), provider = providers.find(p => p.id === q.connection(e.connectionId)?.provider);
      if (!provider || provider.availability === "planned") throw new AgentError("provider_unavailable", "This provider cannot export. Select an available or Preview provider in Zenith.", 501);
      return { ...provider.exportBundle(e, redact(p.workingManifest) as Manifest), valuesRedacted: true, notice: "Supply environment values separately. Exporting does not apply infrastructure or write a local file." };
    }
    default: throw new AgentError("capability_unavailable", "This endpoint exposes read-only tools only.");
  }
}
export const agentReader = createReaderHandler({
  enabled: process.env.ZENITH_AGENT_READER === "1" && !process.env.VERCEL,
  origin: process.env.ZENITH_AGENT_ORIGIN ?? "", credentialsPath: process.env.ZENITH_AGENT_CREDENTIAL_FILE ?? "",
  tools: readerTools,
  async inScope(grant, selected, fn) {
    if (!isPostgres()) claimDataDir(env().ZENITH_DATA);
    const snapshot = isPostgres() ? await loadSnapshot(pgClient(), { id: grant.subject, email: "" }) : undefined;
    return runWithSnapshot(snapshot, async () => {
      member(grant);
      if (selected.projectId) project({}, grant, selected);
      if (selected.environmentId) environment({}, grant, selected);
      return fn();
    });
  },
  call: callReader,
  log(record) { console.info(JSON.stringify(record)); },
});
