/** Azure release invariants. API errors and response text are never exported. */
import type { AzureSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { StepFailedError } from "@/lib/execution/errors";
import { armClient, armTypeOf, inSubscription, sameArmType, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";

export type Ctx = DriverContext<AzureSession>;
export interface LaunchScope { workspaceId: string; environmentId: string; key: string }
/**
 * An injected DURABLE, atomic insert-if-absent, tenant-scoped journal. Claim
 * stays consumed after timeout/crash. record/read store only validated cloud
 * identifiers. An in-memory map is suitable ONLY for contract tests. There is
 * built-in journal.ts uses the existing platform idempotency table; absence
 * of either that journal or an explicit override refuses launches.
 */
export interface LaunchJournal {
  claim(scope: LaunchScope): Promise<boolean>;
  record(scope: LaunchScope, reference: string): Promise<void>;
  read(scope: LaunchScope): Promise<string | undefined>;
}

export function context(ctx: DriverContext): Ctx {
  const session = ctx.session as Partial<AzureSession> | undefined;
  if (ctx.provider !== "azure" || session?.provider !== "azure" || ctx.region !== session.region || !/^[a-f0-9-]{36}$/i.test(session.subscriptionId ?? "")) throw new StepFailedError("Release requires a matching Azure subscription and region session.");
  ctx.signal.throwIfAborted();
  return { ...ctx, session: session as AzureSession };
}
export function managed(ctx: Ctx, node: ResourceNode, kind?: ResourceNode["kind"]): void {
  if (node.provider !== "azure" || node.region !== ctx.region || node.ownership !== "managed" || (kind && node.kind !== kind)) throw new StepFailedError("Release target is not a managed Azure resource in this region.");
}
export function rec(value: unknown): Json { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
export function arr(value: unknown): Json[] { return Array.isArray(value) ? value.map(rec) : []; }
export function select(obj: Json, keys: readonly string[]): Json { return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])); }
export function tags(ctx: Ctx, node: ResourceNode): Record<string, string> { return { "zenith:workspace": ctx.workspaceId, "zenith:environment": ctx.environmentId, "zenith:resource": node.address, "zenith:managed": "true" }; }
export function validId(ctx: Ctx, id: string, type: string): boolean {
  const found = armTypeOf(id);
  return !!found && sameArmType(found, type) && inSubscription(id, ctx.session.subscriptionId) && !/[\s%?#\\]/.test(id) && !id.includes("..") && !id.includes("//");
}
export function assertResource(ctx: Ctx, node: ResourceNode, res: ArmResource, type: string): void {
  if (typeof res.id !== "string" || !validId(ctx, res.id, type) || typeof res.type !== "string" || !sameArmType(res.type, type) || Object.entries(tags(ctx, node)).some(([k, v]) => res.tags?.[k] !== v)) throw new StepFailedError("Azure release resource is outside this workspace/environment/subscription.");
}
export async function locate(ctx: Ctx, node: ResourceNode, type: string): Promise<ArmResource> {
  managed(ctx, node);
  const arm = armClient(ctx.session, ctx.signal); const api = type === "Microsoft.ContainerRegistry/registries" ? API.containerRegistry : API.containerApps;
  let id = node.externalRef;
  if (id !== undefined && !validId(ctx, id, type)) throw new StepFailedError("Azure release external id is outside this subscription or has the wrong type.");
  if (!id) {
    let list;
    try { list = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/resources`, { apiVersion: "2021-04-01", query: { $filter: `tagName eq 'zenith:resource' and tagValue eq '${node.address.replace(/'/g, "''")}'` } }); } catch { throw new Error("Azure release resource search failed; outcome is unknown."); }
    if (list.truncated) throw new Error("Azure release resource search was truncated; identity is unknown.");
    const matches = list.items.filter((r) => typeof r.type === "string" && sameArmType(r.type, type) && Object.entries(tags(ctx, node)).every(([k, v]) => r.tags?.[k] === v));
    if (matches.length !== 1 || !validId(ctx, matches[0].id, type)) throw new StepFailedError("Azure release resource could not be uniquely located.");
    id = matches[0].id;
  }
  let res: ArmResource;
  try { res = (await arm.get<ArmResource>(id, { apiVersion: api })).body; } catch { throw new Error("Azure release resource state could not be read; outcome is unknown."); }
  if (typeof res?.id !== "string" || res.id.toLowerCase() !== id.toLowerCase()) throw new StepFailedError("Azure resource identity does not match the requested id.");
  assertResource(ctx, node, res, type);
  return res;
}
export function workloadType(node: ResourceNode): string {
  if (node.kind === "container_service") return "Microsoft.App/containerApps";
  if (node.kind === "scheduled_job") return "Microsoft.App/jobs";
  throw new StepFailedError("Release target is not an Azure workload.");
}
export const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
export function pinned(uri: string, imageDigest?: string): void {
  if (typeof uri !== "string" || uri.length > 500 || !/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(uri) || uri.split("/").some((p) => p === "." || p === "..") || (imageDigest !== undefined && (!IMAGE_DIGEST.test(imageDigest) || !uri.endsWith(`@${imageDigest}`)))) throw new StepFailedError("Release image must be pinned to its matching sha256 digest.");
}
export function container(template: Json): Json {
  const cs = arr(template.containers);
  if (cs.length !== 1 || typeof cs[0].name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cs[0].name)) throw new StepFailedError("Release requires exactly one identified workload container.");
  return cs[0];
}
export function bounded(ctx: Ctx, timeoutMs: number): { ctx: Ctx; deadline: number; timeout: AbortSignal } {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new StepFailedError("Release timeout must be 1–3600000 milliseconds.");
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ctx: { ...ctx, signal: AbortSignal.any([ctx.signal, timeout]) }, deadline: Date.now() + timeoutMs, timeout };
}
export async function pause(ctx: Ctx, deadline: number): Promise<void> {
  ctx.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", abort); reject(new Error("Azure release wait interrupted; outcome is unknown.")); };
    const timer = setTimeout(() => { ctx.signal.removeEventListener("abort", abort); resolve(); }, Math.max(1, Math.min(1000, deadline - Date.now())));
    ctx.signal.addEventListener("abort", abort, { once: true }); if (ctx.signal.aborted) abort();
  });
}
