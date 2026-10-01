/**
 * Read-side helpers specific to the compute group (everything generic —
 * error classification, observed values, `boundNative`, pagination — comes
 * from the shared snapshot in `./aws-shared`).
 *
 * Conventions the drivers follow (DRIVER-CONVENTIONS):
 *   - objects are found by `externalId`, else by the Zenith tags
 *     (`zenith:workspace` + `zenith:environment` + `zenith:resource`), never by
 *     name alone — `findByTags` goes through the Resource Groups Tagging API;
 *   - an abort is never an observation result: `failureOf` re-throws it;
 *   - mutating operations re-check the target's tags before acting
 *     (`assertNodeTags`).
 */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { classifyAwsError, fromAwsTagList, matchesNodeTags, paginate, scopeTagValues, throwIfAborted, type AwsDriverContext, type AwsFailure, type AwsTag } from "./aws-shared";
import type { ResourceNode } from "@/lib/resources/types";

export type AwsCtx = AwsDriverContext;

/**
 * Classify a caught error; re-throw instead when the operation was cancelled,
 * so an abort surfaces as an abort and never as `presence: unknown`.
 */
export function failureOf(ctx: AwsCtx, err: unknown): AwsFailure {
  const f = classifyAwsError(err, ctx.signal);
  if (f.kind === "aborted") {
    throwIfAborted(ctx.signal);
    throw err instanceof Error ? err : new Error("aborted");
  }
  return f;
}

export const tagsOf = (list: readonly AwsTag[] | undefined): Record<string, string> => fromAwsTagList(list as AwsTag[] | undefined);

/** `[{key,value}]` (ECS / ECR-style lowercase) tag lists → a map. */
export function lowerTagMap(list: readonly { key?: string; value?: string }[] | undefined): Record<string, string> {
  return tagsOf((list ?? []).map((t) => ({ Key: t.key, Value: t.value })));
}

export interface TaggedResource {
  arn: string;
  tags: Record<string, string>;
}

const MAX_TAG_PAGES = 3;

async function tagged(ctx: AwsCtx, filters: { Key: string; Values: string[] }[] | undefined, resourceType: string, region?: string): Promise<{ items: TaggedResource[]; truncated: boolean }> {
  const client = ctx.session.client(ResourceGroupsTaggingAPIClient, region ? { region } : undefined);
  return paginate<TaggedResource>(
    async (token) => {
      const res = await client.send(
        new GetResourcesCommand({
          ...(filters ? { TagFilters: filters } : {}),
          ResourceTypeFilters: [resourceType],
          ResourcesPerPage: 100,
          ...(token ? { PaginationToken: token } : {}),
        }),
        { abortSignal: ctx.signal }
      );
      const items: TaggedResource[] = [];
      for (const r of res.ResourceTagMappingList ?? []) if (r.ResourceARN) items.push({ arn: r.ResourceARN, tags: tagsOf(r.Tags) });
      return { items, next: res.PaginationToken || undefined };
    },
    { maxPages: MAX_TAG_PAGES, signal: ctx.signal }
  );
}

/**
 * Resources of one type carrying this node's Zenith tags. The Resource Groups
 * Tagging API is regional (CloudFront and other global services are served
 * from us-east-1: pass `region`), eventually consistent (an object created a
 * moment ago can take a while to appear) and paginated (pages are bounded).
 */
export async function findByTags(ctx: AwsCtx, node: Pick<ResourceNode, "address">, resourceType: string, opts: { region?: string } = {}): Promise<TaggedResource[]> {
  const want = scopeTagValues(ctx);
  const { items } = await tagged(
    ctx,
    [
      { Key: "zenith:environment", Values: [want.environment] },
      { Key: "zenith:workspace", Values: [want.workspace] },
      { Key: "zenith:resource", Values: [node.address] },
    ],
    resourceType,
    opts.region
  );
  return items.filter((r) => matchesNodeTags(r.tags, ctx, node.address));
}

/** Every resource of one type in the region (discovery); `truncated` when the page bound was hit. */
export function listByType(ctx: AwsCtx, resourceType: string, opts: { region?: string } = {}): Promise<{ items: TaggedResource[]; truncated: boolean }> {
  return tagged(ctx, undefined, resourceType, opts.region);
}

/** A mutating operation declined to act (wrong target, invalid input). Never a provider error. */
export class OperationRefused extends Error {
  readonly code = "operation_refused";
  constructor(message: string) {
    super(message);
    this.name = "OperationRefused";
  }
}

/** The pre-mutation check: the object carries THIS node's tags in THIS environment. */
export function assertNodeTags(ctx: AwsCtx, node: ResourceNode, tags: Record<string, string>, what: string): void {
  if (!matchesNodeTags(tags, ctx, node.address)) {
    throw new OperationRefused(`${what} does not carry the Zenith tags of ${node.address} in this environment; refusing to act on it.`);
  }
}

/* ---------------------------------- misc ---------------------------------- */

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const aborted = () => {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
  };
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A number from an SDK string/number field, or undefined. */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
