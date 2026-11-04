/**
 * Live-run cleanup through the shared destroy engine. Every refreshed deletion
 * must carry this run's tag or be an allowlisted untagged child. The same guard
 * runs on the fresh digest-bound plan used for apply. Stateful policies are
 * allowed only after tag ownership is proved. Unmapped DNS is refused: the
 * tag sweeper remains the last resort. Local tofu is tested; AWS is not live verified.
 */
import { stat } from "node:fs/promises";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { planDestroy, applyVerifiedPlan } from "@/lib/tofu/engine";
import { TofuRunner } from "@/lib/tofu/runner";
import type { HostEnv } from "@/lib/tofu/env";
import { TofuDeletionRefusedError, type ShowJson } from "@/lib/tofu/plan";
import { assembleWorkspace, type BackendConfig } from "@/lib/tofu/workspace";
import type { ProviderSetName } from "@/lib/tofu/providers";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { TAG_LIVE_RUN, assertRunId, liveRunTags } from "./safety";
import { isNotFound } from "./cleanup-util";
import type { AwsAccess } from "./types";

/** Untagged children hold no independent data; ownership still needs the run state. */
export const UNTAGGED_CHILD_TYPES: ReadonlySet<string> = new Set([
  "aws_route",
  "aws_route_table_association",
  "aws_main_route_table_association",
  "aws_security_group_rule",
  "aws_iam_role_policy",
  "aws_iam_role_policy_attachment",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_policy",
  "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_ownership_controls",
  "aws_lb_target_group_attachment",
  "aws_eip_association",
  "aws_ecs_cluster_capacity_providers",
  "aws_acm_certificate_validation",
  "aws_route53_record",
  "aws_cloudwatch_log_stream",
  "random_id",
  "random_password",
  "random_string",
  "random_pet",
  "random_integer",
  "terraform_data",
]);

export interface DestroyCheck {
  ok: boolean;
  deletes: { address: string; type: string }[];
  refused: { address: string; type: string; reason: string }[];
}

type ShowChanges = NonNullable<ShowJson["resource_changes"]>;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Pure: may this destroy plan be applied? Every managed resource it touches
 * must be deleted AND provably this run's (see the module comment).
 */
export function verifyDestroyPlan(show: ShowJson, runId: string, untaggedTypes: ReadonlySet<string> = UNTAGGED_CHILD_TYPES): DestroyCheck {
  assertRunId(runId);
  const out: DestroyCheck = { ok: true, deletes: [], refused: [] };
  const refuse = (address: string, type: string, reason: string) => {
    out.ok = false;
    out.refused.push({ address, type, reason });
  };
  if (show.errored === true) refuse("(plan)", "plan", "the plan is marked errored");
  for (const rc of (show.resource_changes ?? []) as ShowChanges) {
    const address = rc.address ?? "(unknown)";
    const type = rc.type ?? "(unknown)";
    if (rc.mode !== undefined && rc.mode !== "managed") continue; // data sources read, never delete
    const actions = rc.change?.actions ?? [];
    if (actions.length === 1 && actions[0] === "no-op") continue;
    if (actions.length !== 1 || actions[0] !== "delete") {
      refuse(address, type, `the destroy plan would ${actions.join("+") || "do something unknown to"} it instead of deleting it`);
      continue;
    }
    const before = rc.change?.before;
    if (!isObject(before)) {
      refuse(address, type, "the plan has no prior state for it, so its tags cannot be checked");
      continue;
    }
    const tagged = "tags_all" in before || "tags" in before;
    if (!tagged) {
      if (untaggedTypes.has(type)) out.deletes.push({ address, type });
      else refuse(address, type, "it has no tags attribute and is not a known untagged child type");
      continue;
    }
    const tags = [before.tags_all, before.tags].find(isObject);
    const value = tags?.[TAG_LIVE_RUN];
    if (value === runId) out.deletes.push({ address, type });
    else refuse(address, type, value === undefined ? `it is not tagged ${TAG_LIVE_RUN}` : "its run tag does not match this run");
  }
  return out;
}

export interface DestroyInput {
  access: AwsAccess;
  runId: string;
  workspaceId: string;
  environmentId: string;
  region: string;
  /** S3 backend bucket; ignored when `backend` is given */
  stateBucket: string;
  stateKmsKeyArn?: string;
  /** state object key override; default `zenith/<workspace>/<environment>/terraform.tfstate` */
  stateKey?: string;
  dryRun: boolean;
  /** tests: a different backend (local) and provider set (builtin) */
  backend?: BackendConfig;
  providerSet?: ProviderSetName;
  /** tests: state-exists probe override */
  stateExists?: () => Promise<boolean>;
  hostEnv?: HostEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** tests: skip the session credentials (local backend, no cloud) */
  noCredentials?: boolean;
}

export type DestroyStatus = "no_state" | "planned" | "destroyed" | "nothing_to_destroy" | "refused" | "failed";

export interface DestroyResult {
  status: DestroyStatus;
  detail: string;
  deletes: { address: string; type: string }[];
  refused: { address: string; type: string; reason: string }[];
}

const emptyGraph = (environmentId: string): ResourceGraph => ({ version: 1, environmentId, manifestDigest: "destroy", nodes: [], edges: [], graphDigest: "destroy", notes: [] });

export const stateKeyFor = (workspaceId: string, environmentId: string): string => `zenith/${workspaceId}/${environmentId}/terraform.tfstate`;

async function stateObjectExists(input: DestroyInput, backend: BackendConfig, key: string): Promise<boolean> {
  if (input.stateExists) return input.stateExists();
  if (backend.kind === "local") {
    try {
      return (await stat(backend.path ?? "")).isFile();
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err; // unreadable state is unknown, never "no state"
    }
  }
  if (backend.kind !== "s3") throw new Error("The cleanup state probe does not support this backend.");
  const s3 = input.access.client(S3Client, { region: backend.region ?? input.region });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: backend.bucket, Key: key }));
    return true;
  } catch (err) {
    if (isNotFound(err) || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

/**
 * Plan (and, unless `dryRun`, apply) a destroy of the run's OpenTofu state.
 * Never throws for an expected refusal or a tofu failure: those are results.
 */
export async function destroyRunWorkspace(input: DestroyInput): Promise<DestroyResult> {
  assertRunId(input.runId);
  const key = input.stateKey ?? stateKeyFor(input.workspaceId, input.environmentId);
  const backend: BackendConfig = input.backend ?? { kind: "s3", bucket: input.stateBucket, region: input.region, ...(input.stateKmsKeyArn ? { encryptionKmsKeyArn: input.stateKmsKeyArn } : {}) };
  const fail = (detail: string, extra: Partial<DestroyResult> = {}): DestroyResult => ({ status: "failed", detail, deletes: [], refused: [], ...extra });

  let exists: boolean;
  try {
    exists = await stateObjectExists(input, backend, key);
  } catch (err) {
    return fail(`Could not look for the state object (${err instanceof Error ? err.name : "error"}).`);
  }
  if (!exists) return { status: "no_state", detail: backend.kind === "s3" ? `No state object at s3://${backend.bucket}/${key}.` : "No state file.", deletes: [], refused: [] };

  const ws = assembleWorkspace({
    graph: emptyGraph(input.environmentId), fragments: new Map(),
    providerSet: input.providerSet ?? "aws", region: input.region, backend,
    ...(backend.kind === "s3" ? { stateKey: key } : {}), tags: liveRunTags(input.runId),
  });
  const runner = new TofuRunner({ hostEnv: input.hostEnv, limits: { timeoutMs: input.timeoutMs ?? 45 * 60_000 } });
  const nodes: ResourceNode[] = [];
  let check: DestroyCheck = { ok: true, deletes: [], refused: [] };
  try {
    const sessionEnv = input.noCredentials ? {} : await input.access.childProcessEnv();
    const session = { provider: "aws" as const, childProcessEnv: () => sessionEnv };
    const inspectPlan = (_plan: unknown, raw: ShowJson): void => {
      check = verifyDestroyPlan(raw, input.runId);
      // State alone has no logical target graph for assessRecordDeletion.
      // Refuse DNS here; the existing sweeper checks the recorded DNS target.
      for (const item of check.deletes.filter((c) => c.type === "aws_route53_record")) {
        check.ok = false;
        check.refused.push({ ...item, reason: "DNS target ownership needs the deployed graph; use the guarded record sweeper." });
      }
      if (!check.ok) throw new TofuDeletionRefusedError("The destroy plan is not provably owned by this run.");
      nodes.splice(0, nodes.length, ...check.deletes.map((item): ResourceNode => ({
        address: item.address, kind: "provider_native", provider: "aws", region: input.region,
        nativeType: item.type, ownership: "managed", spec: { deletionPolicy: "allow" },
        specDigest: "destroy", labels: {}, origin: [], dependsOn: [],
      })));
    };
    const options = { runner, signal: input.signal, deletionNodes: nodes, inspectPlan };
    const planned = await planDestroy(ws, session, options);
    if (planned.plan.empty) return { status: "nothing_to_destroy", detail: "The state holds no resources.", deletes: [], refused: [] };
    if (input.dryRun) return { status: "planned", detail: `Dry run: ${check.deletes.length} deletion(s) owned by this run.`, deletes: check.deletes, refused: [] };
    await applyVerifiedPlan(ws, { ...options, destroy: true, session, approvedDigest: planned.plan.planDigest });
    return { status: "destroyed", detail: `OpenTofu applied ${check.deletes.length} deletion(s); cloud absence is not independently verified.`, deletes: check.deletes, refused: [] };
  } catch (err) {
    if (err instanceof TofuDeletionRefusedError) return { status: "refused", detail: "The destroy ownership guard refused deletion. Nothing was applied.", deletes: check.deletes, refused: check.refused };
    return fail(`The destroy did not complete (${err instanceof Error ? err.name : "error"}); outcome may be partial.`, { deletes: check.deletes });
  }
}
