/**
 * `tofu destroy` of a live run's workspace, with a tag check on the PLAN.
 *
 * Why this lives in the harness: the merged tofu engine (`src/lib/tofu`) plans
 * and applies but has no destroy command (reported in the handoff as a contract
 * request). This module reuses the engine's pieces — binary resolution and
 * version pin, the allowlisted child environment, the bounded process runner,
 * the pinned provider lockfiles and the workspace assembler — and adds only the
 * destroy sequence.
 *
 * What it destroys: whatever the run's OpenTofu STATE holds. The workspace is
 * assembled with NO resources — only the pinned providers, the region and the
 * state backend (`zenith/<workspace>/<environment>/terraform.tfstate` in the
 * sandbox account's state bucket) — so `plan -destroy` proposes deleting every
 * resource recorded in that state.
 *
 * The safety check that makes that acceptable: before anything is applied the
 * destroy plan is read (`tofu show -json`) and EVERY resource it would delete
 * must be provably this run's — its refreshed `tags_all`/`tags` carry
 * `zenith:live-run=<runId>` — or be a child type that has no tags at all and is
 * on a short allowlist (route table associations, IAM policy attachments, S3
 * bucket sub-resources, DNS records, local-only `random_*`/`terraform_data`). A
 * resource that has tags but not this run's tag, an unknown untagged type, or
 * any action other than delete refuses the whole destroy and applies nothing.
 * Nothing is applied in a dry run.
 *
 * Refresh: `plan -destroy` refreshes the state first, so `before` holds the
 * resource's CURRENT tags. That is what lets tags added out-of-band by
 * `adopt.ts` count.
 *
 * Verified by a real `tofu` run against a local backend and the built-in
 * `terraform_data` resource (tests/acceptance); the AWS path has never been run
 * against an account.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { checkTofuVersion, resolveTofuBinary } from "@/lib/tofu/binary";
import { buildChildEnv, type HostEnv } from "@/lib/tofu/env";
import { parseShowJson, type ShowJson } from "@/lib/tofu/plan";
import { redactOutput, secretValuesOf } from "@/lib/tofu/redact";
import { runProcess } from "@/lib/tofu/process";
import { assembleWorkspace, type BackendConfig } from "@/lib/tofu/workspace";
import type { ProviderSetName } from "@/lib/tofu/providers";
import { LOCKFILE_NAME } from "@/lib/tofu/config-digest";
import type { ResourceGraph } from "@/lib/resources/types";
import { TAG_LIVE_RUN, assertRunId, liveRunTags } from "./safety";
import { isNotFound } from "./cleanup-util";
import type { AwsAccess } from "./types";

/** Resource types that carry no tags and no data of their own: children of a tagged resource, or local-only. */
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
    else refuse(address, type, value === undefined ? `it is not tagged ${TAG_LIVE_RUN}` : `it is tagged ${TAG_LIVE_RUN}=${String(value).slice(0, 40)}, another run`);
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
    } catch {
      return false;
    }
  }
  if (backend.kind !== "s3") return false;
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

  const hostEnv = input.hostEnv ?? process.env;
  let bin: string;
  try {
    bin = resolveTofuBinary(hostEnv);
    await checkTofuVersion(bin);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "OpenTofu is not available.");
  }

  const ws = assembleWorkspace({
    graph: emptyGraph(input.environmentId),
    fragments: new Map(),
    providerSet: input.providerSet ?? "aws",
    region: input.region,
    backend,
    ...(backend.kind === "s3" ? { stateKey: key } : {}),
    tags: liveRunTags(input.runId),
  });

  const root = await mkdtemp(path.join(os.tmpdir(), "zenith-live-destroy-"));
  try {
    const work = path.join(root, "work");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    const cache = hostEnv.ZENITH_TOFU_PLUGIN_CACHE ?? path.join(os.tmpdir(), "zenith-tofu-plugin-cache");
    for (const d of [work, home, tmp, cache]) await mkdir(d, { recursive: true });
    const cli = path.join(root, "tofu.rc");
    await writeFile(cli, "# generated: registry + shared plugin cache only\n", { mode: 0o600 });
    for (const f of ws.files) {
      const target = path.join(work, ...f.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.content, { mode: 0o600 });
    }
    await writeFile(path.join(work, LOCKFILE_NAME), ws.lockfile, { mode: 0o600 });

    const sessionEnv = input.noCredentials ? {} : await input.access.childProcessEnv();
    const secrets = secretValuesOf(sessionEnv);
    const env = buildChildEnv({ homeDir: home, tmpDir: tmp, cliConfigFile: cli, pluginCacheDir: cache, sessionEnv, hostEnv });
    const limits = { timeoutMs: input.timeoutMs ?? 45 * 60_000, maxOutputBytes: 1024 * 1024 };
    const tofu = (args: string[], capture = 0) =>
      runProcess({ file: bin, args, cwd: work, env, signal: input.signal, ...limits, ...(capture > 0 ? { captureStdoutBytes: capture } : {}) });
    const say = (r: { output: string }) => redactOutput(r.output, secrets).slice(-600);

    const init = await tofu(["init", "-input=false", "-no-color", "-lockfile=readonly"]);
    if (init.exitCode !== 0) return fail(`tofu init failed: ${say(init)}`);
    const plan = await tofu(["plan", "-destroy", "-out=tfplan", "-input=false", "-detailed-exitcode", "-lock-timeout=60s", "-no-color"]);
    if (plan.exitCode === 0) return { status: "nothing_to_destroy", detail: "The state holds no resources.", deletes: [], refused: [] };
    if (plan.exitCode !== 2) return fail(`tofu plan -destroy failed: ${say(plan)}`);
    const shown = await tofu(["show", "-json", "-no-color", "tfplan"], 64 * 1024 * 1024);
    if (shown.exitCode !== 0 || shown.stdoutOverflow) return fail(`tofu show failed: ${say(shown)}`);
    const check = verifyDestroyPlan(parseShowJson(shown.stdout ?? ""), input.runId);
    if (!check.ok) {
      return { status: "refused", detail: `Refusing to apply: ${check.refused.length} resource(s) in the destroy plan are not provably this run's (${check.refused[0]!.address}: ${check.refused[0]!.reason}). Nothing was deleted.`, deletes: check.deletes, refused: check.refused };
    }
    if (input.dryRun) return { status: "planned", detail: `Dry run: the destroy plan would delete ${check.deletes.length} resource(s), all tagged for this run.`, deletes: check.deletes, refused: [] };
    const apply = await tofu(["apply", "-input=false", "-lock-timeout=60s", "-no-color", "tfplan"]);
    if (apply.exitCode !== 0) return fail(`tofu apply of the destroy plan failed: ${say(apply)}`, { deletes: check.deletes });
    return { status: "destroyed", detail: `Destroyed ${check.deletes.length} resource(s) through OpenTofu.`, deletes: check.deletes, refused: [] };
  } catch (err) {
    return fail(`The destroy did not complete (${err instanceof Error ? err.name : "error"}): ${err instanceof Error ? redactOutput(err.message).slice(0, 300) : ""}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
