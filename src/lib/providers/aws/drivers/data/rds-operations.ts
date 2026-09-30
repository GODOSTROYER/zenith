/**
 * Day-two operations of the RDS driver, keyed by capability name
 * (`src/lib/capabilities/catalog.ts`).
 *
 *   database.snapshot   low risk, implemented natively and IDEMPOTENT. The
 *                       snapshot identifier is derived from `ctx.operationId`,
 *                       so a retried or duplicated operation finds the snapshot
 *                       it already took and returns it instead of taking a
 *                       second one. Before acting, the target instance must
 *                       carry THIS node's Zenith tags (workspace, environment,
 *                       resource): a snapshot is never taken of an instance
 *                       Zenith does not own just because an id was supplied.
 *                       The fence token rides on the snapshot as a tag.
 *
 *   database.restore    REFUSED. Critical and destructive: a restore replaces or
 *   database.delete     duplicates stateful data, a delete destroys it. Both
 *                       must go through an infrastructure plan with approval
 *                       (`infrastructure.plan` → approval → `infrastructure.apply`),
 *                       where policy denies them in production. The handlers exist
 *                       only so the dispatcher returns a precise refusal rather
 *                       than "unknown operation"; they make no AWS call, and the
 *                       driver does NOT list them in `capabilities.operations`.
 *
 * Honest limit: exercised against a mocked SDK only (evidence `contract`).
 */
import { CreateDBSnapshotCommand, DescribeDBSnapshotsCommand, RDSClient, type DBSnapshot } from "@aws-sdk/client-rds";
import { createHash } from "node:crypto";
import type { NativeOperation, NativeOperationResult } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import { TAG_RESOURCE, toAwsTagList } from "./_shared";
import { rdsIdentifierOf, resolveInstance } from "./rds-read";
import { call, classifyAwsError, tagMap, tagsMatchNode, type AwsDriverContext } from "./support";

const requestIdOf = (out: { $metadata?: { requestId?: string } }): string[] => (out.$metadata?.requestId ? [out.$metadata.requestId] : []);

const fail = (summary: string, data?: Record<string, unknown>, requestIds: string[] = []): NativeOperationResult => ({
  ok: false,
  summary,
  ...(data ? { data } : {}),
  ...(requestIds.length ? { requestIds } : {}),
  simulated: false,
});

/** Tag values allow letters, digits, spaces and `_ . : / = + - @`; anything else is replaced. */
const tagValue = (s: string): string => s.replace(/[^\p{L}\p{N} _.:/=+@-]/gu, "_").slice(0, 256);

/**
 * `<instance-identifier>-zenith-<12 hex of sha256(operationId)>`: deterministic,
 * a valid snapshot id (starts with a letter, no doubled hyphens, ≤ 255), and
 * distinct per operation.
 */
export function snapshotIdentifierFor(instanceIdentifier: string, operationId: string): string {
  const tail = createHash("sha256").update(`database.snapshot\0${operationId}`).digest("hex").slice(0, 12);
  return `${instanceIdentifier.slice(0, 230)}-zenith-${tail}`;
}

async function findSnapshot(ctx: AwsDriverContext, snapshotIdentifier: string): Promise<{ snapshot?: DBSnapshot; requestIds: string[] }> {
  const rds = ctx.session.client(RDSClient);
  try {
    const out = await call(ctx, (o) => rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotIdentifier }), o));
    return { snapshot: out.DBSnapshots?.[0], requestIds: requestIdOf(out) };
  } catch (err) {
    if (classifyAwsError(err, ctx.signal).kind === "missing") return { requestIds: [] };
    throw err;
  }
}

const snapshotData = (s: DBSnapshot, created: boolean): Record<string, unknown> => ({
  snapshotIdentifier: s.DBSnapshotIdentifier,
  snapshotArn: s.DBSnapshotArn,
  instanceIdentifier: s.DBInstanceIdentifier,
  status: s.Status,
  engine: s.Engine,
  created,
});

const snapshot: NativeOperation<AwsSession> = async (ctx, node, input) => {
  if (!ctx.operationId) {
    return fail("database.snapshot needs an operation id: the snapshot id is derived from it so a retry is idempotent.");
  }
  try {
    const externalId = typeof input.externalId === "string" ? input.externalId : undefined;
    if (externalId !== undefined && rdsIdentifierOf(externalId) === undefined) return fail("externalId is not an RDS instance ARN or identifier.");
    const instance = await resolveInstance(ctx, node, externalId);
    if (instance === "missing") return fail(`No RDS instance was found for ${node.address}.`);
    if ("ambiguous" in instance) return fail(`Refusing to snapshot: ${instance.ambiguous}.`);
    const instanceId = instance.DBInstanceIdentifier;
    if (!instanceId) return fail("The provider returned an instance without an identifier.");

    // Re-check ownership: the instance must be tagged for THIS node in THIS environment.
    if (!tagsMatchNode(tagMap(instance.TagList), ctx, node)) {
      return fail(`Refusing to snapshot ${instanceId}: it does not carry the Zenith tags for ${node.address} in this environment.`);
    }

    const snapshotId = snapshotIdentifierFor(instanceId, ctx.operationId);
    const existing = await findSnapshot(ctx, snapshotId);
    if (existing.snapshot) {
      if (existing.snapshot.DBInstanceIdentifier !== instanceId) {
        return fail(`Snapshot ${snapshotId} already exists for a different instance; refusing to reuse it.`, undefined, existing.requestIds);
      }
      return { ok: true, summary: `Snapshot ${snapshotId} already exists (status ${existing.snapshot.Status ?? "unknown"}); nothing more to do.`, data: snapshotData(existing.snapshot, false), requestIds: existing.requestIds, simulated: false };
    }

    const tags: Record<string, string> = {
      ...ctx.tags,
      [TAG_RESOURCE]: node.address,
      "zenith:operation": tagValue(ctx.operationId),
      ...(ctx.fence ? { "zenith:fence": tagValue(`${ctx.fence.scope}:${ctx.fence.token}`) } : {}),
    };
    const rds = ctx.session.client(RDSClient);
    try {
      const out = await call(ctx, (o) =>
        rds.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: instanceId, DBSnapshotIdentifier: snapshotId, Tags: toAwsTagList(tags) }), o)
      );
      if (!out.DBSnapshot) return fail("The provider accepted the snapshot request but returned no snapshot.", undefined, requestIdOf(out));
      return { ok: true, summary: `Snapshot ${snapshotId} of ${instanceId} started (status ${out.DBSnapshot.Status ?? "creating"}).`, data: snapshotData(out.DBSnapshot, true), requestIds: requestIdOf(out), simulated: false };
    } catch (err) {
      // A concurrent duplicate of this same operation got there first: that is success, not failure.
      if (classifyAwsError(err, ctx.signal).code === "DBSnapshotAlreadyExistsFault") {
        const again = await findSnapshot(ctx, snapshotId);
        if (again.snapshot && again.snapshot.DBInstanceIdentifier === instanceId) {
          return { ok: true, summary: `Snapshot ${snapshotId} already exists (status ${again.snapshot.Status ?? "unknown"}); nothing more to do.`, data: snapshotData(again.snapshot, false), requestIds: again.requestIds, simulated: false };
        }
      }
      throw err;
    }
  } catch (err) {
    const failure = classifyAwsError(err, ctx.signal);
    if (failure.kind === "aborted") throw err;
    return fail(`database.snapshot failed: ${failure.summary}`, { failure: failure.kind, code: failure.code }, failure.requestId ? [failure.requestId] : []);
  }
};

const refuse =
  (capability: "database.restore" | "database.delete"): NativeOperation<AwsSession> =>
  async () =>
    fail(`${capability} is critical and destructive, so it is not executed as a day-two operation: it must go through an infrastructure plan and approval (plan, review the destroyed or replaced data, approve, apply). Policy denies it in production.`, {
      refusedCapability: capability,
      route: "infrastructure.plan → approval → infrastructure.apply",
    });

export const rdsOperations: Record<string, NativeOperation<AwsSession>> = {
  "database.snapshot": snapshot,
  "database.restore": refuse("database.restore"),
  "database.delete": refuse("database.delete"),
};
