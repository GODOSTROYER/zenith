/**
 * The evidence recorder: what a live run actually did, written down as it
 * happens, in words that cannot overstate it.
 *
 * Output: `<out>/<runId>/` (default: the OS temp directory, never the repo;
 * `--out` overrides) holding
 *
 *   events.jsonl   every record, appended the moment it is made (crash-safe)
 *   evidence.json  the full structured record
 *   summary.json   counts, verdict and the check lists
 *   summary.md     the same, for a person
 *
 * Rules the recorder enforces, because a report that flatters the run is worse
 * than no report:
 *
 *   - A check is `passed`, `failed` or `skipped`. A skipped check carries the
 *     reason it did not run and is NEVER counted as passed. The verdict is
 *     `passed` only when at least one check ran, none failed and none were
 *     skipped; any skip makes the run `incomplete`.
 *   - A check that ran says WHERE it ran: `live` (a real cloud, in a run that
 *     passed the safety gates), `local` (real computation, no cloud) or
 *     `simulated` (fakes; proves nothing about a cloud). `live` is refused
 *     unless the recorder was created for a live run; a dry run can record only
 *     skips.
 *   - Every string is passed through `redactDeep` (the credential redactor)
 *     before it is stored or written, and log lines and probe bodies are
 *     truncated. Redaction is a backstop: the harness never holds a credential
 *     in anything it records.
 *   - Duplicate check ids are refused: a later "pass" cannot overwrite an
 *     earlier failure.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactDeep } from "@/lib/credentials/redact";
import { assertRunId } from "./safety";
import { redactAcceptance } from "./redact";

export type Provenance = "live" | "local" | "simulated" | "dry_run";
export type CheckStatus = "passed" | "failed" | "skipped";
export type CheckMode = "live" | "local" | "simulated";
export type Verdict = "passed" | "failed" | "incomplete" | "dry_run";

export interface CheckRecord {
  scenario: string;
  id: string;
  description: string;
  status: CheckStatus;
  /** where it ran; absent for skipped checks, which did not run */
  mode?: CheckMode;
  /** required for `skipped`: why it did not run */
  reason?: string;
  detail?: string;
  at: string;
}

export interface StepRecord {
  scenario: string;
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  durationMs: number;
  detail?: string;
  reason?: string;
}

export interface OperationRecordEntry {
  scenario: string;
  operationId: string;
  capability?: string;
  status?: string;
  detail?: string;
  at: string;
}

export interface PlanDigestEntry {
  scenario: string;
  label: string;
  digest: string;
  at: string;
}

export interface HttpProbeEntry {
  scenario: string;
  label: string;
  url: string;
  status?: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  bodySnippet?: string;
  tls?: { validTo?: string; subject?: string; issuer?: string; daysRemaining?: number };
  dns?: { addresses: string[] };
  at: string;
}

export interface LogQueryEntry {
  scenario: string;
  source: string;
  query: string;
  lines: string[];
  truncated: boolean;
  at: string;
}

export interface EvidenceSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  provenance: Provenance;
  scenarios: string[];
  account?: string;
  region?: string;
  verdict: Verdict;
  counts: { passedLive: number; passedLocal: number; passedSimulated: number; failed: number; skipped: number };
  ranLive: CheckRecord[];
  ranLocal: CheckRecord[];
  ranSimulated: CheckRecord[];
  skipped: CheckRecord[];
  failed: CheckRecord[];
  /** one plain-English paragraph that says exactly what was and was not verified */
  statement: string;
}

export class EvidenceError extends Error {
  readonly code = "evidence_invalid";
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface EvidenceOptions {
  runId: string;
  scenarios: readonly string[];
  provenance: Provenance;
  account?: string;
  region?: string;
  /** parent directory of `<runId>/`; default `<os tmp>/zenith-acceptance` */
  outDir?: string;
  now?: () => Date;
  /** Known integration tokens stay in memory and are removed before storage. */
  secrets?: readonly string[];
}

const MAX_LOG_LINES = 500;
const MAX_LINE_CHARS = 2_000;
const MAX_BODY_CHARS = 500;
const MAX_DETAIL_CHARS = 2_000;

// Redact first: truncating halfway through a key defeats pattern detection.
const cap = (s: string | undefined, n: number): string | undefined => {
  if (s === undefined) return undefined;
  const safe = redactDeep(s);
  return safe.length > n ? `${safe.slice(0, n)}…` : safe;
};

export function defaultEvidenceRoot(): string {
  return path.join(os.tmpdir(), "zenith-acceptance");
}

export class EvidenceRecorder {
  readonly runId: string;
  readonly provenance: Provenance;
  readonly dir: string;
  readonly #o: EvidenceOptions;
  readonly #now: () => Date;
  readonly #startedAt: string;
  readonly #checks: CheckRecord[] = [];
  readonly #steps: StepRecord[] = [];
  readonly #operations: OperationRecordEntry[] = [];
  readonly #digests: PlanDigestEntry[] = [];
  readonly #probes: HttpProbeEntry[] = [];
  readonly #logs: LogQueryEntry[] = [];
  readonly #notes: { at: string; scenario?: string; text: string }[] = [];
  #ready = false;
  #finalized = false;
  #queue: Promise<void> = Promise.resolve();
  #pending: { kind: string; data: unknown }[] = [];
  #writeError: unknown;

  constructor(options: EvidenceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.runId = assertRunId(options.runId);
    this.provenance = options.provenance;
    this.dir = path.join(options.outDir ?? defaultEvidenceRoot(), options.runId);
    this.#startedAt = this.#now().toISOString();
  }

  /** The mode a passing check gets unless the caller says otherwise. */
  get defaultMode(): CheckMode {
    if (this.provenance === "live") return "live";
    if (this.provenance === "simulated") return "simulated";
    return "local";
  }

  async init(): Promise<void> {
    if (this.#ready) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.#ready = true;
    this.#emit("run", { runId: this.runId, startedAt: this.#startedAt, provenance: this.provenance, scenarios: this.#o.scenarios, account: this.#o.account, region: this.#o.region });
    for (const event of this.#pending.splice(0)) this.#emit(event.kind, event.data);
  }

  /* ---------------------------------- checks --------------------------------- */

  check(input: Omit<CheckRecord, "at"> & { at?: string }): CheckRecord {
    input = redactAcceptance(input, this.#o.secrets);
    this.#assertOpen();
    if (!input.id || !input.scenario) throw new EvidenceError("A check needs a scenario and an id.");
    if (this.#checks.some((c) => c.scenario === input.scenario && c.id === input.id)) {
      throw new EvidenceError(`Check ${input.scenario}/${input.id} was already recorded; a result cannot be overwritten.`);
    }
    if (input.status === "skipped") {
      if (!input.reason?.trim()) throw new EvidenceError(`Skipped check ${input.scenario}/${input.id} needs the reason it did not run.`);
      if (input.mode !== undefined) throw new EvidenceError(`Skipped check ${input.scenario}/${input.id} did not run, so it has no mode.`);
    } else {
      if (input.mode === undefined) throw new EvidenceError(`Check ${input.scenario}/${input.id} must say whether it ran live, locally or simulated.`);
      if (this.provenance === "dry_run") throw new EvidenceError("A dry run makes no checks; it can only record skips.");
      if (input.mode === "live" && this.provenance !== "live") {
        throw new EvidenceError(`Check ${input.scenario}/${input.id} claims to have run live, but this run is ${this.provenance}; refusing to record a live result.`);
      }
      if (input.mode === "simulated" && this.provenance !== "simulated") {
        throw new EvidenceError(`Check ${input.scenario}/${input.id} is marked simulated in a ${this.provenance} run.`);
      }
      if (this.provenance === "simulated" && input.mode !== "simulated" && input.mode !== "local") {
        throw new EvidenceError("A simulated run records simulated or local checks only.");
      }
    }
    const record: CheckRecord = redactDeep({
      scenario: input.scenario,
      id: input.id,
      description: cap(input.description, 400) ?? "",
      status: input.status,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.reason ? { reason: cap(input.reason, 500) } : {}),
      ...(input.detail ? { detail: cap(input.detail, MAX_DETAIL_CHARS) } : {}),
      at: input.at ?? this.#now().toISOString(),
    });
    this.#checks.push(record);
    this.#emit("check", record);
    return record;
  }

  pass(scenario: string, id: string, description: string, detail?: string, mode?: CheckMode): CheckRecord {
    return this.check({ scenario, id, description, status: "passed", mode: mode ?? this.defaultMode, detail });
  }

  fail(scenario: string, id: string, description: string, detail?: string, mode?: CheckMode): CheckRecord {
    return this.check({ scenario, id, description, status: "failed", mode: mode ?? this.defaultMode, detail });
  }

  skip(scenario: string, id: string, description: string, reason: string): CheckRecord {
    return this.check({ scenario, id, description, status: "skipped", reason });
  }

  hasCheck(scenario: string, id: string): boolean {
    return this.#checks.some((c) => c.scenario === scenario && c.id === id);
  }

  checksFor(scenario: string): readonly CheckRecord[] {
    return this.#checks.filter((c) => c.scenario === scenario);
  }

  /* ---------------------------------- steps ---------------------------------- */

  /** Time `fn`; record the step as passed or failed and rethrow on failure. A returned `{ detail }` becomes the step's detail. */
  async runStep<T>(scenario: string, id: string, title: string, fn: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const started = this.#now();
    try {
      const out = await fn();
      const detail = out !== null && typeof out === "object" && typeof (out as { detail?: unknown }).detail === "string" ? ((out as unknown as { detail: string }).detail) : undefined;
      this.#pushStep({ scenario, id, title, status: "passed", startedAt: started.toISOString(), durationMs: this.#now().getTime() - started.getTime(), ...(detail ? { detail } : {}) });
      return out;
    } catch (err) {
      this.#pushStep({
        scenario,
        id,
        title,
        status: "failed",
        startedAt: started.toISOString(),
        durationMs: this.#now().getTime() - started.getTime(),
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  stepDetail(scenario: string, id: string, detail: string): void {
    const step = this.#steps.find((s) => s.scenario === scenario && s.id === id);
    if (step) step.detail = redactDeep(cap(detail, MAX_DETAIL_CHARS)) as string;
  }

  skipStep(scenario: string, id: string, title: string, reason: string): void {
    this.#assertOpen();
    this.#pushStep({ scenario, id, title, status: "skipped", startedAt: this.#now().toISOString(), durationMs: 0, reason });
  }

  #pushStep(step: StepRecord): void {
    step = redactAcceptance(step, this.#o.secrets);
    const record = redactDeep({ ...step, ...(step.detail ? { detail: cap(step.detail, MAX_DETAIL_CHARS) } : {}) });
    this.#steps.push(record);
    this.#emit("step", record);
  }

  /* ------------------------------- other evidence ----------------------------- */

  operation(scenario: string, op: { operationId: string; capability?: string; status?: string; detail?: string }): void {
    op = redactAcceptance(op, this.#o.secrets);
    this.#assertOpen();
    const record: OperationRecordEntry = redactDeep({ scenario, ...op, at: this.#now().toISOString() });
    this.#operations.push(record);
    this.#emit("operation", record);
  }

  planDigest(scenario: string, label: string, digest: string): void {
    label = redactAcceptance(label, this.#o.secrets);
    digest = redactAcceptance(digest, this.#o.secrets);
    this.#assertOpen();
    const record: PlanDigestEntry = redactDeep({ scenario, label, digest, at: this.#now().toISOString() });
    this.#digests.push(record);
    this.#emit("plan_digest", record);
  }

  httpProbe(scenario: string, probe: Omit<HttpProbeEntry, "scenario" | "at">): void {
    probe = redactAcceptance(probe, this.#o.secrets);
    this.#assertOpen();
    const record: HttpProbeEntry = redactDeep({
      scenario,
      ...probe,
      ...(probe.bodySnippet !== undefined ? { bodySnippet: cap(probe.bodySnippet, MAX_BODY_CHARS) } : {}),
      ...(probe.error !== undefined ? { error: cap(probe.error, 400) } : {}),
      at: this.#now().toISOString(),
    });
    this.#probes.push(record);
    this.#emit("http_probe", record);
  }

  /** Log lines are redacted and bounded: at most 500 lines of 2,000 characters. */
  logQuery(scenario: string, q: { source: string; query: string; lines: readonly string[] }): void {
    q = redactAcceptance(q, this.#o.secrets);
    this.#assertOpen();
    const lines = q.lines.slice(0, MAX_LOG_LINES).map((l) => cap(String(l), MAX_LINE_CHARS) ?? "");
    const record: LogQueryEntry = redactDeep({ scenario, source: q.source, query: cap(q.query, 400) ?? "", lines, truncated: q.lines.length > MAX_LOG_LINES, at: this.#now().toISOString() });
    this.#logs.push(record);
    this.#emit("log_query", record);
  }

  note(text: string, scenario?: string): void {
    text = redactAcceptance(text, this.#o.secrets);
    this.#assertOpen();
    const record = redactDeep({ at: this.#now().toISOString(), ...(scenario ? { scenario } : {}), text: cap(text, MAX_DETAIL_CHARS) ?? "" });
    this.#notes.push(record);
    this.#emit("note", record);
  }

  /* --------------------------------- summary --------------------------------- */

  summary(): EvidenceSummary {
    const ranLive = this.#checks.filter((c) => c.status === "passed" && c.mode === "live");
    const ranLocal = this.#checks.filter((c) => c.status === "passed" && c.mode === "local");
    const ranSimulated = this.#checks.filter((c) => c.status === "passed" && c.mode === "simulated");
    const skipped = this.#checks.filter((c) => c.status === "skipped");
    const failed = this.#checks.filter((c) => c.status === "failed");
    const ran = ranLive.length + ranLocal.length + ranSimulated.length + failed.length;
    let verdict: Verdict;
    if (this.provenance === "dry_run") verdict = "dry_run";
    else if (failed.length > 0) verdict = "failed";
    else if (skipped.length > 0 || ran === 0) verdict = "incomplete";
    else verdict = "passed";
    return {
      runId: this.runId,
      startedAt: this.#startedAt,
      finishedAt: this.#now().toISOString(),
      provenance: this.provenance,
      scenarios: [...this.#o.scenarios],
      ...(this.#o.account ? { account: this.#o.account } : {}),
      ...(this.#o.region ? { region: this.#o.region } : {}),
      verdict,
      counts: { passedLive: ranLive.length, passedLocal: ranLocal.length, passedSimulated: ranSimulated.length, failed: failed.length, skipped: skipped.length },
      ranLive,
      ranLocal,
      ranSimulated,
      skipped,
      failed,
      statement: this.#statement(verdict, { live: ranLive.length, local: ranLocal.length, simulated: ranSimulated.length, failed: failed.length, skipped: skipped.length }),
    };
  }

  #statement(verdict: Verdict, n: { live: number; local: number; simulated: number; failed: number; skipped: number }): string {
    if (verdict === "dry_run") return "DRY RUN: no cloud was contacted and nothing was checked. Every check below was skipped on purpose; none of it counts as passed.";
    const parts: string[] = [];
    if (this.provenance === "live") {
      parts.push(n.live > 0 ? (this.#o.account ? `${n.live} check(s) passed LIVE against AWS account ${this.#o.account} in ${this.#o.region ?? "(unknown region)"}.` : `${n.live} check(s) passed against configured live service endpoints; this does not establish an AWS account identity.`) : "NOTHING was verified live: no check ran against a real cloud or service.");
    } else if (this.provenance === "simulated") {
      parts.push("SIMULATED run: the checks used fakes and prove nothing about a real cloud.");
    } else {
      parts.push("No cloud was contacted; this run is local only and says nothing about any real cloud.");
    }
    if (n.local > 0) parts.push(`${n.local} check(s) passed locally (real computation, no cloud).`);
    if (n.simulated > 0) parts.push(`${n.simulated} check(s) passed against simulated fakes.`);
    if (n.failed > 0) parts.push(`${n.failed} check(s) FAILED.`);
    if (n.skipped > 0) parts.push(`${n.skipped} check(s) were SKIPPED and are not passes.`);
    return parts.join(" ");
  }

  /** Write `evidence.json`, `summary.json` and `summary.md`; further records are refused. */
  async finalize(): Promise<EvidenceSummary> {
    await this.init();
    this.#finalized = true;
    const summary = redactDeep(this.summary());
    await this.#drain();
    const full = redactDeep({
      summary,
      steps: this.#steps,
      checks: this.#checks,
      operations: this.#operations,
      planDigests: this.#digests,
      httpProbes: this.#probes,
      logQueries: this.#logs,
      notes: this.#notes,
    });
    await writeFile(path.join(this.dir, "evidence.json"), `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(this.dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(this.dir, "summary.md"), renderSummaryMarkdown(summary, this.#steps), { mode: 0o600 });
    return summary;
  }

  /* -------------------------------- internals -------------------------------- */

  #assertOpen(): void {
    if (this.#finalized) throw new EvidenceError("The evidence record is finalized; nothing more can be added.");
  }

  /** Append one line to events.jsonl; writes are chained so order is preserved. */
  #emit(kind: string, data: unknown): void {
    if (!this.#ready) { this.#pending.push({ kind, data }); return; }
    const line = `${JSON.stringify({ kind, data })}\n`;
    const file = path.join(this.dir, "events.jsonl");
    this.#queue = this.#queue.then(() => appendFile(file, line, { mode: 0o600 })).catch((err: unknown) => { this.#writeError ??= err; });
  }

  async #drain(): Promise<void> {
    await this.#queue;
    if (this.#writeError) throw new EvidenceError("Evidence event writes failed; the durable record is incomplete.");
  }
}

/* --------------------------------- rendering -------------------------------- */

const VERDICT_TEXT: Record<Verdict, string> = {
  passed: "PASSED",
  failed: "FAILED",
  incomplete: "INCOMPLETE",
  dry_run: "DRY RUN (nothing ran)",
};

function checkLines(list: readonly CheckRecord[], withReason: boolean): string[] {
  if (list.length === 0) return ["- none"];
  return list.map((c) => `- ${c.scenario}/${c.id}: ${c.description}${withReason && c.reason ? ` (reason: ${c.reason})` : ""}${c.detail ? ` [${c.detail}]` : ""}`);
}

export function renderSummaryMarkdown(s: EvidenceSummary, steps: readonly StepRecord[] = []): string {
  const out: string[] = [
    `# Acceptance run ${s.runId}`,
    "",
    `Verdict: **${VERDICT_TEXT[s.verdict]}**`,
    "",
    s.statement,
    "",
    `Scenarios: ${s.scenarios.join(", ") || "(none)"}. Provenance: ${s.provenance}.${s.account ? ` Account ${s.account}.` : ""}${s.region ? ` Region ${s.region}.` : ""}`,
    `Started ${s.startedAt}, finished ${s.finishedAt}.`,
    "",
    `## Ran live (${s.ranLive.length})`,
    ...checkLines(s.ranLive, false),
    "",
    `## Ran locally, no cloud (${s.ranLocal.length})`,
    ...checkLines(s.ranLocal, false),
  ];
  if (s.ranSimulated.length > 0) out.push("", `## Ran against simulated fakes (${s.ranSimulated.length})`, ...checkLines(s.ranSimulated, false));
  out.push("", `## Skipped, NOT passed (${s.skipped.length})`, ...checkLines(s.skipped, true), "", `## Failed (${s.failed.length})`, ...checkLines(s.failed, false));
  if (steps.length > 0) {
    out.push("", "## Step timings");
    for (const st of steps) out.push(`- ${st.scenario}/${st.id} ${st.status}${st.status === "skipped" ? "" : ` in ${st.durationMs} ms`}${st.reason ? ` (${st.reason})` : ""}`);
  }
  return `${out.join("\n")}\n`;
}
