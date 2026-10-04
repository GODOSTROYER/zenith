/** Internal native MCP admission. Captures are derived from locked operations, never caller proofs. */
import { z } from "zod/v4";
import { digest } from "@/lib/controlplane/digest";
import type { Sql, Principal } from "@/lib/controlplane/types";
import { isOpenedPlatformDbHandle, isOpenedPlatformPostgresTarget, platformDbConfigFromEnv } from "../open";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { expandManifest } from "@/lib/resources/expand";
import { textArray } from "../sql";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Input = z.object({ operation: z.literal("deploy"), admissionVersion: z.literal(1),
  deploymentId: z.string().regex(/^mcp-deploy-[a-f0-9]{64}$/), revisionId: Id, revisionNumber: z.number().int().positive(), connectionId: Id,
  manifestDigest: Hash, graphDigest: Hash, environmentDigest: Hash, connectionDigest: Hash,
  build: z.boolean(), message: z.string().max(1000).optional(), estimate: z.record(z.string(), z.unknown()) }).strict();
const RecordValue = z.record(z.string(), z.unknown());
const Version = z.number().int().positive().safe();
const Row = z.object({ id: Id, workspace_id: Id, data: RecordValue, version: Version }).passthrough();
type NativeRow = z.infer<typeof Row>;
export interface DeployOperation {
  workspace_id: string; id: string; project_id: string | null; environment_id: string | null;
  principal: Principal; proposal: { input?: Record<string, unknown> }; plan_digest: string | null;
}
const refused = (): never => { throw new Error("Native current MCP deployment authority is unavailable or changed."); };
const bounded = <T>(value: T): T => {
  if (Buffer.byteLength(JSON.stringify(value)) > 2_000_000) return refused();
  return value;
};
const one = (rows: { row: unknown }[]): NativeRow => {
  if (rows.length !== 1) return refused();
  const result = Row.safeParse(rows[0].row);
  return result.success ? bounded(result.data) : refused();
};
export function requiresMcpDeployAuthority(kind: string, op: DeployOperation): boolean {
  const input = op.proposal.input;
  return kind === "deploy" && (!!input && Object.hasOwn(input, "admissionVersion")
    || typeof input?.deploymentId === "string" && input.deploymentId.startsWith("mcp-deploy-"));
}

/** Hosted default topology only. Custom/separate stores cannot supply final native product predicates. */
async function defaultMcpProductTopology(sql: Sql, session: Sql): Promise<void> {
  const [{ SUPABASE_URL }, { isDefaultProductClientFor }] = await Promise.all([
    import("@/lib/supabase/env"), import("@/lib/db/postgres-store"),
  ]);
  const currentComposition = (): void => {
    if (!isOpenedPlatformDbHandle(sql, "postgres") || process.env.ZENITH_STORE !== "postgres") return refused();
    const api = new URL(SUPABASE_URL), match = /^([a-z0-9]{20})\.supabase\.co$/.exec(api.hostname);
    if (!match || api.protocol !== "https:" || api.port || api.username || api.password || api.search || api.hash
      || !["", "/"].includes(api.pathname)) return refused();
    const config = platformDbConfigFromEnv(), product = process.env.SUPABASE_DB_URL;
    if (config.kind !== "postgres" || !config.url || !product) return refused();
    const selected = new URL(config.url), productDb = new URL(product);
    const endpoint = (url: URL) => JSON.stringify([url.hostname, url.port || "5432", url.pathname, decodeURIComponent(url.username), [...url.searchParams.entries()].sort()]);
    if (![selected, productDb].every(url => ["postgres:", "postgresql:"].includes(url.protocol) && !url.hash)
      || endpoint(selected) !== endpoint(productDb) || selected.pathname !== "/postgres") return refused();
    const options = [...selected.searchParams];
    if (options.length > 1 || options.some(([key, value]) => key !== "sslmode" || !["require", "verify-full"].includes(value))) return refused();
    const ref = match[1], port = selected.port || "5432", username = decodeURIComponent(selected.username);
    const direct = selected.hostname === `db.${ref}.supabase.co` && ["5432", "6543"].includes(port) && username === "postgres";
    const shared = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(selected.hostname)
      && ["5432", "6543"].includes(port) && username === `postgres.${ref}`;
    if ((!direct && !shared) || sql.identity !== `postgres://${selected.host}/postgres`
      || !isOpenedPlatformPostgresTarget(sql, selected.hostname, Number(port), "postgres", username)) return refused();
    if (!isDefaultProductClientFor(api.origin)) return refused();
  };
  currentComposition();
  const rows = await session.query<{ database: string; role: string; schema: string }>(
    "select current_database() as database,current_user as role,current_schema() as schema");
  if (rows.length !== 1 || rows[0].database !== "postgres" || rows[0].role !== "postgres" || rows[0].schema !== "public") return refused();
  currentComposition();
}
export async function assertDefaultMcpProductTopology(sql: Sql): Promise<void> {
  try { await defaultMcpProductTopology(sql, sql); } catch { return refused(); }
}
/** Internal canonical caller supplies its own transaction; no proof or callback is accepted. */
export async function assertFinalMcpProductTopology(sql: Sql, tx: Sql): Promise<void> {
  try { await defaultMcpProductTopology(sql, tx); } catch { return refused(); }
}

export interface McpDeployAuthority {
  member: { id: string; workspace_id: string; role: "editor" | "admin" };
  project: Record<string, unknown>; environment: Record<string, unknown>; revision: Record<string, unknown>; deployment: Record<string, unknown>; connection: NativeRow;
  manifest: Record<string, unknown>; providerConnection: Record<string, unknown>;
  bindings: Record<string, unknown>[]; sources: Record<string, unknown>[]; resources: Record<string, unknown>[];
  sourceAddresses: string[]; evidence: Record<string, unknown>[];
}

/** Every public row is read through the owning native connection and compared with the immutable native proposal. */
export async function captureMcpDeployAuthority(tx: Sql, op: DeployOperation): Promise<McpDeployAuthority> {
  const { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches } = await import("@/lib/execution/source-snapshot");
  const parsed = Input.safeParse(op.proposal.input);
  if (!parsed.success || op.principal.kind !== "integration" || !op.principal.integrationId || !op.principal.onBehalfOf) return refused();
  const input = parsed.data, ws = op.workspace_id;
  const [projects, environments, revisions, deployments, connections, manifests, members] = await Promise.all([
    tx.query<{ row: unknown }>("select to_jsonb(p) as row from public.projects p where id=$1 and workspace_id=$2", [op.project_id, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(e) as row from public.environments e where id=$1 and workspace_id=$2", [op.environment_id, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(r) as row from public.revisions r where id=$1 and workspace_id=$2", [input.revisionId, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(d) as row from public.deployments d where id=$1 and workspace_id=$2", [input.deploymentId, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(c) as row from public.connections c where id=$1 and workspace_id=$2", [input.connectionId, ws]),
    tx.query<{ row: unknown }>("select to_jsonb(m) as row from public.revision_manifests m where revision_id=$1 and workspace_id=$2", [input.revisionId, ws]),
    tx.query<{ row: unknown }>("select jsonb_build_object('id',id,'workspace_id',workspace_id,'role',role) as row from public.members where id=$1 and workspace_id=$2", [op.principal.onBehalfOf, ws]),
  ]);
  const member = members.length === 1 && z.object({ id: Id, workspace_id: Id, role: z.enum(["editor", "admin"]) }).strict().safeParse(members[0].row);
  if (!member || !member.success || member.data.id !== op.principal.onBehalfOf || member.data.workspace_id !== ws) return refused();
  const project = one(projects), environment = one(environments), revision = one(revisions), deployment = one(deployments), connection = one(connections);
  const manifestRow = manifests.length === 1 && RecordValue.safeParse(manifests[0].row);
  if (!manifestRow || !manifestRow.success || manifestRow.data.revision_id !== revision.id || manifestRow.data.workspace_id !== ws
    || !Version.safeParse(manifestRow.data.version).success || project.id !== op.project_id || environment.project_id !== project.id
    || revision.project_id !== project.id || revision.number !== input.revisionNumber || deployment.project_id !== project.id
    || deployment.environment_id !== environment.id || deployment.revision_id !== revision.id || environment.connection_id !== connection.id
    || deployment.data.executor !== "workflow" || deployment.data.operationId !== op.id) return refused();
  const saved = z.object({ version: z.literal(1), workspaceId: Id, integrationId: Id, subject: Id,
    reservationDigest: Hash, input: Input }).strict().safeParse(deployment.data.mcpAdmission);
  if (!saved.success || saved.data.workspaceId !== ws || saved.data.integrationId !== op.principal.integrationId
    || saved.data.integrationId !== op.principal.id || saved.data.subject !== op.principal.onBehalfOf
    || `mcp-deploy-${saved.data.reservationDigest}` !== deployment.id || digest(saved.data.input) !== digest(input)) return refused();
  const env = { id: environment.id, projectId: project.id, name: environment.data.name, class: environment.class,
    region: environment.data.region, baseDomain: environment.data.baseDomain, connectionId: environment.connection_id,
    policies: environment.data.policies };
  const envParsed = z.object({ id: Id, projectId: Id, name: z.string(), class: z.enum(["production", "staging", "sandbox"]),
    region: z.string(), baseDomain: z.string(), connectionId: Id, policies: RecordValue }).safeParse(env);
  const conn = z.object({ provider: z.enum(["aws", "gcp", "azure", "oci", "kubernetes", "zenith"]), region: z.string(), platformConnectionId: Id }).safeParse({ ...connection.data, provider: connection.provider });
  const manifest = parseManifest(manifestRow.data.manifest);
  if (!envParsed.success || !conn.success || !manifest.ok || digest(manifestRow.data.manifest) !== input.manifestDigest
    || digest(envParsed.data) !== input.environmentDigest
    || digest({ id: connection.id, workspaceId: ws, provider: connection.provider, region: conn.data.region,
      platformConnectionId: conn.data.platformConnectionId }) !== input.connectionDigest || connection.provider !== conn.data.provider) return refused();
  const graph = expandManifest(manifest.manifest, { ...envParsed.data, provider: conn.data.provider });
  if (graph.graphDigest !== input.graphDigest || manifest.manifest.services.some(service => service.ownership === "managed" && service.source.type === "git") !== input.build) return refused();
  const providerRows = await tx.query<{ row: Record<string, unknown> }>(`select jsonb_build_object('id',id,'workspace_id',workspace_id,'provider',provider,
    'mode',mode,'config',config,'status',status,'revoked_at',revoked_at) as row from platform.provider_connections where id=$1 and workspace_id=$2`, [conn.data.platformConnectionId, ws]);
  if (providerRows.length !== 1 || providerRows[0].row.status !== "verified" || providerRows[0].row.revoked_at !== null
    || providerRows[0].row.provider !== conn.data.provider) return refused();
  const bindings = (await tx.query<{ row: Record<string, unknown> }>("select to_jsonb(b) as row from platform.github_source_bindings b where workspace_id=$1", [ws])).map(value => value.row);
  if (bindings.length > 1 || bindings[0]?.revoked_at != null) return refused();
  for (const service of manifest.manifest.services) {
    if (service.ownership !== "managed" || service.source.type !== "git") continue;
    const repository = /^(?:(?:https:\/\/)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(service.source.repo);
    if (!repository || bindings[0] && (bindings[0].owner !== repository[1].toLowerCase()
      || bindings[0].repo !== repository[2].replace(/\.git$/, "").toLowerCase())) return refused();
  }
  const sourceRows = await tx.query<{ row: Record<string, unknown> }>("select to_jsonb(s) as row from platform.approved_source_snapshots s where workspace_id=$1 and operation_id=$2 order by service_address collate \"C\" limit 10001", [ws, op.id]);
  if (sourceRows.length > 10000) return refused();
  const sourceAddresses = [...new Set(graph.nodes.filter(node => node.ownership === "managed" && ["container_service", "scheduled_job", "build_pipeline"].includes(node.kind)).map(node => node.address))].sort();
  const resources = (await tx.query<{ row: Record<string, unknown> }>("select to_jsonb(r) as row from platform.resources r where workspace_id=$1 and environment_id=$2 and address=any($3::text[]) order by address collate \"C\"", [ws, op.environment_id, textArray(sourceAddresses)])).map(value => value.row);
  const sources = sourceRows.map(value => {
    const row = value.row, source = immutableSourceSnapshot(row.snapshot);
    const service = graph.nodes.find(node => node.address === source.serviceAddress), pipeline = graph.nodes.find(node => node.address === source.pipelineAddress);
    if (source.workspaceId !== ws || source.operationId !== op.id || source.projectId !== project.id || source.environmentId !== environment.id
      || row.project_id !== project.id || row.environment_id !== environment.id || row.service_address !== source.serviceAddress
      || sourceSnapshotDigest(source) !== row.snapshot_digest || !service || !pipeline || !sourceRecipeMatches(source, service, pipeline)) return refused();
    for (const node of [service, pipeline]) {
      const native = resources.filter(value => value.address === node.address);
      if (native.length !== 1 || native[0].project_id !== project.id || native[0].provider !== node.provider || native[0].region !== node.region
        || native[0].ownership !== "managed" || native[0].status === "deleted" || native[0].spec_digest !== node.specDigest
        || digest(native[0].spec) !== digest(node.spec)) return refused();
    }
    const remembered = source.githubBinding, current = bindings[0];
    if (remembered ? !current || current.app_id !== remembered.appId || current.installation_id !== remembered.installationId
      || current.repository_id !== remembered.repositoryId || current.version !== remembered.version
      || current.owner !== source.owner || current.repo !== source.repo : !!current) return refused();
    return source;
  });
  const evidence = (await tx.query<{ row: Record<string, unknown> }>(`select jsonb_build_object('id',id,'summary',summary) as row from platform.evidence
    where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and not simulated and digest=$3 and summary->>'stage'='plan' order by id collate "C" limit 10001`, [ws, op.id, op.plan_digest])).map(value => value.row);
  if (evidence.length > 10000) return refused();
  const summaries = evidence.map(value => RecordValue.parse(value.summary));
  const sourceEvidence = summaries.filter(summary => Object.hasOwn(summary, "executableSourceDigest")
    || summary.view && typeof summary.view === "object" && ["executableSourceDigest", "approvedSources", "approvedSourcesTruncated", "approvedSourcesOmitted"].some(key => Object.hasOwn(summary.view as object, key)));
  // A concrete managed build cannot become source-free by removing both its
  // retained rows and every review marker. Match the same supported recipe
  // set that the owning worker requires, while allowing its initial planning
  // start before a concrete plan and source capture exist.
  const expected = graph.nodes.filter(node => node.ownership === "managed" && ["container_service", "scheduled_job"].includes(node.kind)
    && RecordValue.safeParse(node.spec.artifact).success && RecordValue.parse(node.spec.artifact).type === "built");
  if (op.plan_digest && (sources.length !== expected.length || expected.some(service => {
    const artifact = RecordValue.parse(service.spec.artifact), pipeline = graph.nodes.find(node => node.address === artifact.pipeline
      && node.kind === "build_pipeline" && node.ownership === "managed");
    return !pipeline || sources.filter(source => source.serviceAddress === service.address && source.pipelineAddress === pipeline.address).length !== 1;
  }) || expected.length > 0 && !sourceEvidence.length)) return refused();
  if (op.plan_digest && sources.length && !sourceEvidence.length || sourceEvidence.length && !sources.length) return refused();
  if (sourceEvidence.length) {
    const setDigest = sourceSnapshotSetDigest(sources), displayed = sources.slice(0, 64).map(source => ({ service: source.serviceAddress,
      commit: source.commitSha, dockerfileDigest: source.dockerfileDigest, recipeDigest: source.recipeDigest,
      archiveDigest: source.archiveDigest, archiveFormat: source.archiveFormat }));
    if (sourceEvidence.some(summary => {
      const view = RecordValue.safeParse(summary.view);
      return summary.planDigest !== op.plan_digest || summary.executableSourceDigest !== setDigest || !view.success
        || view.data.executableSourceDigest !== setDigest || digest(view.data.approvedSources) !== digest(displayed)
        || view.data.approvedSourcesTruncated !== (sources.length > 64 ? true : undefined)
        || view.data.approvedSourcesOmitted !== (sources.length > 64 ? sources.length - 64 : undefined);
    })) return refused();
  }
  // Preserve the exact saved operation when unrelated working-copy, history
  // labels, progress and newer UI pointers advance. Only approved semantics
  // and owning scope belong to these current product predicates.
  const projectAuthority = { id: project.id, workspace_id: ws };
  const environmentAuthority = { id: environment.id, workspace_id: ws, project_id: project.id, class: environment.class,
    connection_id: connection.id, data: { name: environment.data.name, region: environment.data.region,
      baseDomain: environment.data.baseDomain, policies: environment.data.policies } };
  const revisionAuthority = { id: revision.id, workspace_id: ws, project_id: project.id, number: input.revisionNumber };
  const deploymentAuthority = { id: deployment.id, workspace_id: ws, project_id: project.id, environment_id: environment.id,
    revision_id: revision.id, data: { executor: deployment.data.executor, operationId: deployment.data.operationId, mcpAdmission: deployment.data.mcpAdmission } };
  return bounded({ member: member.data, project: projectAuthority, environment: environmentAuthority, revision: revisionAuthority, deployment: deploymentAuthority,
    connection, manifest: manifestRow.data, providerConnection: providerRows[0].row,
    bindings, sources: sourceRows.map(value => value.row), resources, sourceAddresses, evidence });
}

/** $12 is produced internally before role/policy waits. This final statement sees committed changes at READ COMMITTED. */
export const MCP_DEPLOY_AUTHORITY = `($12::text::jsonb='null'::jsonb or (
  exists(select 1 from public.members m where m.id=o.principal->>'onBehalfOf' and m.workspace_id=o.workspace_id and m.role in ('editor','admin')
    and jsonb_build_object('id',m.id,'workspace_id',m.workspace_id,'role',m.role)=$12::text::jsonb->'member')
  and exists(select 1 from public.projects p where p.id=o.project_id and p.workspace_id=o.workspace_id
    and jsonb_build_object('id',p.id,'workspace_id',p.workspace_id)=$12::text::jsonb->'project')
  and exists(select 1 from public.environments e where e.id=o.environment_id and e.workspace_id=o.workspace_id
    and jsonb_build_object('id',e.id,'workspace_id',e.workspace_id,'project_id',e.project_id,'class',e.class,'connection_id',e.connection_id,
      'data',jsonb_build_object('name',e.data->'name','region',e.data->'region','baseDomain',e.data->'baseDomain','policies',e.data->'policies'))=$12::text::jsonb->'environment')
  and exists(select 1 from public.revisions r where r.id=o.proposal->'input'->>'revisionId' and r.workspace_id=o.workspace_id
    and jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'project_id',r.project_id,'number',r.number)=$12::text::jsonb->'revision')
  and exists(select 1 from public.revision_manifests m where m.revision_id=o.proposal->'input'->>'revisionId' and m.workspace_id=o.workspace_id and to_jsonb(m)=$12::text::jsonb->'manifest')
  and exists(select 1 from public.deployments d where d.id=o.proposal->'input'->>'deploymentId' and d.workspace_id=o.workspace_id
    and jsonb_build_object('id',d.id,'workspace_id',d.workspace_id,'project_id',d.project_id,'environment_id',d.environment_id,'revision_id',d.revision_id,
      'data',jsonb_build_object('executor',d.data->'executor','operationId',d.data->'operationId','mcpAdmission',d.data->'mcpAdmission'))=$12::text::jsonb->'deployment')
  and exists(select 1 from public.connections c where c.id=o.proposal->'input'->>'connectionId' and c.workspace_id=o.workspace_id and to_jsonb(c)=$12::text::jsonb->'connection')
  and exists(select 1 from platform.provider_connections c where c.workspace_id=o.workspace_id and c.id=$12::text::jsonb->'providerConnection'->>'id'
    and c.status='verified' and c.revoked_at is null and jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'provider',c.provider,'mode',c.mode,'config',c.config,'status',c.status,'revoked_at',c.revoked_at)=$12::text::jsonb->'providerConnection')
  and coalesce((select jsonb_agg(to_jsonb(b)) from platform.github_source_bindings b where b.workspace_id=o.workspace_id),'[]'::jsonb)=$12::text::jsonb->'bindings'
  and coalesce((select jsonb_agg(to_jsonb(s) order by s.service_address collate "C") from platform.approved_source_snapshots s where s.workspace_id=o.workspace_id and s.operation_id=o.id),'[]'::jsonb)=$12::text::jsonb->'sources'
  and coalesce((select jsonb_agg(to_jsonb(r) order by r.address collate "C") from platform.resources r where r.workspace_id=o.workspace_id and r.environment_id=o.environment_id
    and r.address in (select jsonb_array_elements_text($12::text::jsonb->'sourceAddresses'))),'[]'::jsonb)=$12::text::jsonb->'resources'
  and coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'summary',e.summary) order by e.id collate "C") from platform.evidence e where e.workspace_id=o.workspace_id and e.operation_id=o.id
    and e.kind='tofu_plan' and not e.simulated and e.digest=o.plan_digest and e.summary->>'stage'='plan'),'[]'::jsonb)=$12::text::jsonb->'evidence'))`;
