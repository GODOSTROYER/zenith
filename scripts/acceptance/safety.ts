/**
 * Live-run safety rails. Every live acceptance run passes through this module
 * BEFORE its first cloud call, and every mutation and deletion the harness makes
 * is checked against it.
 *
 * The threat is not a clever attacker; it is a tired operator with the wrong
 * AWS profile exported. So the gates are deliberately blunt and fail closed:
 *
 *   1. `ZENITH_LIVE_AWS_ACCOUNT_ID` is set, well formed, and equals the account
 *      `sts:GetCallerIdentity` reports for the credentials in use. A profile
 *      for any other account is refused, however it got there.
 *   2. That account carries the operator's one-time opt-in marker: the SSM
 *      parameter `/zenith/live-sandbox` with the value `true`. Nobody creates
 *      it by accident; creating it says "this account is a disposable sandbox".
 *      (The marker is read with the operator's own profile. Zenith's observe
 *      role is explicitly denied `ssm:GetParameter*`, so this gate can never be
 *      satisfied through Zenith, only by the human who owns the account.)
 *   3. The region is explicit (no default) and in the allowlist.
 *   4. Anything that mutates needs `--confirm-billable`; without it the run is a
 *      dry run that makes no cloud call at all.
 *   5. A cost estimate above `ZENITH_LIVE_MAX_MONTHLY_USD` (default 50) is
 *      refused; an estimate that could not be computed is refused too.
 *   6. Everything a run creates is named `zenith-<runId>-…`, tagged
 *      `zenith:live-run=<runId>`, and only resources carrying that tag are ever
 *      mutated or deleted by the harness.
 *
 * Gates 1 and 2 are the only cloud calls made before the run is established,
 * and both are read-only. `establishLiveSession` is the only way to obtain a
 * `LiveSession`, and a `LiveSession` is the only way to obtain an `AwsAccess`
 * for the run.
 *
 * Honest limit: these gates stop the wrong account, the wrong region, the
 * unconfirmed run and the untagged deletion. They do not stop an operator who
 * puts the marker in a production account, nor a mislabeled resource: a
 * resource that wrongly carries this run's tag would be deleted by this run's
 * cleanup.
 */
import { randomBytes } from "node:crypto";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { TAG_ENVIRONMENT, TAG_MANAGED } from "@/lib/credentials/aws/naming";
import { DEFAULT_MAX_MONTHLY_USD, type LiveConfig } from "./config";
import type { AwsAccess } from "./types";

export const LIVE_SANDBOX_PARAMETER = "/zenith/live-sandbox";
export const TAG_LIVE_RUN = "zenith:live-run";

/** `zlive-<yyyymmddhhmm UTC>-<4 chars>`. The timestamp is what `--older-than` ages by. */
export const RUN_ID_PATTERN = /^zlive-\d{12}-[a-z0-9]{4}$/;

export type SafetyCode =
  | "account_unset"
  | "account_malformed"
  | "account_mismatch"
  | "identity_unavailable"
  | "marker_missing"
  | "marker_unreadable"
  | "marker_not_true"
  | "region_unset"
  | "region_not_allowed"
  | "confirm_required"
  | "budget_invalid"
  | "cost_unknown"
  | "cost_exceeds_budget"
  | "run_id_invalid"
  | "not_run_tagged"
  | "tag_unverifiable"
  | "not_established";

export class LiveSafetyError extends Error {
  readonly code: SafetyCode;
  constructor(code: SafetyCode, message: string) {
    super(message);
    this.name = "LiveSafetyError";
    this.code = code;
  }
}

/* --------------------------------- run ids --------------------------------- */

const RAND_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

/** A fresh run id. `random` is injectable for tests; it must return at least 4 bytes. */
export function newRunId(now: Date = new Date(), random: (n: number) => Uint8Array = randomBytes): string {
  if (!Number.isFinite(now.getTime())) throw new LiveSafetyError("run_id_invalid", "A run needs a valid UTC timestamp.");
  const bytes = random(4);
  if (bytes.length < 4) throw new LiveSafetyError("run_id_invalid", "A run id needs four random bytes.");
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += RAND_ALPHABET[bytes[i]! % RAND_ALPHABET.length];
  return assertRunId(`zlive-${stamp(now)}-${suffix}`);
}

/** The creation time encoded in a run id, or null when `id` is not a run id. */
export function runIdTime(id: string): Date | null {
  if (!RUN_ID_PATTERN.test(id)) return null;
  const m = /^zlive-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(id)!;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const d = new Date(t);
  // Date.UTC rolls 13/45 over; a run id that does not round-trip is not one of ours.
  return stamp(d) === `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}` ? d : null;
}

export function assertRunId(id: string): string {
  if (runIdTime(id) === null) throw new LiveSafetyError("run_id_invalid", `"${id.slice(0, 60)}" is not a live-run id (zlive-<yyyymmddhhmm>-<4 chars>).`);
  return id;
}

/* -------------------------------- naming/tags ------------------------------- */

/**
 * Tags on everything a live run creates. `zenith:managed` and
 * `zenith:environment` are the bootstrap role's contract (deploy/aws); the
 * `zenith:live-run` tag is this harness's deletion boundary.
 */
export function liveRunTags(runId: string): Record<string, string> {
  assertRunId(runId);
  return { [TAG_MANAGED]: "true", [TAG_ENVIRONMENT]: runId, [TAG_LIVE_RUN]: runId };
}

/** `zenith-<runId>-<suffix>`: the name convention the deploy role's name patterns accept. */
export function liveRunName(runId: string, suffix: string): string {
  assertRunId(runId);
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(suffix)) throw new LiveSafetyError("run_id_invalid", `A resource name suffix must be lowercase letters, digits and dashes (got "${suffix.slice(0, 40)}").`);
  return `zenith-${runId}-${suffix}`;
}

/**
 * Refuse unless `tags` carries THIS run's tag. The one rule every mutation and
 * deletion the harness makes goes through.
 */
export function assertRunTagged(tags: Record<string, string> | undefined, runId: string, what: string): void {
  assertRunId(runId);
  const actual = tags?.[TAG_LIVE_RUN];
  if (actual !== runId) {
    throw new LiveSafetyError(
      "not_run_tagged",
      actual === undefined
        ? `${what} does not carry the ${TAG_LIVE_RUN} tag; the harness only changes resources of this run (${runId}).`
        : `${what} carries ${TAG_LIVE_RUN}=${actual.slice(0, 40)}, not this run (${runId}); refusing.`,
    );
  }
}

/* ------------------------------ static (no cloud) ---------------------------- */

export interface LiveTarget {
  accountId: string;
  region: string;
  allowedRegions: readonly string[];
  maxMonthlyUsd: number;
}

/**
 * Gates 1 (syntax), 3 and the budget setting. No cloud call. `region` is the
 * CLI's `--region`, already folded into the config by `loadLiveConfig`.
 */
export function resolveLiveTarget(config: LiveConfig): LiveTarget {
  if (config.awsAccountId === undefined) {
    throw new LiveSafetyError("account_unset", "ZENITH_LIVE_AWS_ACCOUNT_ID is not set. Live runs only touch the one sandbox account named there.");
  }
  if (!/^\d{12}$/.test(config.awsAccountId)) throw new LiveSafetyError("account_malformed", "ZENITH_LIVE_AWS_ACCOUNT_ID must be a 12-digit account id.");
  if (config.region === undefined) {
    throw new LiveSafetyError("region_unset", "No region: set ZENITH_LIVE_REGION or pass --region. There is deliberately no default.");
  }
  if (!config.allowedRegions.includes(config.region)) {
    throw new LiveSafetyError("region_not_allowed", `Region ${config.region} is not in the live-run allowlist (${config.allowedRegions.join(", ")}). Widen it with ZENITH_LIVE_ALLOWED_REGIONS if that is deliberate.`);
  }
  if (!Number.isFinite(config.maxMonthlyUsd) || config.maxMonthlyUsd <= 0) {
    throw new LiveSafetyError("budget_invalid", `ZENITH_LIVE_MAX_MONTHLY_USD must be a positive number (default ${DEFAULT_MAX_MONTHLY_USD}).`);
  }
  return { accountId: config.awsAccountId, region: config.region, allowedRegions: config.allowedRegions, maxMonthlyUsd: config.maxMonthlyUsd };
}

/** Gate 4: a mutating run needs `--confirm-billable`. */
export function assertBillableConfirmed(input: { mutating: boolean; confirmBillable: boolean }): void {
  if (input.mutating && !input.confirmBillable) {
    throw new LiveSafetyError(
      "confirm_required",
      "This scenario creates or changes billable cloud resources. Re-run with --confirm-billable, or use --dry-run to see exactly what it would do.",
    );
  }
}

/** Gate 5: refuse an estimate over the budget, and refuse one that is missing. */
export function assertWithinBudget(estimateUsdMonthly: number | undefined, maxUsdMonthly: number, label = "The plan"): void {
  if (estimateUsdMonthly === undefined || !Number.isFinite(estimateUsdMonthly) || estimateUsdMonthly < 0) {
    throw new LiveSafetyError("cost_unknown", `${label} has no usable cost estimate, so it cannot be checked against the ${fmtUsd(maxUsdMonthly)}/month limit; refusing.`);
  }
  if (estimateUsdMonthly > maxUsdMonthly) {
    throw new LiveSafetyError(
      "cost_exceeds_budget",
      `${label} is estimated at ${fmtUsd(estimateUsdMonthly)}/month, above the ${fmtUsd(maxUsdMonthly)}/month limit (ZENITH_LIVE_MAX_MONTHLY_USD). Estimates are list prices, not invoices.`,
    );
  }
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

/* ----------------------------- account verification -------------------------- */

/** The two read-only calls gates 1 and 2 need. Implemented with the SDK below; fakeable in tests. */
export interface AccountProbe {
  callerAccount(): Promise<{ account: string; arn?: string }>;
  /** the marker parameter's value, or `undefined` when the parameter does not exist */
  liveMarker(): Promise<string | undefined>;
}

export function sdkAccountProbe(clients: { sts: STSClient; ssm: SSMClient }): AccountProbe {
  return {
    async callerAccount() {
      const out = await clients.sts.send(new GetCallerIdentityCommand({}));
      if (!out.Account) throw new Error("sts:GetCallerIdentity returned no account");
      return { account: out.Account, arn: out.Arn };
    },
    async liveMarker() {
      try {
        const out = await clients.ssm.send(new GetParameterCommand({ Name: LIVE_SANDBOX_PARAMETER, WithDecryption: false }));
        return out.Parameter?.Value ?? "";
      } catch (err) {
        if (err instanceof Error && err.name === "ParameterNotFound") return undefined;
        throw err;
      }
    },
  };
}

/** Gates 1 (identity) and 2 (marker). Two read-only cloud calls; throws `LiveSafetyError`. */
export async function verifyLiveAccount(probe: AccountProbe, target: LiveTarget): Promise<{ arn?: string }> {
  let identity: { account: string; arn?: string };
  try {
    identity = await probe.callerAccount();
  } catch (err) {
    throw new LiveSafetyError("identity_unavailable", `Could not determine which AWS account the credentials belong to (${errName(err)}); refusing to continue.`);
  }
  if (identity.account !== target.accountId) {
    throw new LiveSafetyError(
      "account_mismatch",
      `The credentials in use belong to account ${identity.account}, but ZENITH_LIVE_AWS_ACCOUNT_ID is ${target.accountId}. Check the profile or environment you exported. Nothing was changed.`,
    );
  }
  let marker: string | undefined;
  try {
    marker = await probe.liveMarker();
  } catch (err) {
    throw new LiveSafetyError(
      "marker_unreadable",
      `Could not read the opt-in marker ${LIVE_SANDBOX_PARAMETER} (${errName(err)}). The marker is read with the operator's own profile, which needs ssm:GetParameter on it.`,
    );
  }
  if (marker === undefined) {
    throw new LiveSafetyError(
      "marker_missing",
      `Account ${target.accountId} has no ${LIVE_SANDBOX_PARAMETER} parameter, so it has not been declared a live-test sandbox. If it is one, the owner records that once with: aws ssm put-parameter --name ${LIVE_SANDBOX_PARAMETER} --type String --value true`,
    );
  }
  if (marker !== "true") {
    throw new LiveSafetyError("marker_not_true", `${LIVE_SANDBOX_PARAMETER} exists but its value is not exactly "true"; refusing.`);
  }
  return { arn: identity.arn };
}

function errName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : "Error";
}

/* ----------------------------- tag verification ------------------------------ */

export type TaggedLookup = { listed: false } | { listed: true; tags: Record<string, string> };

/**
 * The CURRENT tags of one resource, from the tagging API. `listed: false` means
 * the tag index does not know the resource: deleted, never tagged, or not yet
 * indexed. Callers that delete treat that as "skip"; callers that mutate treat
 * it as "refuse" (`assertTaggedForRun`).
 */
export async function lookupTags(tagging: ResourceGroupsTaggingAPIClient, arn: string): Promise<TaggedLookup> {
  const out = await tagging.send(new GetResourcesCommand({ ResourceARNList: [arn] }));
  const hit = out.ResourceTagMappingList?.find((r) => r.ResourceARN === arn);
  if (!hit) return { listed: false };
  const tags: Record<string, string> = {};
  for (const t of hit.Tags ?? []) if (t.Key !== undefined) tags[t.Key] = t.Value ?? "";
  return { listed: true, tags };
}

/** Fetch the resource's tags now and require this run's tag. Used before any harness-originated mutation. */
export async function assertTaggedForRun(tagging: ResourceGroupsTaggingAPIClient, arn: string, runId: string): Promise<Record<string, string>> {
  const found = await lookupTags(tagging, arn);
  if (!found.listed) {
    throw new LiveSafetyError("tag_unverifiable", `${arn} is not in the tagging index, so its tags cannot be verified; refusing to change it.`);
  }
  assertRunTagged(found.tags, runId, arn);
  return found.tags;
}

/* ---------------------------------- session ---------------------------------- */

export interface EstablishInput {
  config: LiveConfig;
  /** the credentials the run will use; ambient or brokered */
  access: AwsAccess;
  /** default: derived from `access` with the SDK */
  probe?: AccountProbe;
  confirmBillable: boolean;
  /** scenarios that will run; `mutating` is true when any of them mutates */
  mutating: boolean;
  runId?: string;
  now?: () => Date;
}

/**
 * The established, verified run. Only `establishLiveSession` creates one. It
 * carries the run identity, the budget and the confirmation, and it is the
 * single source of run tags and names.
 */
export class LiveSession {
  readonly runId: string;
  readonly accountId: string;
  readonly region: string;
  readonly maxMonthlyUsd: number;
  readonly confirmedBillable: boolean;
  readonly mutating: boolean;
  readonly callerArn?: string;
  readonly #access: AwsAccess;
  #costCheckedUsd: number | undefined;

  /** @internal use `establishLiveSession` */
  constructor(input: { runId: string; target: LiveTarget; access: AwsAccess; confirmedBillable: boolean; mutating: boolean; callerArn?: string }) {
    this.runId = input.runId;
    this.accountId = input.target.accountId;
    this.region = input.target.region;
    this.maxMonthlyUsd = input.target.maxMonthlyUsd;
    this.confirmedBillable = input.confirmedBillable;
    this.mutating = input.mutating;
    this.callerArn = input.callerArn;
    this.#access = input.access;
  }

  /** The AWS access of this (verified) run. */
  aws(): AwsAccess {
    return this.#access;
  }

  tags(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...liveRunTags(this.runId) };
  }

  name(suffix: string): string {
    return liveRunName(this.runId, suffix);
  }

  /** Gate 5. Records the highest estimate accepted; throws when over budget or unknown. */
  checkCost(estimateUsdMonthly: number | undefined, label?: string): void {
    assertWithinBudget(estimateUsdMonthly, this.maxMonthlyUsd, label);
    this.#costCheckedUsd = Math.max(this.#costCheckedUsd ?? 0, estimateUsdMonthly!);
  }

  get costCheckedUsd(): number | undefined {
    return this.#costCheckedUsd;
  }

  /**
   * Called by the scenario runner before any step that changes a cloud or the
   * control plane. Requires the billable confirmation and, for scenarios that
   * create resources, an accepted cost estimate.
   */
  assertMutationAllowed(what: string, opts: { needsCost: boolean }): void {
    if (!this.confirmedBillable) {
      throw new LiveSafetyError("confirm_required", `${what} changes cloud state and this run was not started with --confirm-billable.`);
    }
    if (opts.needsCost && this.#costCheckedUsd === undefined) {
      throw new LiveSafetyError("cost_unknown", `${what} would create billable resources before any cost estimate was checked against the ${fmtUsd(this.maxMonthlyUsd)}/month limit; refusing.`);
    }
  }

  /** Refuse unless `tags` carry this run's tag. */
  assertTagged(tags: Record<string, string> | undefined, what: string): void {
    assertRunTagged(tags, this.runId, what);
  }
}

/**
 * Run every gate in order and return the session. The first cloud calls this
 * makes are `sts:GetCallerIdentity` and `ssm:GetParameter`, both read-only.
 */
export async function establishLiveSession(input: EstablishInput): Promise<LiveSession> {
  assertBillableConfirmed({ mutating: input.mutating, confirmBillable: input.confirmBillable });
  const target = resolveLiveTarget(input.config);
  const runId = assertRunId(input.runId ?? newRunId((input.now ?? (() => new Date()))()));
  if (input.access.accountId !== target.accountId || input.access.region !== target.region) {
    throw new LiveSafetyError("account_mismatch", "The AWS access handle was built for a different account or region than the run target.");
  }
  const probe = input.probe ?? sdkAccountProbe({ sts: input.access.client(STSClient), ssm: input.access.client(SSMClient) });
  const verified = await verifyLiveAccount(probe, target);
  return new LiveSession({ runId, target, access: input.access, confirmedBillable: input.confirmBillable, mutating: input.mutating, callerArn: verified.arn });
}
