#!/usr/bin/env node
/**
 * Capacity test for the Zenith control plane (PROD-OPS-01). Local load generator, Node 22 built-ins only.
 *
 *   node scripts/slo/capacity-test.mjs --self-test
 *       Runs the generator against a tiny in-process HTTP server and checks its own arithmetic. Needs nothing else.
 *
 *   node scripts/slo/capacity-test.mjs --url http://127.0.0.1:3000 --path /api/internal/metrics \
 *        --bearer-file ./.cron-secret --concurrency 16 --duration 30
 *       Closed-loop GET load: `concurrency` workers each issue a request, wait for the answer and issue the next, for
 *       `duration` seconds after a warm-up. Reports sustained requests per second, p50/p95/p99 latency and error rate
 *       (any status >= 400 or a network failure is an error, 429 included, so a throttled run does not look healthy),
 *       and compares them with the PROVISIONAL capacity objective in deploy/slo/slo-definitions.json.
 *
 * Safety: GET only, no bodies, no destructive request. A non-loopback target is refused unless --allow-remote is
 * given, so the script cannot be pointed at someone else's service by accident. The bearer is read from a FILE
 * (never an argument or an environment variable, so it does not reach shell history or process listings).
 *
 * Reporting: with --report the result is posted to `<url>/api/internal/slo/measurements` (bearer required), where it is
 * recorded append-only and shown on the operator SLO page. Without it nothing leaves this machine.
 *
 * Honesty: the number is what THIS machine and THIS target sustained. It is not a production capacity claim, and
 * the target it is compared with is provisional and unapproved.
 *
 * Exit codes: 0 within the provisional target, 1 below it, 2 usage error or a run that could not measure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFINITIONS = path.resolve(HERE, "../../deploy/slo/slo-definitions.json");

/** Nearest-rank quantile; identical to src/lib/slo/sli.ts quantile(). */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Summarise raw samples: [{ ms, ok }] collected over `seconds` of steady load. Pure. */
export function summarize(samples, seconds) {
  const latencies = samples.map((s) => s.ms);
  const errors = samples.filter((s) => !s.ok).length;
  return {
    requests: samples.length,
    errors,
    errorRate: samples.length ? errors / samples.length : 1,
    sustainedRps: seconds > 0 ? samples.length / seconds : 0,
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    p99Ms: quantile(latencies, 0.99),
  };
}

export function meetsObjective(summary, objective) {
  return summary.requests > 0
    && summary.sustainedRps >= objective.minRequestsPerSecond
    && summary.p95Ms !== null && summary.p95Ms <= objective.maxP95Ms
    && summary.errorRate <= objective.maxErrorRate;
}

export function loadObjective() {
  const defs = JSON.parse(readFileSync(DEFINITIONS, "utf8"));
  const o = defs.objectives.find((x) => x.id === "capacity");
  if (!o) throw new Error("deploy/slo/slo-definitions.json has no capacity objective.");
  return { objective: o, definitionVersion: defs.definitionVersion };
}

const isLoopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || host.endsWith(".localhost");

export function parseArgs(argv) {
  const opts = { url: "http://127.0.0.1:3000", path: "/", concurrency: 16, duration: 20, warmup: 3, timeoutMs: 10_000, environment: "local machine", recordedBy: "capacity-test.mjs", selfTest: false, report: false, allowRemote: false };
  const num = (name, v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}.`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`); return argv[++i]; };
    switch (a) {
      case "--url": opts.url = next(); break;
      case "--path": opts.path = next(); break;
      case "--concurrency": opts.concurrency = num(a, next(), 1, 512); break;
      case "--duration": opts.duration = num(a, next(), 1, 3600); break;
      case "--warmup": opts.warmup = num(a, next(), 0, 300); break;
      case "--timeout-ms": opts.timeoutMs = num(a, next(), 100, 120_000); break;
      case "--bearer-file": opts.bearerFile = next(); break;
      case "--environment": opts.environment = next().slice(0, 80); break;
      case "--recorded-by": opts.recordedBy = next().slice(0, 128); break;
      case "--out": opts.out = next(); break;
      case "--min-rps": opts.minRps = num(a, next(), 0.1, 1_000_000); break;
      case "--max-p95-ms": opts.maxP95Ms = num(a, next(), 1, 600_000); break;
      case "--max-error-rate": opts.maxErrorRate = num(a, next(), 0, 1); break;
      case "--self-test": opts.selfTest = true; break;
      case "--report": opts.report = true; break;
      case "--allow-remote": opts.allowRemote = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`Unknown argument ${a}. Use --help.`);
    }
  }
  if (!opts.path.startsWith("/")) throw new Error("--path must start with /.");
  return opts;
}

const HELP = `Usage: node scripts/slo/capacity-test.mjs [--self-test] [--url U] [--path P] [--concurrency N] [--duration S] [--warmup S]
  [--bearer-file F] [--min-rps N] [--max-p95-ms N] [--max-error-rate R] [--environment LABEL] [--out FILE] [--report] [--allow-remote]
Defaults for the thresholds come from the provisional capacity objective in deploy/slo/slo-definitions.json.`;

/** Run the closed-loop load. Returns steady-phase samples only (warm-up discarded). */
export async function runLoad({ target, concurrency, durationSeconds, warmupSeconds, timeoutMs, headers }) {
  const warmEnd = Date.now() + warmupSeconds * 1000;
  const end = warmEnd + durationSeconds * 1000;
  const samples = [];
  let steadyStart = 0;
  async function worker() {
    for (;;) {
      const t0 = Date.now();
      if (t0 >= end) return;
      const started = performance.now();
      let ok = false;
      try {
        const res = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
        await res.arrayBuffer();
        ok = res.status < 400;
      } catch { ok = false; }
      const ms = performance.now() - started;
      if (t0 >= warmEnd) { if (!steadyStart) steadyStart = t0; samples.push({ ms, ok }); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = steadyStart ? (Date.now() - steadyStart) / 1000 : durationSeconds;
  return { samples, seconds: Math.min(seconds, durationSeconds + 1) };
}

async function selfTest() {
  // A server that answers in about 5 ms, so the generator's numbers have known bounds.
  const server = createServer((req, res) => { setTimeout(() => { res.statusCode = 200; res.end("ok"); }, 5); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const failures = [];
  try {
    const { samples, seconds } = await runLoad({ target: `http://127.0.0.1:${port}/`, concurrency: 4, durationSeconds: 2, warmupSeconds: 0.5, timeoutMs: 5000, headers: {} });
    const s = summarize(samples, seconds);
    if (s.requests < 20) failures.push(`expected at least 20 requests, saw ${s.requests}`);
    if (s.errorRate !== 0) failures.push(`expected no errors, saw ${s.errors}`);
    if (!(s.p95Ms >= 4 && s.p95Ms < 1000)) failures.push(`p95 ${s.p95Ms} ms is outside the plausible range for a 5 ms server`);
    if (!(s.sustainedRps > 5)) failures.push(`sustained ${s.sustainedRps} requests/s is implausibly low`);
    const q = summarize([{ ms: 1, ok: true }, { ms: 2, ok: true }, { ms: 3, ok: true }, { ms: 4, ok: false }], 2);
    if (q.p50Ms !== 2 || q.p95Ms !== 4 || q.errorRate !== 0.25 || q.sustainedRps !== 2) failures.push("summarize() arithmetic is wrong");
    if (meetsObjective({ requests: 0, sustainedRps: 0, p95Ms: null, errorRate: 1 }, { minRequestsPerSecond: 1, maxP95Ms: 1, maxErrorRate: 1 })) failures.push("an empty run must never meet the objective");
    console.log(JSON.stringify({ selfTest: failures.length === 0 ? "passed" : "failed", failures, observed: s }, null, 2));
  } finally { server.close(); }
  return failures.length === 0 ? 0 : 2;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.selfTest) return selfTest();

  let base;
  try { base = new URL(opts.url); } catch { console.error("--url is not a valid URL."); return 2; }
  if (!["http:", "https:"].includes(base.protocol)) { console.error("--url must be http or https."); return 2; }
  if (!isLoopback(base.hostname) && !opts.allowRemote) { console.error(`${base.hostname} is not a loopback host. Pass --allow-remote only for a service you operate.`); return 2; }
  if (opts.report && !opts.bearerFile) { console.error("--report needs --bearer-file (the CRON_SECRET value in a file)."); return 2; }

  const headers = {};
  if (opts.bearerFile) {
    let secret;
    try { secret = readFileSync(opts.bearerFile, "utf8").trim(); } catch { console.error("Could not read --bearer-file."); return 2; }
    if (!secret) { console.error("--bearer-file is empty."); return 2; }
    headers.authorization = `Bearer ${secret}`;
  }

  const { objective, definitionVersion } = loadObjective();
  const effective = {
    minRequestsPerSecond: opts.minRps ?? objective.minRequestsPerSecond,
    maxP95Ms: opts.maxP95Ms ?? objective.maxP95Ms,
    maxErrorRate: opts.maxErrorRate ?? objective.maxErrorRate,
  };
  const target = new URL(opts.path, base).toString();
  const measuredAt = new Date();
  console.error(`Loading ${target} with ${opts.concurrency} workers: ${opts.warmup}s warm-up then ${opts.duration}s measured.`);
  const { samples, seconds } = await runLoad({ target, concurrency: opts.concurrency, durationSeconds: opts.duration, warmupSeconds: opts.warmup, timeoutMs: opts.timeoutMs, headers });
  if (samples.length === 0) { console.error("No requests completed; nothing was measured."); return 2; }
  const summary = summarize(samples, seconds);
  const meets = meetsObjective(summary, effective);
  const result = {
    label: "Provisional, not approved",
    definitionVersion,
    target: { url: `${base.origin}${opts.path}`, concurrency: opts.concurrency, durationSeconds: opts.duration },
    objective: effective,
    thresholdsOverridden: opts.minRps !== undefined || opts.maxP95Ms !== undefined || opts.maxErrorRate !== undefined,
    summary,
    meetsProvisionalTarget: meets,
    measuredAt: measuredAt.toISOString(),
    environment: opts.environment,
  };
  console.log(JSON.stringify(result, null, 2));
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);

  if (opts.report) {
    const res = await fetch(new URL("/api/internal/slo/measurements", base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "capacity", sustainedRps: summary.sustainedRps, p95Ms: summary.p95Ms, errorRate: summary.errorRate, durationSeconds: opts.duration, concurrency: opts.concurrency, environment: opts.environment, measuredAt: measuredAt.toISOString(), recordedBy: opts.recordedBy }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!res || res.status !== 201) { console.error(`Report was not recorded (${res ? `HTTP ${res.status}` : "no answer"}).`); return 2; }
    console.error("Report recorded.");
  }
  return meets ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; });
}
