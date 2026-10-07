/**
 * Live acceptance harness for ownership-safe non-AWS DNS teardown (PROD-LIFE-06).
 *
 * Live cloud acceptance is DEFERRED: nothing here runs unless the operator sets
 * `ZENITH_LIVE_<PROVIDER>=1` AND points every credential at a FILE
 * (`ZENITH_LIVE_<PROVIDER>_CREDENTIAL_FILE`, `ZENITH_LIVE_API_TOKEN_FILE`). Without
 * them the gate returns an explicit skip reason and a gated test is reported as
 * SKIPPED, never as passed.
 *
 * What it drives is the real control plane, never a cloud API directly:
 *   1. OWNED  - request the read-only teardown review for a sandbox environment
 *               whose managed DNS record set Zenith created. Expect the review to
 *               reach `awaiting_approval` and then STOP: the harness cannot approve
 *               (approval is a browser-session-only action bound to the plan digest).
 *               With `ZENITH_LIVE_<P>_APPROVED_OPERATION_ID` (set after a person
 *               approved in the browser) it waits for the destroy operation and
 *               requires `succeeded`.
 *   2. FOREIGN - request the review for an environment whose record set the
 *               operator re-pointed out of band. Expect the review to END WITHOUT
 *               an approvable proposal (refused); it must never reach approval.
 *
 * The control-plane client and the credential file are never printed; the file is
 * checked for existence only by the gate and read only to obtain the API token.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { setTimeout as sleepFor } from "node:timers/promises";
import { parseApiUrl } from "./config";
import { isTerminalStatus, type HttpControlPlaneClient, type TeardownReviewView } from "./clients/control-plane";

export type LiveDnsProvider = "gcp" | "azure" | "oci";
export const LIVE_DNS_PROVIDERS: readonly LiveDnsProvider[] = ["gcp", "azure", "oci"];

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface LiveDnsConfig {
  provider: LiveDnsProvider;
  apiUrl: string;
  /** path of the file holding the control-plane integration token */
  apiTokenFile: string;
  /** path of the cloud credential file the operator configured for the sandbox connection (existence checked only) */
  credentialFile: string;
  workspaceId?: string;
  ownedEnvironmentId: string;
  /** optional: an environment whose DNS record set was re-pointed out of band */
  foreignEnvironmentId?: string;
  /** optional: destroy operation a person already approved in the browser */
  approvedOperationId?: string;
}

export type LiveDnsGate = { enabled: true; config: LiveDnsConfig } | { enabled: false; reason: string };

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const upper = (p: LiveDnsProvider) => p.toUpperCase();

function readableFile(path: string | undefined): boolean {
  if (!path) return false;
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

/** Pure gate: decides from the environment alone. Never reads a credential's content. */
export function liveDnsGate(provider: LiveDnsProvider, env: EnvLike): LiveDnsGate {
  const P = upper(provider);
  if (env[`ZENITH_LIVE_${P}`] !== "1") return { enabled: false, reason: `ZENITH_LIVE_${P}=1 is not set; live ${provider} DNS teardown acceptance is deferred.` };
  const missing: string[] = [];
  const need = (name: string) => { const v = env[name]; if (!v) missing.push(name); return v; };
  const apiUrlRaw = need("ZENITH_LIVE_API_URL");
  const apiTokenFile = need("ZENITH_LIVE_API_TOKEN_FILE");
  const credentialFile = need(`ZENITH_LIVE_${P}_CREDENTIAL_FILE`);
  const ownedEnvironmentId = need(`ZENITH_LIVE_${P}_ENVIRONMENT_ID`);
  if (missing.length) return { enabled: false, reason: `Missing ${missing.join(", ")}.` };
  if (!readableFile(apiTokenFile)) return { enabled: false, reason: "ZENITH_LIVE_API_TOKEN_FILE does not name a readable file." };
  if (!readableFile(credentialFile)) return { enabled: false, reason: `ZENITH_LIVE_${P}_CREDENTIAL_FILE does not name a readable file.` };
  let apiUrl: string | undefined;
  try { apiUrl = parseApiUrl(apiUrlRaw, "ZENITH_LIVE_API_URL"); } catch (e) { return { enabled: false, reason: e instanceof Error ? e.message : "ZENITH_LIVE_API_URL is invalid." }; }
  if (!apiUrl) return { enabled: false, reason: "ZENITH_LIVE_API_URL is empty." };
  const ids = [ownedEnvironmentId!, env[`ZENITH_LIVE_${P}_FOREIGN_ENVIRONMENT_ID`], env[`ZENITH_LIVE_${P}_APPROVED_OPERATION_ID`]].filter((v): v is string => v !== undefined && v !== "");
  if (!ids.every((v) => ID.test(v))) return { enabled: false, reason: "An environment or operation id has an invalid shape." };
  return { enabled: true, config: {
    provider, apiUrl, apiTokenFile: apiTokenFile!, credentialFile: credentialFile!, ownedEnvironmentId: ownedEnvironmentId!,
    ...(env.ZENITH_LIVE_WORKSPACE_ID ? { workspaceId: env.ZENITH_LIVE_WORKSPACE_ID } : {}),
    ...(env[`ZENITH_LIVE_${P}_FOREIGN_ENVIRONMENT_ID`] ? { foreignEnvironmentId: env[`ZENITH_LIVE_${P}_FOREIGN_ENVIRONMENT_ID`] } : {}),
    ...(env[`ZENITH_LIVE_${P}_APPROVED_OPERATION_ID`] ? { approvedOperationId: env[`ZENITH_LIVE_${P}_APPROVED_OPERATION_ID`] } : {}),
  } };
}

export function readApiToken(config: Pick<LiveDnsConfig, "apiTokenFile">): string {
  const token = readFileSync(config.apiTokenFile, "utf8").trim();
  if (!token) throw new Error("The control-plane token file is empty.");
  return token;
}

export type TeardownReviewClient = Pick<HttpControlPlaneClient, "requestTeardownReview" | "getTeardownReview" | "getOperation">;

export interface ScenarioResult {
  scenario: "owned" | "foreign" | "approved-destroy";
  status: "passed" | "failed" | "awaiting_human_approval" | "skipped";
  /** fixed, bounded text; never provider output or credentials */
  detail: string;
  reviewOperationId?: string;
  destroyOperationId?: string;
}

export interface RunOptions {
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** a stable key per run so the request is replay-safe */
  idempotencyKey: string;
}

async function awaitReview(client: TeardownReviewClient, environmentId: string, reviewId: string, o: Required<Pick<RunOptions, "pollMs" | "timeoutMs" | "sleep" | "now">>): Promise<TeardownReviewView> {
  const deadline = o.now() + o.timeoutMs;
  for (;;) {
    const { review } = await client.getTeardownReview(environmentId, reviewId);
    // A finished review names the proposed destroy operation and then reports THAT operation's
    // status (awaiting_approval); a failed/denied/cancelled review job ends without one.
    if (review && (review.operationId || isTerminalStatus(review.status))) return review;
    if (o.now() + o.pollMs > deadline) return review ?? { reviewOperationId: reviewId, status: "timeout" };
    await o.sleep(o.pollMs);
  }
}

export async function runOwnedScenario(client: TeardownReviewClient, config: LiveDnsConfig, opts: RunOptions): Promise<ScenarioResult> {
  const o = { pollMs: opts.pollMs ?? 5000, timeoutMs: opts.timeoutMs ?? 15 * 60_000, sleep: opts.sleep ?? ((ms: number) => sleepFor(ms)), now: opts.now ?? (() => Date.now()) };
  const requested = await client.requestTeardownReview(config.ownedEnvironmentId, `${opts.idempotencyKey}-owned`);
  const review = await awaitReview(client, config.ownedEnvironmentId, requested.reviewOperationId, o);
  if (!review.operationId) {
    return { scenario: "owned", status: "failed", detail: `The review ended as ${String(review.status)} without an approvable teardown proposal.`, reviewOperationId: requested.reviewOperationId };
  }
  const destroy = (await client.getOperation(review.operationId)).operation;
  if (destroy.status !== "awaiting_approval") return { scenario: "owned", status: "failed", detail: `The teardown proposal is ${destroy.status}, not awaiting human approval.`, reviewOperationId: requested.reviewOperationId, destroyOperationId: destroy.id };
  return { scenario: "owned", status: "awaiting_human_approval", detail: "A person must approve this exact plan digest in the browser; the harness cannot.", reviewOperationId: requested.reviewOperationId, destroyOperationId: destroy.id };
}

export async function runForeignScenario(client: TeardownReviewClient, config: LiveDnsConfig, opts: RunOptions): Promise<ScenarioResult> {
  if (!config.foreignEnvironmentId) return { scenario: "foreign", status: "skipped", detail: "No re-pointed sandbox environment was configured." };
  const o = { pollMs: opts.pollMs ?? 5000, timeoutMs: opts.timeoutMs ?? 15 * 60_000, sleep: opts.sleep ?? ((ms: number) => sleepFor(ms)), now: opts.now ?? (() => Date.now()) };
  const requested = await client.requestTeardownReview(config.foreignEnvironmentId, `${opts.idempotencyKey}-foreign`);
  const review = await awaitReview(client, config.foreignEnvironmentId, requested.reviewOperationId, o);
  const proposed = !!review.operationId;
  return proposed
    ? { scenario: "foreign", status: "failed", detail: "A foreign or re-pointed record set produced an approvable teardown proposal.", reviewOperationId: requested.reviewOperationId }
    : { scenario: "foreign", status: "passed", detail: `The review was refused (${String(review.status)}); no approvable proposal exists.`, reviewOperationId: requested.reviewOperationId };
}

export async function runApprovedDestroy(client: TeardownReviewClient, config: LiveDnsConfig, opts: RunOptions): Promise<ScenarioResult> {
  if (!config.approvedOperationId) return { scenario: "approved-destroy", status: "skipped", detail: "No human-approved destroy operation id was provided." };
  const o = { pollMs: opts.pollMs ?? 10_000, timeoutMs: opts.timeoutMs ?? 60 * 60_000, sleep: opts.sleep ?? ((ms: number) => sleepFor(ms)), now: opts.now ?? (() => Date.now()) };
  const deadline = o.now() + o.timeoutMs;
  for (;;) {
    const { operation } = await client.getOperation(config.approvedOperationId);
    if (operation.status === "succeeded") return { scenario: "approved-destroy", status: "passed", detail: "The approved teardown succeeded; verification evidence is on the operation.", destroyOperationId: operation.id };
    if (isTerminalStatus(operation.status)) return { scenario: "approved-destroy", status: "failed", detail: `The approved teardown ended as ${operation.status}.`, destroyOperationId: operation.id };
    if (o.now() + o.pollMs > deadline) return { scenario: "approved-destroy", status: "failed", detail: "Timed out waiting for the approved teardown.", destroyOperationId: operation.id };
    await o.sleep(o.pollMs);
  }
}
