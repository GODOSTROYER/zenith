/** Release safety helpers. No cloud response text or credentials escape these calls. */
import type { GcpSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { StepFailedError } from "@/lib/execution/errors";
import { gcpLabels, cloudName } from "@/lib/providers/gcp/naming";
import { rec, arr } from "@/lib/providers/gcp/read-kit";
import { gcpGet, gcpList } from "@/lib/providers/gcp/rest";
import { namePrefix } from "@/lib/execution/session";

export type Ctx = DriverContext<GcpSession>;
export const RUN = "https://run.googleapis.com/v2";
export const AR = "https://artifactregistry.googleapis.com/v1";
export const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const SOURCE_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;

export function context(ctx: DriverContext): Ctx {
  const session = ctx.session as Partial<GcpSession> | undefined;
  if (ctx.provider !== "gcp" || session?.provider !== "gcp" || ctx.region !== session.region || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(session.projectId ?? "") || !/^[a-z0-9-]{2,40}$/.test(ctx.region)) throw new StepFailedError("Release requires a matching GCP project and region session.");
  ctx.signal.throwIfAborted();
  return { ...ctx, session: session as GcpSession };
}

export function managed(ctx: Ctx, node: ResourceNode, kind?: ResourceNode["kind"]): void {
  if (node.provider !== "gcp" || node.region !== ctx.region || node.ownership !== "managed" || (kind && node.kind !== kind)) throw new StepFailedError("Release target is not a managed GCP resource in this region.");
}

export function labels(ctx: Ctx, node: ResourceNode): Record<string, string> {
  return gcpLabels({ "zenith:workspace": ctx.workspaceId, "zenith:environment": ctx.environmentId, "zenith:managed": "true", "zenith:resource": node.address });
}

export function assertLabels(ctx: Ctx, node: ResourceNode, obj: Record<string, unknown>): void {
  const found = rec(obj.labels);
  if (Object.entries(labels(ctx, node)).some(([k, v]) => found[k] !== v)) throw new StepFailedError("Release resource labels are outside this workspace/environment.");
}

export async function get(ctx: Ctx, url: string): Promise<Record<string, unknown>> {
  const res = await gcpGet(ctx, url);
  if (res.outcome !== "ok") throw new Error("GCP release state could not be read; outcome is unknown.");
  return res.json;
}

export function pinned(uri: string, digest?: string): void {
  if (typeof uri !== "string" || uri.length > 500 || !/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(uri) || uri.split("/").some((p) => p === ".." || p === ".") || (digest !== undefined && (!IMAGE_DIGEST.test(digest) || !uri.endsWith(`@${digest}`)))) throw new StepFailedError("Release image must be pinned to its matching sha256 digest.");
}

export function container(template: Record<string, unknown>): Record<string, unknown> {
  const cs = arr(template.containers);
  if (cs.length !== 1) throw new StepFailedError("Release requires exactly one workload container.");
  return rec(cs[0]);
}

export function select(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => obj[key] !== undefined).map((key) => [key, obj[key]]));
}

export function bounded(ctx: Ctx, timeoutMs: number): { ctx: Ctx; deadline: number; timeout: AbortSignal } {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) throw new StepFailedError("Release timeout must be 1–3600000 milliseconds.");
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ctx: { ...ctx, signal: AbortSignal.any([ctx.signal, timeout]) }, deadline: Date.now() + timeoutMs, timeout };
}

export async function pause(ctx: Ctx, deadline: number): Promise<void> {
  ctx.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); ctx.signal.removeEventListener("abort", abort); reject(new Error("Release wait was interrupted; outcome is unknown.")); };
    const timer = setTimeout(() => { ctx.signal.removeEventListener("abort", abort); resolve(); }, Math.max(1, Math.min(1000, deadline - Date.now())));
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
  });
}

/** Resolve by validated external id or the compiler's stable name, then verify ALL tenant labels. */
export async function workload(ctx: Ctx, node: ResourceNode): Promise<{ name: string; obj: Record<string, unknown>; template: Record<string, unknown> }> {
  managed(ctx, node);
  if (!["container_service", "scheduled_job"].includes(node.kind)) throw new StepFailedError("Release target is not a GCP workload.");
  const collection = node.kind === "scheduled_job" ? "jobs" : "services";
  const base = `projects/${ctx.session.projectId}/locations/${ctx.region}/${collection}`;
  let name = node.externalRef;
  if (name !== undefined && (!name.startsWith(`${base}/`) || !/^[a-z][a-z0-9-]{0,62}$/.test(name.slice(base.length + 1)))) throw new StepFailedError("Workload external id is outside this GCP project/region.");
  if (!name) {
    // Tests / older compilers can use another name prefix. Label search is bounded and must be unique.
    const list = await gcpList(ctx, `${RUN}/${base}?pageSize=100`, collection);
    if (list.outcome !== "ok" || list.truncated) throw new Error("GCP workload search is incomplete; outcome is unknown.");
    const expected = labels(ctx, node);
    const matches = list.items.filter((o) => Object.entries(expected).every(([k, v]) => rec(o.labels)[k] === v));
    if (matches.length !== 1 || typeof matches[0].name !== "string") throw new StepFailedError("GCP workload could not be uniquely located in this environment.");
    name = matches[0].name;
    if (!name.startsWith(`${base}/`) || !/^[a-z][a-z0-9-]{0,62}$/.test(name.slice(base.length + 1))) throw new StepFailedError("GCP workload response names a foreign resource.");
  }
  const obj = await get(ctx, `${RUN}/${name}`);
  if (obj.name !== name) throw new StepFailedError("GCP workload identity does not match its requested name.");
  assertLabels(ctx, node, obj);
  const template = node.kind === "scheduled_job" ? rec(rec(obj.template).template) : rec(obj.template);
  return { name, obj, template };
}

export function pipelineNames(ctx: Ctx, node: ResourceNode): { bucket: string; serviceAccount: string } {
  const prefix = namePrefix(ctx.environmentId);
  return {
    bucket: cloudName(prefix, node.address, { max: 63, min: 3, suffix: "src", unique: ctx.environmentId }).replace(/goog/g, "gog"),
    serviceAccount: `${cloudName(prefix, node.address, { max: 30, min: 6, suffix: "bld" })}@${ctx.session.projectId}.iam.gserviceaccount.com`,
  };
}
