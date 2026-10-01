/**
 * Shared helpers for the cleanup handlers: ARN parsing, error classification,
 * polling and retrying. All waiting goes through `ctx.sleep` so tests run
 * without real delays.
 */
import type { AwsAccess } from "./types";

export interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  /** everything after the fifth colon */
  resource: string;
  raw: string;
}

export function parseArn(raw: string): Arn | null {
  const m = /^arn:([a-z-]+):([a-z0-9-]+):([a-z0-9-]*):(\d{12}|aws|):(.+)$/.exec(raw);
  if (!m) return null;
  return { partition: m[1]!, service: m[2]!, region: m[3]!, account: m[4]!, resource: m[5]!, raw };
}

export interface HandlerCtx {
  access: AwsAccess;
  runId: string;
  /** the region whose tagging index listed this resource */
  listedRegion: string;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** how long one resource may take to disappear (RDS can take ten minutes) */
  waitTimeoutMs: number;
  pollMs: number;
  log(message: string): void;
}

export type DeleteResult = "deleted" | "already_gone" | "covered_by_parent";

export interface Handler {
  /** e.g. `ecs:service` */
  id: string;
  /** deletion order: lower first */
  rank: number;
  /** null when the ARN is not this handler's; otherwise the name the name guard checks (when there is one) */
  match(arn: Arn): { name?: string } | null;
  /** `tags` are the CURRENT tags the cleaner just re-read; stateful handlers require this run's tag again before destroying data */
  remove(ctx: HandlerCtx, arn: Arn, tags: Readonly<Record<string, string>>): Promise<DeleteResult>;
}

/** The region a client for `arn` must use: the ARN's own when it has one, else the listing region. */
export const regionOf = (arn: Arn, ctx: HandlerCtx): string => (arn.region !== "" ? arn.region : ctx.listedRegion);

export function errorCodes(err: unknown): string[] {
  if (err === null || typeof err !== "object") return [];
  const e = err as { name?: unknown; Code?: unknown; code?: unknown; __type?: unknown };
  return [e.name, e.Code, e.code, e.__type].filter((v): v is string => typeof v === "string" && v !== "");
}

export function hasCode(err: unknown, ...wanted: string[]): boolean {
  const codes = errorCodes(err);
  return wanted.some((w) => codes.some((c) => c === w || c.endsWith(`#${w}`)));
}

/** "It is not there": deletion of something already gone is success. */
export function isNotFound(err: unknown): boolean {
  return errorCodes(err).some((c) => /NotFound|NonExistent|NoSuch|DoesNotExist|InvalidID|Invalid.*\.NotFound/i.test(c));
}

/** "Something still uses it": worth retrying after the dependent is gone. */
export function isInUse(err: unknown): boolean {
  return errorCodes(err).some((c) =>
    /^(?:DependencyViolation|ResourceInUse(?:Exception)?|InvalidGroup\.InUse|InvalidNetworkInterface\.InUse|InvalidIPAddress\.InUse|VolumeInUse|IncorrectState|InvalidState(?:Fault)?|InvalidDBInstanceState(?:Fault)?|InvalidDBClusterState(?:Fault)?|InvalidDBSubnetGroupState(?:Fault)?|InvalidCacheSubnetGroupState(?:Fault)?|InvalidReplicationGroupState(?:Fault)?|InvalidCacheClusterState(?:Fault)?|SubnetGroupInUse|BucketNotEmpty|ClusterContainsServices|ClusterContainsTasks|ServiceNotActiveException|UpdateInProgressException)$/.test(c.replace(/^.*#/, "")),
  );
}

export async function pollUntil(ctx: HandlerCtx, what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = ctx.now() + ctx.waitTimeoutMs;
  for (;;) {
    if (await done()) return;
    if (ctx.now() + ctx.pollMs > deadline) throw new Error(`Timed out waiting for ${what} to finish deleting.`);
    await ctx.sleep(ctx.pollMs);
  }
}

/** Run `fn`, retrying while the failure means "still in use". Not-found is success (`already_gone`). */
export async function retryInUse(ctx: HandlerCtx, what: string, fn: () => Promise<void>, attempts = 12): Promise<"deleted" | "already_gone"> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return "deleted";
    } catch (err) {
      if (isNotFound(err)) return "already_gone";
      if (!isInUse(err)) throw err;
      last = err;
      ctx.log(`${what} is still in use; waiting (attempt ${i + 1} of ${attempts}).`);
      await ctx.sleep(ctx.pollMs);
    }
  }
  throw last instanceof Error ? last : new Error(`${what} is still in use.`);
}

/** Last path segment of an ARN resource, e.g. `service/cluster/name` -> `name`. */
export const lastSegment = (resource: string): string => resource.slice(resource.lastIndexOf("/") + 1);
