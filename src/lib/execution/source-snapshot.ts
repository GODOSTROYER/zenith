/** Approved build inputs are immutable data, never executable host material. */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { LeaseRef } from "@/lib/workflows/types";
import type { ExecContext } from "./context";
import type { Runtime } from "./runtime";
import { isApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { StepFailedError } from "./errors";

export const APPROVED_SOURCE_FORMAT = "zenith.approved-source.v1" as const;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const Address = z.string().regex(/^[a-z_]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/);
const Path = z.string().max(200).regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(v => v.split("/").every(part => part !== "."));
const Ref = z.string().min(1).max(250).refine(v => v.split("/").every(s => /^[A-Za-z0-9._+@~-]{1,100}$/.test(s) && ![".", ".."].includes(s)));
const Binding = z.object({ appId: z.string().regex(/^[1-9]\d{0,15}$/), installationId: z.number().int().positive().safe(), repositoryId: z.number().int().positive().safe(), version: z.number().int().positive().safe() }).strict();
export const ApprovedSourceSchema = z.object({
  format: z.literal(APPROVED_SOURCE_FORMAT), workspaceId: Id, operationId: Id, projectId: Id, environmentId: Id,
  serviceAddress: Address, serviceSpecDigest: Hash, pipelineAddress: Address, pipelineSpecDigest: Hash,
  provider: z.enum(["aws", "gcp", "azure"]), region: Id,
  owner: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/), repo: z.string().regex(/^[a-z0-9._-]{1,100}$/).refine(v => ![".", ".."].includes(v)),
  repositoryId: z.number().int().positive().safe(), requestedRef: Ref, commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  githubBinding: Binding.nullable(), dockerfile: Path, dockerfileDigest: Hash, recipeDigest: Hash,
  archiveFormat: z.enum(["zip", "tar.gz"]), archiveDigest: Hash, archiveBytes: z.number().int().positive().max(32 * 1024 * 1024),
}).strict().refine(v => v.archiveFormat === (v.provider === "aws" ? "zip" : "tar.gz") && (!v.githubBinding || v.githubBinding.repositoryId === v.repositoryId));
export type ApprovedSourceSnapshot = z.infer<typeof ApprovedSourceSchema>;
export type SourceCaptureInput = Omit<ApprovedSourceSnapshot, "format" | "owner" | "repo" | "repositoryId" | "commitSha" | "githubBinding" | "archiveDigest" | "archiveBytes" | "dockerfileDigest"> & { repository: string };
export type SourceScope = Pick<ApprovedSourceSnapshot, "workspaceId" | "operationId" | "projectId" | "environmentId">;

/** Reject accessors/non-JSON authority before parsing or hashing. */
export function immutableSourceSnapshot(input: unknown): Readonly<ApprovedSourceSnapshot> {
  const seen = new Set<object>(); let keys = 0;
  const plain = (v: unknown, depth = 0): void => {
    if (depth > 3 || ++keys > 100) throw new StepFailedError("Approved source input is invalid.");
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) throw new StepFailedError("Approved source input is invalid.");
    if (seen.has(v)) throw new StepFailedError("Approved source input is invalid.");
    seen.add(v);
    const d = Object.getOwnPropertyDescriptors(v);
    for (const key of Reflect.ownKeys(d)) {
      if (typeof key !== "string" || !d[key].enumerable || !("value" in d[key])) throw new StepFailedError("Approved source input is invalid.");
      plain(d[key].value, depth + 1);
    }
  };
  plain(input);
  const p = ApprovedSourceSchema.safeParse(input);
  if (!p.success) throw new StepFailedError("Approved source input is invalid.");
  if (p.data.githubBinding) Object.freeze(p.data.githubBinding);
  return Object.freeze(p.data);
}
export const sourceSnapshotDigest = (input: ApprovedSourceSnapshot): string => digest(immutableSourceSnapshot(input));
export function sourceSnapshotSetDigest(rows: readonly ApprovedSourceSnapshot[]): string {
  const sorted = [...rows].sort((a, b) => a.serviceAddress < b.serviceAddress ? -1 : a.serviceAddress > b.serviceAddress ? 1 : 0);
  if (!sorted.length || new Set(sorted.map(r => r.serviceAddress)).size !== sorted.length) throw new StepFailedError("Approved source set is invalid.");
  return digest({ format: APPROVED_SOURCE_FORMAT, sources: sorted.map(sourceSnapshotDigest) });
}
type RecipeNode = Pick<ResourceNode, "address" | "provider" | "region" | "specDigest" | "spec">;
export function sourceRecipe(service: RecipeNode, pipeline: RecipeNode): string {
  return digest({ format: "zenith.build-recipe.v1", provider: service.provider, region: service.region,
    service: { address: service.address, specDigest: service.specDigest, spec: service.spec },
    pipeline: { address: pipeline.address, specDigest: pipeline.specDigest, spec: pipeline.spec } });
}
/** Full SQL recipe and its declared original source must agree with the captured metadata. */
export function sourceRecipeMatches(s: ApprovedSourceSnapshot, service: RecipeNode, pipeline: RecipeNode): boolean {
  const artifact=service.spec.artifact as {type?:unknown;pipeline?:unknown}|undefined;
  const source=pipeline.spec.source as {repo?:unknown;ref?:unknown;dockerfile?:unknown}|undefined;
  if(!source || typeof source.repo!=="string" || source.ref!==s.requestedRef || (source.dockerfile??"Dockerfile")!==s.dockerfile
    || artifact?.type!=="built" || artifact.pipeline!==s.pipelineAddress) return false;
  const match=/^(?:(?:https:\/\/)?github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/.exec(source.repo);
  return !!match && match[1].toLowerCase()===s.owner && match[2].replace(/\.git$/,"").toLowerCase()===s.repo
    && sourceRecipe(service,pipeline)===s.recipeDigest;
}
function inputs(ec: ExecContext, graph: ResourceGraph): SourceCaptureInput[] {
  return graph.nodes.filter(n => n.ownership === "managed" && ["container_service", "scheduled_job"].includes(n.kind) && (n.spec.artifact as { type?: string } | undefined)?.type === "built").map(service => {
    const artifact = service.spec.artifact as { pipeline: string };
    const pipeline = graph.nodes.find(n => n.address === artifact.pipeline && n.kind === "build_pipeline" && n.ownership === "managed");
    const source = pipeline?.spec.source as { repo?: string; ref?: string; dockerfile?: string } | undefined;
    if (!pipeline || !source?.repo || !source.ref || !["aws", "gcp", "azure"].includes(service.provider)
      || pipeline.provider !== service.provider || pipeline.region !== service.region) throw new StepFailedError("Approved source requires a supported owned build pipeline.");
    return { workspaceId: ec.workspaceId, operationId: ec.op.id, projectId: ec.product.project.id, environmentId: ec.environmentId,
      serviceAddress: service.address, serviceSpecDigest: service.specDigest, pipelineAddress: pipeline.address, pipelineSpecDigest: pipeline.specDigest,
      provider: service.provider as "aws" | "gcp" | "azure", region: service.region, repository: source.repo, requestedRef: source.ref,
      dockerfile: source.dockerfile ?? "Dockerfile", recipeDigest: sourceRecipe(service, pipeline), archiveFormat: service.provider === "aws" ? "zip" as const : "tar.gz" as const };
  }).sort((a, b) => a.serviceAddress < b.serviceAddress ? -1 : a.serviceAddress > b.serviceAddress ? 1 : 0);
}
/** Source authority is derived from the owning immutable store, never workflow args. */
export async function approvedSources(rt: Runtime, ec: ExecContext, graph: ResourceGraph, lease: LeaseRef, capture: boolean, signal?: AbortSignal): Promise<readonly ApprovedSourceSnapshot[]> {
  const wanted = inputs(ec, graph);
  if (!wanted.length) return [];
  if(!capture && !ec.op.planDigest) throw new StepFailedError("This build has no reviewed source-bound plan; a new operation and review are required.");
  const store = rt.d.sourceSnapshots, bundle = rt.d.sourceBundle;
  if (!isApprovedSourceSnapshotStore(store) || !bundle?.capture || !bundle.verify) throw new StepFailedError("Durable approved source capture is unavailable; configure the owning source store before planning.");
  const scope = { workspaceId: ec.workspaceId, operationId: ec.op.id, projectId: ec.product.project.id, environmentId: ec.environmentId };
  const rows = await store.list(scope);
  if (rows.some(r => !wanted.some(w => w.serviceAddress === r.serviceAddress))) throw new StepFailedError("Approved source set changed; a new operation and review are required.");
  const result: ApprovedSourceSnapshot[] = [];
  for (const w of wanted) {
    let row = rows.find(r => r.serviceAddress === w.serviceAddress);
    if (!row) {
      // Never add executable semantics to a plan already recorded or reviewed.
      if (!capture || ec.op.planDigest) throw new StepFailedError("This build plan has no approved source snapshot; a new operation and review are required.");
      row = await store.retain(await bundle.capture(w, signal), lease);
    }
    if (row.recipeDigest !== w.recipeDigest || row.serviceSpecDigest !== w.serviceSpecDigest || row.pipelineSpecDigest !== w.pipelineSpecDigest
      || row.pipelineAddress !== w.pipelineAddress || row.provider !== w.provider || row.region !== w.region || row.requestedRef !== w.requestedRef
      || row.dockerfile !== w.dockerfile || row.archiveFormat !== w.archiveFormat) throw new StepFailedError("Approved source recipe changed; a new operation and review are required.");
    await bundle.verify(row, signal);
    await store.assertCurrent(row);
    result.push(row);
  }
  ec.approvedSourceSnapshots = Object.freeze(result);
  ec.executableSourceDigest = sourceSnapshotSetDigest(result);
  if (ec.op.planDigest) {
    const evidence = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: ec.op.id, kind: "tofu_plan", digest: ec.op.planDigest, stage: "plan" });
    if (!evidence || evidence.simulated || evidence.workspaceId !== ec.workspaceId || evidence.operationId !== ec.op.id
      || evidence.digest !== ec.op.planDigest || evidence.summary.stage!=="plan" || evidence.summary.planDigest !== ec.op.planDigest
      || evidence.summary.executableSourceDigest !== ec.executableSourceDigest) throw new StepFailedError("The reviewed build plan does not bind this source snapshot; a new operation and review are required.");
  }
  return ec.approvedSourceSnapshots;
}
