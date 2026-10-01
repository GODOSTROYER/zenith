/**
 * OCI releases use only the broker's runner transport. Provider bodies and thrown
 * diagnostics never reach errors or logs. Listings must be complete before a
 * migration launch; uncertain writes remain plain Errors. Contract evidence only.
 */
import type { OciSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import type { ResourceNode } from "@/lib/resources/types";
import { asRecord, tagsOf } from "../observe-kit";
export { MIGRATION_TAG } from "../naming";
import { MIGRATION_TAG } from "../naming";
import { isOcid, isRegionId, ociPath } from "../services";
import type { OciApiRequest, OciApiResponse } from "../transport";

export type ReleaseContext = DriverContext<OciSession>;
export type RecordValue = Record<string, unknown>;
export const MAX_RELEASE_TIMEOUT_MS = 30 * 60_000;

export function releaseContext(ctx: DriverContext): ReleaseContext {
  const s = ctx.session as Partial<OciSession> | undefined;
  if (ctx.provider !== "oci" || s?.provider !== "oci" || !s.transport ||
      !isRegionId(ctx.region) || s.region !== ctx.region || !isOcid(s.compartmentOcid) ||
      s.scope?.workspaceId !== ctx.workspaceId || s.scope.environmentId !== ctx.environmentId ||
      s.capability !== "deployment.deploy" || !s.expiresAt ||
      !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt) <= ctx.now().getTime()) {
    throw new StepFailedError("OCI release requires an unexpired deployment.deploy runner session for this workspace, environment and region.");
  }
  return { ...ctx, session: s as OciSession };
}

export function workload(ctx: ReleaseContext, node: ResourceNode): { replicas: number; image: string } {
  const artifact = asRecord(node.spec.artifact);
  const replicas = node.spec.replicas;
  if (node.provider !== "oci" || node.region !== ctx.region || node.ownership !== "managed" ||
      node.kind !== "container_service" || node.nativeType !== "oci:container_instance" ||
      !Number.isInteger(replicas) || (replicas as number) < 0 || (replicas as number) > 50) {
    throw new StepFailedError("OCI release supports managed Container Instances in the session's region only.");
  }
  if (artifact?.type !== "image" || typeof artifact.ref !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,400}@sha256:[a-f0-9]{64}$/.test(artifact.ref)) {
    throw new StepFailedError("Bring a pre-built OCIR image pinned to a sha256 digest in the manifest.");
  }
  return { replicas: replicas as number, image: artifact.ref };
}

export function timeoutSignal(ctx: ReleaseContext, timeoutMs: number): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RELEASE_TIMEOUT_MS) {
    throw new StepFailedError("OCI release timeout must be an integer in 1..1800000 milliseconds.");
  }
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
}

export async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(new Error("OCI release wait was cancelled or timed out; outcome is unknown.")); };
    const timer = setTimeout(() => { done(); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function request(ctx: ReleaseContext, req: OciApiRequest): Promise<OciApiResponse> {
  let abort: (() => void) | undefined;
  try {
    ctx.signal.throwIfAborted();
    if (Date.parse(ctx.session.expiresAt) <= ctx.now().getTime()) throw new Error();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error());
      ctx.signal.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([ctx.session.transport.request(req, { signal: ctx.signal }), cancelled]);
    ctx.signal.throwIfAborted();
    if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) throw new Error();
    return result;
  } catch {
    throw new Error("OCI release request failed or was cancelled; outcome is unknown.");
  } finally {
    if (abort) ctx.signal.removeEventListener("abort", abort);
  }
}

export function owned(ctx: ReleaseContext, item: RecordValue, address: string): boolean {
  const tags = tagsOf(item);
  return item.compartmentId === ctx.session.compartmentOcid &&
    tags.zenith_workspace === ctx.workspaceId && tags.zenith_environment === ctx.environmentId &&
    tags.zenith_resource === address && tags.zenith_managed === "true";
}

export function id(value: unknown, kind: string): string {
  if (!isOcid(value) || !value.startsWith(`ocid1.${kind}.`)) throw new Error("OCI release resource identity is unknown.");
  return value;
}

/** Eight pages is the existing OCI listing bound. Truncation cannot prove absence. */
export async function instances(ctx: ReleaseContext): Promise<RecordValue[]> {
  const result: RecordValue[] = [];
  const pages = new Set<string>();
  let page: string | undefined;
  for (let i = 0; i < 8; i++) {
    const res = await request(ctx, { service: "containerinstances", region: ctx.region, method: "GET",
      path: ociPath("containerinstances", "containerInstances"),
      query: { compartmentId: ctx.session.compartmentOcid, ...(page ? { page } : {}) } });
    const items = Array.isArray(res.body) ? res.body : asRecord(res.body)?.items;
    if (!Array.isArray(items) || items.some((item) => !asRecord(item))) throw new Error("OCI release listing is malformed; outcome is unknown.");
    result.push(...items as RecordValue[]);
    page = res.headers["opc-next-page"];
    if (!page) return result;
    if (pages.has(page)) break;
    pages.add(page);
  }
  throw new Error("OCI release listing is incomplete; outcome is unknown.");
}

export async function instance(ctx: ReleaseContext, instanceId: string, address: string): Promise<RecordValue> {
  const res = await request(ctx, { service: "containerinstances", region: ctx.region, method: "GET",
    path: ociPath("containerinstances", "containerInstances", id(instanceId, "computecontainerinstance")) });
  const item = asRecord(res.body);
  if (!item || item.id !== instanceId || !owned(ctx, item, address)) throw new Error("OCI release instance ownership is unknown.");
  return item;
}

export async function container(ctx: ReleaseContext, item: RecordValue, image: string): Promise<RecordValue> {
  const refs = item.containers;
  if (!Array.isArray(refs) || refs.length !== 1) throw new Error("OCI release requires exactly one container per instance.");
  const containerId = id(asRecord(refs[0])?.containerId, "computecontainer");
  const res = await request(ctx, { service: "containerinstances", region: ctx.region, method: "GET",
    path: ociPath("containerinstances", "containers", containerId) });
  const c = asRecord(res.body);
  if (!c || c.id !== containerId || c.containerInstanceId !== item.id ||
      c.compartmentId !== ctx.session.compartmentOcid || c.imageUrl !== image) {
    throw new Error("OCI release container identity or image digest does not match; outcome is unknown.");
  }
  return c;
}

export const liveWorkloads = (ctx: ReleaseContext, all: RecordValue[], node: ResourceNode): RecordValue[] =>
  all.filter((item) => owned(ctx, item, node.address) && !tagsOf(item)[MIGRATION_TAG] && item.lifecycleState !== "DELETED");
