/**
 * LIVE mixed-application acceptance (PROD-MIX-06): GCP compute + Azure PostgreSQL + AWS function-equivalent serving real
 * traffic of the reference app (`fixtures/mixed-app`), with an independent database readback. GATED AND DEFERRED: it
 * runs only with ZENITH_LIVE_MIXED=1 plus every reference below, an approved scope manifest and an explicit budget; in
 * every other case it reports why it did not run, and a skipped run is never evidence.
 *
 * What it does NOT do: it does not create cloud resources. The deployment (plan, a person's approvals, one operation per
 * child, start) is the operator-driven flow of PROD-MIX-01/02; this harness vouches for, exercises and measures what that
 * flow deployed. "Auto-teardown" is therefore a deadline and a check, not a destroy: every run has a TTL (run-id tags and a
 * `zenith:ttl-expires` deadline), `teardown-check` reports `torn_down | pending_human_approval | in_progress | not_proposed |
 * needs_attention` from the control plane's own teardown ledger and exits non-zero once the TTL passed without
 * `torn_down`. Destroying anything stays a person-approved operation (PROD-MIX-04) and `cleanup-cli --run-id` for tagged
 * AWS leftovers.
 *
 * Steps (each checkpointed, resumable, none counted done unless performed):
 *   scope-and-gates -> budget-admission -> verify-plan-evidence -> connectivity-probes -> traffic -> readback -> teardown-check
 *
 * Environment (references to FILES, never values):
 *   ZENITH_LIVE_MIXED=1
 *   ZENITH_LIVE_MIXED_API_URL, ZENITH_LIVE_MIXED_WORKSPACE_ID, ZENITH_LIVE_MIXED_PLAN_ID, ZENITH_LIVE_MIXED_TOKEN_FILE
 *   ZENITH_LIVE_MIXED_ENTRY_URL                  public https entry of the web tier
 *   ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE       read-only credential file for the direct database readback
 *   ZENITH_LIVE_MIXED_BUDGET_USD                 explicit per-run cap (> 0, within the approved scope)
 *   ZENITH_LIVE_MIXED_TTL_MINUTES                run lifetime (within the approved scope)
 *   optional: ZENITH_LIVE_MIXED_RUN_ID, ZENITH_LIVE_MIXED_OUT_DIR, ZENITH_LIVE_MIXED_ORDERS (50), ZENITH_LIVE_MIXED_DB_HOST_SUFFIX,
 *             ZENITH_LIVE_MIXED_CLIENT_CERT_FILE / _KEY_FILE / _CA_FILE, ZENITH_LIVE_MIXED_SOURCE_OUTSIDE_ALLOWLIST=1
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest } from "@/lib/controlplane/digest";
import type { MixedEconomicsReport } from "@/lib/execution/mixed/economics";
import { RunCheckpoint, fileStore, type CheckpointStore } from "../../release/checkpoint";
import { Scope, ScopeError, ScopeLedger, requireScope } from "../../release/scope";
import { verifyMixedEvidence } from "../mixed-evidence";
import { LiveSafetyError, TAG_LIVE_RUN, newRunId, runIdTime } from "../safety";
import { runConnectivityProbes, nodeProbeIo, type ProbeEndpoint, type ProbeIo } from "./connectivity-probe";
import { postgresReadback, verifyReadback, type ReadbackSource } from "./readback";
import { runTraffic, type Requester, type TrafficLedger } from "./traffic";
import spec from "../../../fixtures/mixed-app/spec.json";

export const MIXED_LIVE_HARNESS = "mixed-traffic-live";
export const STEPS = ["scope-and-gates", "budget-admission", "verify-plan-evidence", "connectivity-probes", "traffic", "readback", "teardown-check"] as const;
export type MixedStep = (typeof STEPS)[number];

export interface MixedLiveConfig {
  apiUrl: string;
  workspaceId: string;
  planId: string;
  tokenFile: string;
  entryUrl: string;
  readbackUrlFile: string;
  budgetUsd: number;
  ttlMinutes: number;
  runId: string;
  outDir: string;
  orders: number;
  dbHostSuffix: string;
  clientCertFile?: string;
  clientKeyFile?: string;
  clientCaFile?: string;
  sourceOutsideAllowlist: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;
const REQUIRED = ["ZENITH_LIVE_MIXED_API_URL", "ZENITH_LIVE_MIXED_WORKSPACE_ID", "ZENITH_LIVE_MIXED_PLAN_ID", "ZENITH_LIVE_MIXED_TOKEN_FILE", "ZENITH_LIVE_MIXED_ENTRY_URL", "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE", "ZENITH_LIVE_MIXED_BUDGET_USD", "ZENITH_LIVE_MIXED_TTL_MINUTES"] as const;

export function loadMixedLiveConfig(env: Env, now: () => Date = () => new Date()): { config: MixedLiveConfig } | { skipReason: string } {
  if (env.ZENITH_LIVE_MIXED !== "1") return { skipReason: "live mixed-application acceptance is deferred; set ZENITH_LIVE_MIXED=1 and the ZENITH_LIVE_MIXED_* references to run it" };
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) return { skipReason: `ZENITH_LIVE_MIXED=1 but ${missing.join(", ")} not set` };
  const budgetUsd = Number(env.ZENITH_LIVE_MIXED_BUDGET_USD);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { skipReason: "ZENITH_LIVE_MIXED_BUDGET_USD must be a positive number: a live run needs an explicit per-run budget cap" };
  const ttlMinutes = Number(env.ZENITH_LIVE_MIXED_TTL_MINUTES);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5) return { skipReason: "ZENITH_LIVE_MIXED_TTL_MINUTES must be a whole number of minutes (at least 5): every live run has a time to live" };
  for (const name of ["ZENITH_LIVE_MIXED_TOKEN_FILE", "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE"] as const) {
    if (!path.isAbsolute(env[name]!)) return { skipReason: `${name} must be an absolute path to a credential FILE` };
  }
  const orders = env.ZENITH_LIVE_MIXED_ORDERS ? Number(env.ZENITH_LIVE_MIXED_ORDERS) : 50;
  if (!Number.isInteger(orders) || orders < 1 || orders > 5000) return { skipReason: "ZENITH_LIVE_MIXED_ORDERS must be a whole number from 1 to 5000" };
  let runId: string;
  try { runId = env.ZENITH_LIVE_MIXED_RUN_ID ?? newRunId(now()); if (runIdTime(runId) === null) throw new LiveSafetyError("run_id_invalid", "bad run id"); } catch { return { skipReason: "ZENITH_LIVE_MIXED_RUN_ID is not a live-run id (zlive-<yyyymmddhhmm>-<4 chars>)" }; }
  return {
    config: {
      apiUrl: env.ZENITH_LIVE_MIXED_API_URL!, workspaceId: env.ZENITH_LIVE_MIXED_WORKSPACE_ID!, planId: env.ZENITH_LIVE_MIXED_PLAN_ID!, tokenFile: env.ZENITH_LIVE_MIXED_TOKEN_FILE!,
      entryUrl: env.ZENITH_LIVE_MIXED_ENTRY_URL!, readbackUrlFile: env.ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE!, budgetUsd, ttlMinutes, runId,
      outDir: path.resolve(env.ZENITH_LIVE_MIXED_OUT_DIR ?? ".data-live/mixed"), orders, dbHostSuffix: env.ZENITH_LIVE_MIXED_DB_HOST_SUFFIX ?? ".postgres.database.azure.com",
      ...(env.ZENITH_LIVE_MIXED_CLIENT_CERT_FILE ? { clientCertFile: env.ZENITH_LIVE_MIXED_CLIENT_CERT_FILE } : {}),
      ...(env.ZENITH_LIVE_MIXED_CLIENT_KEY_FILE ? { clientKeyFile: env.ZENITH_LIVE_MIXED_CLIENT_KEY_FILE } : {}),
      ...(env.ZENITH_LIVE_MIXED_CLIENT_CA_FILE ? { clientCaFile: env.ZENITH_LIVE_MIXED_CLIENT_CA_FILE } : {}),
      sourceOutsideAllowlist: env.ZENITH_LIVE_MIXED_SOURCE_OUTSIDE_ALLOWLIST === "1",
    },
  };
}

export type StepStatus = "passed" | "failed" | "skipped";
export interface StepResult { step: MixedStep; status: StepStatus; detail: string; problems?: string[] }

export type TeardownVerdict = "torn_down" | "pending_human_approval" | "in_progress" | "not_proposed" | "needs_attention";
export function teardownVerdict(run: { teardown?: { steps: { status: string }[] } } | null | undefined): TeardownVerdict {
  const steps = run?.teardown?.steps;
  if (!steps || steps.length === 0) return "not_proposed";
  if (steps.some((s) => s.status === "failed" || s.status === "uncertain")) return "needs_attention";
  if (steps.every((s) => s.status === "destroyed")) return "torn_down";
  return steps.some((s) => s.status === "released") ? "in_progress" : "pending_human_approval";
}

export interface MixedLiveDeps {
  scope?: Scope;
  getJson?: (pathname: string) => Promise<unknown>;
  requester?: Requester;
  probeIo?: ProbeIo;
  readback?: () => Promise<ReadbackSource & { close?(): Promise<void> }>;
  readFile?: (file: string) => Buffer;
  store?: CheckpointStore;
  now?: () => Date;
  env?: Env;
}

function controlPlaneGet(config: MixedLiveConfig, readFile: (file: string) => Buffer): (pathname: string) => Promise<unknown> {
  const origin = new URL(config.apiUrl);
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("The control plane URL must be https (or a local development host).");
  return async (pathname) => {
    const token = readFile(config.tokenFile).toString("utf8").trim();
    if (!token) throw new Error("The token file is empty.");
    const response = await fetch(new URL(pathname, origin), { headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": config.workspaceId } });
    if (!response.ok) throw new Error(`The control plane answered ${response.status} for ${pathname.split("?")[0]}.`);
    return response.json();
  };
}

interface PlanViewShape { parentOperationId?: string | null; connectivity?: { endpoints: ProbeEndpoint[] } | null }

export interface MixedLiveReport {
  runId: string;
  provenance: "live";
  results: StepResult[];
  /** every step performed and passed (a skipped or failed step makes this false) */
  ok: boolean;
  teardown: { verdict: TeardownVerdict; deadline: string; overdue: boolean };
  resumed: boolean;
  nextCommands: string[];
  ledgerDigest?: string;
}

/**
 * Run the harness. Returns a report; throws `ScopeError` only before anything is attempted (no approved scope, a
 * harness without a grant). Everything after that is recorded as a step result, never as an exception that hides a step.
 */
export async function runMixedLive(config: MixedLiveConfig, deps: MixedLiveDeps = {}): Promise<MixedLiveReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const readFile = deps.readFile ?? ((file: string) => readFileSync(file));
  const scope = deps.scope ?? requireScope(MIXED_LIVE_HARNESS, "control_plane", env, now);
  scope.assertApproved();
  const ledger = new ScopeLedger();
  const getJson = deps.getJson ?? controlPlaneGet(config, readFile);
  const runDir = path.join(config.outDir, config.runId);
  const { checkpoint, resumed, interrupted } = RunCheckpoint.open({ store: deps.store ?? fileStore(path.join(runDir, "checkpoint.json")), runId: config.runId, harness: MIXED_LIVE_HARNESS, scopeDigest: scope.digest, steps: STEPS, now });
  const results: StepResult[] = [];
  const cache = (step: MixedStep): string => path.join(runDir, `${step}.json`);
  const deadline = new Date((runIdTime(config.runId) ?? now()).getTime() + config.ttlMinutes * 60_000);
  const tags = { [TAG_LIVE_RUN]: config.runId };
  let planView: PlanViewShape | undefined;
  const loadPlanView = async (): Promise<PlanViewShape> => (planView ??= (await getJson(`/api/platform/v1/mixed/plans/${encodeURIComponent(config.planId)}`)) as PlanViewShape);
  let trafficLedger: TrafficLedger | undefined;

  // Fail closed: once a gating step did not pass, no later step that acts is attempted (only the read-only teardown check still runs).
  let blockedBy: MixedStep | undefined;
  const perform = async (step: MixedStep, fn: () => Promise<Omit<StepResult, "step">>): Promise<void> => {
    const prior = checkpoint.state.steps.find((s) => s.id === step);
    if (prior?.status === "done") {
      // A step that passed in an earlier session is not repeated; its cached result is used, or the checkpoint's own note.
      let restored: StepResult = { step, status: "passed", detail: `${prior.note ?? "passed earlier"} (restored from the checkpoint)` };
      try { restored = JSON.parse(readFileSync(cache(step), "utf8")) as StepResult; } catch { /* keep the checkpoint note */ }
      results.push(restored);
      return;
    }
    if (blockedBy && step !== "teardown-check") {
      results.push({ step, status: "skipped", detail: `Not run: the earlier step ${blockedBy} did not pass.` });
      return;
    }
    checkpoint.begin(step);
    let result: StepResult;
    try { result = { step, ...(await fn()) }; }
    catch (error) { result = { step, status: "failed", detail: error instanceof ScopeError ? `refused by scope (${error.code}): ${error.message}` : `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message.slice(0, 200) : "unexpected"}` }; }
    results.push(result);
    if (result.status !== "passed" && step !== "teardown-check") blockedBy ??= step;
    mkdirSync(runDir, { recursive: true });
    if (result.status === "passed") { writeFileSync(cache(step), JSON.stringify(result)); checkpoint.complete(step, result.detail.slice(0, 300), digest(result)); }
    // Anything not passed is recorded as failed in the checkpoint (never done), so a resume runs it again.
    else checkpoint.fail(step, `${result.status}: ${result.detail}`.slice(0, 300));
  };

  await perform("scope-and-gates", async () => {
    scope.authorize({ harness: MIXED_LIVE_HARNESS, provider: "control_plane", action: "read" });
    if (config.budgetUsd > scope.manifest.budgets.perRunUsd) return { status: "failed", detail: `The requested budget $${config.budgetUsd} exceeds the approved per-run budget $${scope.manifest.budgets.perRunUsd}.` };
    if (config.ttlMinutes > scope.manifest.budgets.maxRunTtlMinutes) return { status: "failed", detail: `The requested lifetime ${config.ttlMinutes} min exceeds the approved ${scope.manifest.budgets.maxRunTtlMinutes} min.` };
    return { status: "passed", detail: `Scope ${scope.digest.slice(0, 12)} approved by ${scope.manifest.approval.approvedBy}; run ${config.runId}, budget $${config.budgetUsd}, ttl ${config.ttlMinutes} min.` };
  });

  await perform("budget-admission", async () => {
    const body = (await getJson(`/api/platform/v1/mixed/plans/${encodeURIComponent(config.planId)}/economics?egressGb=10&interComponentFraction=0.2`)) as { report?: MixedEconomicsReport };
    const report = body.report;
    if (!report || !report.priced) return { status: "failed", detail: `The deployment could not be priced (${report && !report.priced ? report.reason : "no report"}); a run without a cost estimate is refused.` };
    const hours = config.ttlMinutes / 60;
    const runUsd = (report.monthlyUsd * hours) / 730;
    if (runUsd > config.budgetUsd) return { status: "failed", detail: `Estimated $${runUsd.toFixed(2)} for ${config.ttlMinutes} min exceeds the run budget $${config.budgetUsd.toFixed(2)}. Estimates are list prices, not invoices.` };
    const slices = new Map<string, number>();
    for (const [provider, monthly] of Object.entries(report.byProvider)) {
      const key = provider === "aws" || provider === "gcp" || provider === "azure" ? provider : "gcp"; // shared lines ride with the entry cloud
      slices.set(key, (slices.get(key) ?? 0) + (monthly * hours) / 730);
    }
    for (const [provider, usd] of slices) {
      scope.authorize({ harness: MIXED_LIVE_HARNESS, provider: provider as "aws" | "gcp" | "azure", action: "create_disposable", estimatedUsd: Math.round(usd * 100) / 100, runId: config.runId, resourceName: `zenith-${config.runId}-${provider}`, ttlMinutes: config.ttlMinutes }, ledger);
    }
    return { status: "passed", detail: `Estimated $${runUsd.toFixed(2)} (list price) for the run window, inside the $${config.budgetUsd.toFixed(2)} cap and the approved per-provider budgets.` };
  });

  await perform("verify-plan-evidence", async () => {
    const verdict = verifyMixedEvidence(await loadPlanView());
    return verdict.ok ? { status: "passed", detail: "The stored plan, receipts and addresses are complete and consistent." } : { status: "failed", detail: "The stored plan evidence is incomplete or inconsistent.", problems: verdict.problems };
  });

  await perform("connectivity-probes", async () => {
    const endpoints = (await loadPlanView()).connectivity?.endpoints ?? [];
    if (!endpoints.length) return { status: "failed", detail: "The plan carries no protected-endpoint declaration, so cross-cloud connectivity was never approved or probed." };
    scope.authorize({ harness: "mixed-connectivity-live", provider: "control_plane", action: "read" });
    const client = config.clientCertFile && config.clientKeyFile ? { cert: readFile(config.clientCertFile), key: readFile(config.clientKeyFile), ...(config.clientCaFile ? { ca: readFile(config.clientCaFile) } : {}) } : undefined;
    const verdict = await runConnectivityProbes({ endpoints, io: deps.probeIo ?? nodeProbeIo, ...(client ? { client } : {}), sourceOutsideAllowlist: config.sourceOutsideAllowlist });
    const applicable = verdict.results.filter((r) => r.applicable);
    const bad = applicable.filter((r) => r.status !== "passed");
    const notChecked = verdict.notChecked.length ? verdict.notChecked.join(", ") : "none";
    return verdict.ok
      ? { status: "passed", detail: `${applicable.length} probes passed from the ${verdict.vantage} vantage point; NOT checked from here: ${notChecked} (a second run from the other vantage point covers them).` }
      : { status: bad.some((r) => r.status === "failed") ? "failed" : "skipped", detail: `${bad.length} of ${applicable.length} applicable probes did not pass; skipped or inconclusive probes are not passes.`, problems: bad.map((r) => `${r.endpointId} ${r.probe}: ${r.status} - ${r.detail}`) };
  });

  await perform("traffic", async () => {
    scope.authorize({ harness: MIXED_LIVE_HARNESS, provider: "control_plane", action: "mutate_run_tagged", runId: config.runId, tags });
    trafficLedger = await runTraffic(config.entryUrl, { runId: config.runId, seed: Number.parseInt(digest(config.runId).slice(0, 8), 16), count: config.orders, concurrency: 4, replay: Math.min(5, config.orders) }, deps.requester ? { requester: deps.requester } : {});
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "traffic-ledger.json"), JSON.stringify(trafficLedger));
    const c = trafficLedger.counts;
    return c.acknowledged > 0 ? { status: "passed", detail: `${c.acknowledged} acknowledged, ${c.rejected} rejected, ${c.uncertain} uncertain (ledger ${trafficLedger.digest.slice(0, 12)}).` } : { status: "failed", detail: `No write was acknowledged (${c.rejected} rejected, ${c.uncertain} uncertain).` };
  });

  await perform("readback", async () => {
    let ledgerForReadback = trafficLedger;
    if (!ledgerForReadback) { try { ledgerForReadback = JSON.parse(readFileSync(path.join(runDir, "traffic-ledger.json"), "utf8")) as TrafficLedger; } catch { return { status: "failed", detail: "There is no traffic ledger to read back against." }; } }
    const source = await (deps.readback ?? (() => postgresReadback({ urlFile: config.readbackUrlFile })))();
    try {
      const rows = await source.fetchByPrefix(`${config.runId}-`);
      const verdict = verifyReadback(ledgerForReadback, rows, source.describe(), { runId: config.runId, expectedProviders: { web: spec.providers.web, enricher: spec.providers.enricher }, databaseHostSuffix: config.dbHostSuffix });
      return verdict.ok ? { status: "passed", detail: `${verdict.counts.foundAcknowledged}/${verdict.counts.acknowledged} acknowledged writes found with correct price and checksum; ${verdict.counts.uncertainPresent} uncertain present, ${verdict.counts.uncertainAbsent} absent.` } : { status: "failed", detail: "The independent readback disagrees with the traffic ledger.", problems: verdict.problems };
    } finally { await source.close?.(); }
  });

  let verdict = "not_proposed" as TeardownVerdict;
  await perform("teardown-check", async () => {
    const parentOperationId = (await loadPlanView()).parentOperationId;
    if (!parentOperationId) return { status: "failed", detail: "The plan has no parent operation, so teardown state cannot be read." };
    const run = (await getJson(`/api/platform/v1/operations/${encodeURIComponent(parentOperationId)}/mixed-run`)) as { run?: { teardown?: { steps: { status: string }[] } } };
    verdict = teardownVerdict(run.run);
    const overdue = now().getTime() > deadline.getTime() && verdict !== "torn_down";
    return { status: "skipped", detail: `Teardown is ${verdict}${overdue ? ` and OVERDUE (deadline ${deadline.toISOString()})` : `; deadline ${deadline.toISOString()}`}. Destroying stays a person-approved operation.` };
  });

  const overdue = now().getTime() > deadline.getTime() && verdict !== "torn_down";
  const nextCommands = [
    `Teardown (a person approves each destroy): propose through the console, then release each step; check with: ZENITH_LIVE_MIXED=1 ZENITH_LIVE_MIXED_RUN_ID=${config.runId} npx tsx scripts/acceptance/mixed/live-run.ts`,
    `Tagged AWS leftovers after approval: npx tsx scripts/acceptance/cleanup-cli.ts --run-id ${config.runId} (dry run first; --execute needs --confirm)`,
  ];
  checkpoint.setNextCommands(nextCommands);
  const required = results.filter((r) => r.step !== "teardown-check");
  return {
    runId: config.runId, provenance: "live", results, ok: required.length === STEPS.length - 1 && required.every((r) => r.status === "passed") && !overdue,
    teardown: { verdict, deadline: deadline.toISOString(), overdue }, resumed: resumed || interrupted.length > 0, nextCommands, ...(trafficLedger ? { ledgerDigest: trafficLedger.digest } : {}),
  };
}

export async function runMixedLiveCli(env: Env = process.env, io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } }): Promise<number> {
  const loaded = loadMixedLiveConfig(env);
  if ("skipReason" in loaded) { io.err(`[mixed live] SKIPPED, not a pass: ${loaded.skipReason}\n`); return 2; }
  try {
    const report = await runMixedLive(loaded.config, { env });
    io.out(`${JSON.stringify(report, null, 2)}\n`);
    return report.teardown.overdue ? 3 : report.ok ? 0 : 1;
  } catch (error) {
    io.err(`${error instanceof ScopeError ? `REFUSED (${error.code}): ` : ""}${error instanceof Error ? error.message : "unexpected error"}\n`);
    return error instanceof ScopeError ? 2 : 1;
  }
}

if (process.argv[1] && /(?:^|[/\\])live-run\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) void runMixedLiveCli().then((code) => { process.exitCode = code; });
