/**
 * LIVE one-provider-failure drill for the reference mixed app (PROD-MIX-07). GATED AND DEFERRED like `live-run.ts`:
 * ZENITH_LIVE_MIXED=1 and ZENITH_LIVE_MIXED_RECOVERY=1, an approved scope with an `inject_fault` grant, credential FILES and
 * an explicit fault choice. It runs against a deployment that already passed `live-run.ts`.
 *
 * Phases, each with its own traffic and an independent database readback (ids `<run>-base`, `<run>-fault`, `<run>-heal`):
 *   base    traffic is served and every acknowledged write is found.
 *   fault   one fault is injected, traffic continues, and the harness records what the fault did.
 *   heal    where the fault is reversible it is healed and traffic is served again.
 *
 * Faults (choose exactly one with ZENITH_LIVE_MIXED_FAULT):
 *   blackhole          a local fault proxy swallows the traffic generator's connections to the entry (the CLIENT path
 *                      is blackholed, nothing in any cloud is touched). Writes during the fault must come back
 *                      UNCERTAIN, never acknowledged, and nothing acknowledged may be lost. Reversible.
 *   revoke_connection  revokes one partition's connection through the control plane's own API. It is IRREVERSIBLE (a
 *                      revoked connection never works again; recovery is a new connection and a new approved plan).
 *                      Requires ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID and ZENITH_LIVE_MIXED_CONFIRM_REVOKE with the same
 *                      id, and the connection must belong to this run. It proves the control plane refuses that
 *                      partition from now on while the running application's data plane keeps serving and no
 *                      acknowledged write is lost.
 * It never destroys a resource and never calls a cloud API itself. Recovery steps are in docs/platform/operations/MIXED-RECOVERY.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest } from "@/lib/controlplane/digest";
import { RunCheckpoint, fileStore, type CheckpointStore } from "../../release/checkpoint";
import { Scope, ScopeError, requireScope } from "../../release/scope";
import { TAG_LIVE_RUN, runIdTime } from "../safety";
import { startFaultProxy } from "./fault-proxy";
import { postgresReadback, verifyReadback, type ReadbackSource } from "./readback";
import { nodeRequester, runTraffic, type Requester, type TrafficLedger } from "./traffic";
import spec from "../../../fixtures/mixed-app/spec.json";

export const RECOVERY_HARNESS = "mixed-recovery-live";
export type Fault = "blackhole" | "revoke_connection";
export const PHASES = ["base", "fault", "heal"] as const;
export type Phase = (typeof PHASES)[number];

type Env = Readonly<Record<string, string | undefined>>;

export interface RecoveryConfig {
  runId: string;
  fault: Fault;
  entryUrl: string;
  readbackUrlFile: string;
  dbHostSuffix: string;
  orders: number;
  outDir: string;
  apiUrl?: string;
  tokenFile?: string;
  revokeConnectionId?: string;
}

export function loadRecoveryConfig(env: Env): { config: RecoveryConfig } | { skipReason: string } {
  if (env.ZENITH_LIVE_MIXED !== "1" || env.ZENITH_LIVE_MIXED_RECOVERY !== "1") return { skipReason: "the live recovery drill is deferred; set ZENITH_LIVE_MIXED=1 and ZENITH_LIVE_MIXED_RECOVERY=1 and the references below to run it" };
  const fault = env.ZENITH_LIVE_MIXED_FAULT;
  if (fault !== "blackhole" && fault !== "revoke_connection") return { skipReason: "ZENITH_LIVE_MIXED_FAULT must be blackhole or revoke_connection (exactly one fault per drill)" };
  const missing = ["ZENITH_LIVE_MIXED_RUN_ID", "ZENITH_LIVE_MIXED_ENTRY_URL", "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE"].filter((n) => !env[n]);
  if (missing.length) return { skipReason: `${missing.join(", ")} not set` };
  const runId = env.ZENITH_LIVE_MIXED_RUN_ID!;
  if (runIdTime(runId) === null) return { skipReason: "ZENITH_LIVE_MIXED_RUN_ID is not a live-run id" };
  if (!path.isAbsolute(env.ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE!)) return { skipReason: "ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE must be an absolute path to a credential FILE" };
  let revokeConnectionId: string | undefined;
  if (fault === "revoke_connection") {
    revokeConnectionId = env.ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID;
    if (!revokeConnectionId || env.ZENITH_LIVE_MIXED_CONFIRM_REVOKE !== revokeConnectionId) return { skipReason: "revoke_connection needs ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID and ZENITH_LIVE_MIXED_CONFIRM_REVOKE set to the same connection id (revocation cannot be undone)" };
    if (!env.ZENITH_LIVE_MIXED_API_URL || !env.ZENITH_LIVE_MIXED_TOKEN_FILE || !path.isAbsolute(env.ZENITH_LIVE_MIXED_TOKEN_FILE)) return { skipReason: "revoke_connection needs ZENITH_LIVE_MIXED_API_URL and an absolute ZENITH_LIVE_MIXED_TOKEN_FILE" };
  }
  const orders = env.ZENITH_LIVE_MIXED_ORDERS ? Number(env.ZENITH_LIVE_MIXED_ORDERS) : 20;
  if (!Number.isInteger(orders) || orders < 1 || orders > 2000) return { skipReason: "ZENITH_LIVE_MIXED_ORDERS must be a whole number from 1 to 2000" };
  return {
    config: {
      runId, fault, entryUrl: env.ZENITH_LIVE_MIXED_ENTRY_URL!, readbackUrlFile: env.ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE!, dbHostSuffix: env.ZENITH_LIVE_MIXED_DB_HOST_SUFFIX ?? ".postgres.database.azure.com",
      orders, outDir: path.resolve(env.ZENITH_LIVE_MIXED_OUT_DIR ?? ".data-live/mixed"),
      ...(env.ZENITH_LIVE_MIXED_API_URL ? { apiUrl: env.ZENITH_LIVE_MIXED_API_URL } : {}), ...(env.ZENITH_LIVE_MIXED_TOKEN_FILE ? { tokenFile: env.ZENITH_LIVE_MIXED_TOKEN_FILE } : {}),
      ...(revokeConnectionId ? { revokeConnectionId } : {}),
    },
  };
}

export interface PhaseResult { phase: Phase; ok: boolean; detail: string; problems: string[]; counts?: TrafficLedger["counts"] }
export interface RecoveryReport { runId: string; fault: Fault; provenance: "live"; phases: PhaseResult[]; ok: boolean; irreversible: boolean; nextCommands: string[] }

export interface RecoveryDeps {
  scope?: Scope;
  /** POST to the control plane; returns the JSON body */
  post?: (pathname: string) => Promise<unknown>;
  get?: (pathname: string) => Promise<unknown>;
  requester?: Requester;
  readback?: () => Promise<ReadbackSource & { close?(): Promise<void> }>;
  store?: CheckpointStore;
  now?: () => Date;
  env?: Env;
}

function api(config: RecoveryConfig): { post: (p: string) => Promise<unknown>; get: (p: string) => Promise<unknown> } {
  const origin = new URL(config.apiUrl ?? "https://invalid.example");
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("The control plane URL must be https (or a local development host).");
  const call = async (method: "GET" | "POST", pathname: string): Promise<unknown> => {
    const token = readFileSync(config.tokenFile!, "utf8").trim();
    const response = await fetch(new URL(pathname, origin), { method, headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
    if (!response.ok) throw new Error(`The control plane answered ${response.status} for ${method} ${pathname.split("?")[0]}.`);
    return response.json();
  };
  return { post: (p) => call("POST", p), get: (p) => call("GET", p) };
}

export async function runRecoveryDrill(config: RecoveryConfig, deps: RecoveryDeps = {}): Promise<RecoveryReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const scope = deps.scope ?? requireScope(RECOVERY_HARNESS, "control_plane", env, now);
  scope.assertApproved();
  const tags = { [TAG_LIVE_RUN]: config.runId };
  const runDir = path.join(config.outDir, config.runId);
  const { checkpoint } = RunCheckpoint.open({ store: deps.store ?? fileStore(path.join(runDir, `recovery-${config.fault}.checkpoint.json`)), runId: config.runId, harness: RECOVERY_HARNESS, scopeDigest: scope.digest, steps: PHASES, now });
  const phases: PhaseResult[] = [];
  const control = deps.post && deps.get ? { post: deps.post, get: deps.get } : config.fault === "revoke_connection" ? api(config) : undefined;
  const entry = new URL(config.entryUrl);
  const seed = Number.parseInt(digest(`${config.runId}-recovery`).slice(0, 8), 16);

  const phaseId = (phase: Phase): string => `${config.runId}-${phase}`;
  const readbackFor = async (ledger: TrafficLedger, phase: Phase): Promise<{ problems: string[]; detail: string }> => {
    const source = await (deps.readback ?? (() => postgresReadback({ urlFile: config.readbackUrlFile })))();
    try {
      const rows = await source.fetchByPrefix(`${phaseId(phase)}-`);
      const verdict = verifyReadback(ledger, rows, source.describe(), { runId: phaseId(phase), expectedProviders: { web: spec.providers.web, enricher: spec.providers.enricher }, databaseHostSuffix: config.dbHostSuffix });
      // A phase with no acknowledged write (a blackholed client) is expected; the "nothing proven" rule does not apply to it.
      const problems = phase === "fault" && config.fault === "blackhole" ? verdict.problems.filter((p) => !p.startsWith("No acknowledged writes")) : verdict.problems;
      return { problems, detail: `${verdict.counts.foundAcknowledged}/${verdict.counts.acknowledged} acknowledged found; uncertain ${verdict.counts.uncertainPresent} present, ${verdict.counts.uncertainAbsent} absent` };
    } finally { await source.close?.(); }
  };
  const traffic = (phase: Phase, requester?: Requester, timeoutMs = 5000): Promise<TrafficLedger> =>
    runTraffic(config.entryUrl, { runId: phaseId(phase), seed, count: config.orders, concurrency: 4, timeoutMs }, requester ? { requester } : deps.requester ? { requester: deps.requester } : {});
  const record = (phase: Phase, ok: boolean, detail: string, problems: string[], counts?: TrafficLedger["counts"]): void => {
    phases.push({ phase, ok, detail, problems, ...(counts ? { counts } : {}) });
    if (ok) checkpoint.complete(phase, detail.slice(0, 300)); else checkpoint.fail(phase, `failed: ${detail}`.slice(0, 300));
  };

  scope.authorize({ harness: RECOVERY_HARNESS, provider: "control_plane", action: "mutate_run_tagged", runId: config.runId, tags });
  scope.authorize({ harness: RECOVERY_HARNESS, provider: "control_plane", action: "inject_fault", runId: config.runId, tags });

  // base
  checkpoint.begin("base");
  const base = await traffic("base");
  const baseRb = await readbackFor(base, "base");
  const baseProblems = [...(base.counts.acknowledged === 0 ? ["No write was acknowledged in the baseline."] : []), ...(base.counts.uncertain > 0 ? [`${base.counts.uncertain} baseline writes were uncertain before any fault.`] : []), ...baseRb.problems];
  record("base", baseProblems.length === 0, baseRb.detail, baseProblems, base.counts);
  if (baseProblems.length) {
    checkpoint.skip("fault", "baseline failed; no fault was injected"); checkpoint.skip("heal", "baseline failed; no fault was injected");
    return finish(config, phases, false);
  }

  // fault and heal
  checkpoint.begin("fault");
  if (config.fault === "blackhole") {
    const proxy = await startFaultProxy({ host: entry.hostname, port: Number(entry.port || (entry.protocol === "https:" ? 443 : 80)) }, { initial: "blackhole" });
    try {
      const during = await traffic("fault", nodeRequester({ host: "127.0.0.1", port: proxy.port }), 1500);
      const rb = await readbackFor(during, "fault");
      const problems = [...(during.counts.acknowledged > 0 ? [`${during.counts.acknowledged} writes were acknowledged through a blackhole, which cannot happen.`] : []), ...rb.problems];
      record("fault", problems.length === 0, `blackholed client path: ${during.counts.uncertain} uncertain, ${during.counts.acknowledged} acknowledged; ${rb.detail}`, problems, during.counts);
      checkpoint.begin("heal");
      proxy.setMode("pass");
      const healed = await traffic("heal", nodeRequester({ host: "127.0.0.1", port: proxy.port }));
      const healedRb = await readbackFor(healed, "heal");
      const healProblems = [...(healed.counts.acknowledged === 0 ? ["No write was acknowledged after healing."] : []), ...healed.records.some((r) => r.outcome === "uncertain") ? ["Some writes were still uncertain after healing."] : [], ...healedRb.problems];
      record("heal", healProblems.length === 0, healedRb.detail, healProblems, healed.counts);
    } finally { await proxy.close(); }
    return finish(config, phases, false);
  }

  // revoke_connection: irreversible, so the connection must be this run's own and was confirmed twice at load time
  scope.authorize({ harness: RECOVERY_HARNESS, provider: "control_plane", action: "teardown_run_tagged", runId: config.runId, tags });
  const connectionId = config.revokeConnectionId!;
  let revokeProblems: string[] = [];
  try {
    await control!.post(`/api/platform/v1/connections/${encodeURIComponent(connectionId)}/revoke`);
    const after = (await control!.get(`/api/platform/v1/connections/${encodeURIComponent(connectionId)}`)) as { status?: string; connection?: { status?: string } };
    const status = after.status ?? after.connection?.status;
    if (status !== "revoked") revokeProblems = [`The connection reads back as "${String(status)}", not revoked.`];
  } catch (error) { revokeProblems = [`Revocation could not be completed or confirmed: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`]; }
  const during = await traffic("fault");
  const rb = await readbackFor(during, "fault");
  const problems = [...revokeProblems, ...(during.counts.acknowledged === 0 ? ["The application stopped serving after a control-plane revocation; its data plane should be independent of it."] : []), ...rb.problems];
  record("fault", problems.length === 0, `connection revoked; application kept serving (${during.counts.acknowledged} acknowledged, ${during.counts.uncertain} uncertain); ${rb.detail}`, problems, during.counts);
  checkpoint.skip("heal", "revocation is irreversible; recovery is a new connection and a new approved plan (see the runbook)");
  return finish(config, phases, true);
}

function finish(config: RecoveryConfig, phases: PhaseResult[], irreversible: boolean): RecoveryReport {
  const required = config.fault === "blackhole" ? PHASES : (["base", "fault"] as const);
  return {
    runId: config.runId, fault: config.fault, provenance: "live", phases, irreversible,
    ok: required.every((p) => phases.find((r) => r.phase === p)?.ok === true),
    nextCommands: irreversible
      ? ["Create a replacement connection, verify it, re-plan the affected partition and approve the new plan (docs/platform/operations/MIXED-RECOVERY.md, scenario: revoked partition connection)."]
      : ["Compare uncertain writes with the database (they may exist); nothing was destroyed (docs/platform/operations/MIXED-RECOVERY.md, scenario: blackholed endpoint)."],
  };
}

export async function runRecoveryCli(env: Env = process.env, io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } }): Promise<number> {
  const loaded = loadRecoveryConfig(env);
  if ("skipReason" in loaded) { io.err(`[mixed recovery live] SKIPPED, not a pass: ${loaded.skipReason}\n`); return 2; }
  try {
    mkdirSync(loaded.config.outDir, { recursive: true });
    const report = await runRecoveryDrill(loaded.config, { env });
    writeFileSync(path.join(loaded.config.outDir, `${loaded.config.runId}-recovery-${loaded.config.fault}.json`), JSON.stringify(report, null, 2));
    io.out(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    io.err(`${error instanceof ScopeError ? `REFUSED (${error.code}): ` : ""}${error instanceof Error ? error.message : "unexpected error"}\n`);
    return error instanceof ScopeError ? 2 : 1;
  }
}

if (process.argv[1] && /(?:^|[/\\])live-recovery\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) void runRecoveryCli().then((code) => { process.exitCode = code; });
