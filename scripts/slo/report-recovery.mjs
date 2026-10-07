#!/usr/bin/env node
/**
 * Report a restore rehearsal's measured instants to the control plane (PROD-OPS-01). Node 22 built-ins only.
 *
 *   node scripts/slo/report-recovery.mjs --url https://zenith.example --bearer-file ./.cron-secret \
 *     --failure-at 2026-10-07T10:00:00Z --data-through 2026-10-07T09:56:30Z --restored-at 2026-10-07T10:42:10Z \
 *     --recorded-by rehearsal-runner --reference rehearsal-2026-10-07
 *
 * The server derives RPO (failure minus newest recovered write) and RTO (restore minus failure) from the three
 * instants and records both, append-only, against the provisional targets. Use `--dry-run` to print the derived
 * numbers locally without contacting anything. A restore rehearsal (PROD-OPS-04) calls the same endpoint, or
 * `reportRecoveryRehearsal` in src/lib/slo/recovery.ts when it runs inside the app.
 *
 * The bearer (CRON_SECRET) is read from a file, never an argument. A non-loopback --url needs --allow-remote.
 * Exit codes: 0 recorded (or dry run), 2 usage error or not recorded.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Same arithmetic as computeRecovery() in src/lib/slo/recovery.ts. */
export function derive(failureAt, dataThrough, restoredAt) {
  const f = Date.parse(failureAt);
  const d = Date.parse(dataThrough);
  const r = Date.parse(restoredAt);
  if ([f, d, r].some(Number.isNaN)) throw new Error("--failure-at, --data-through and --restored-at must be ISO times with a zone (for example 2026-10-07T10:00:00Z).");
  if (d > f) throw new Error("--data-through cannot be after --failure-at.");
  if (r < f) throw new Error("--restored-at cannot be before --failure-at.");
  return { rpoSeconds: (f - d) / 1000, rtoSeconds: (r - f) / 1000 };
}

const isLoopback = (h) => h === "localhost" || h === "[::1]" || /^127\./.test(h) || h.endsWith(".localhost");

async function main(argv) {
  const o = { source: "restore-rehearsal", recordedBy: "report-recovery.mjs" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`); return argv[++i]; };
    if (a === "--url") o.url = next();
    else if (a === "--bearer-file") o.bearerFile = next();
    else if (a === "--failure-at") o.failureAt = next();
    else if (a === "--data-through") o.dataThrough = next();
    else if (a === "--restored-at") o.restoredAt = next();
    else if (a === "--recorded-by") o.recordedBy = next();
    else if (a === "--reference") o.reference = next();
    else if (a === "--source") o.source = next();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--allow-remote") o.allowRemote = true;
    else throw new Error(`Unknown argument ${a}.`);
  }
  if (!["restore-rehearsal", "recovery-drill"].includes(o.source)) throw new Error("--source must be restore-rehearsal or recovery-drill.");
  if (!o.failureAt || !o.dataThrough || !o.restoredAt) throw new Error("--failure-at, --data-through and --restored-at are required.");
  const derived = derive(o.failureAt, o.dataThrough, o.restoredAt);
  if (o.dryRun) { console.log(JSON.stringify({ dryRun: true, ...derived }, null, 2)); return 0; }
  if (!o.url || !o.bearerFile) throw new Error("--url and --bearer-file are required unless --dry-run.");
  const base = new URL(o.url);
  if (!isLoopback(base.hostname) && !o.allowRemote) throw new Error(`${base.hostname} is not a loopback host. Pass --allow-remote for a deployment you operate.`);
  const secret = readFileSync(o.bearerFile, "utf8").trim();
  if (!secret) throw new Error("--bearer-file is empty.");
  const res = await fetch(new URL("/api/internal/slo/measurements", base), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "recovery", source: o.source, failureAt: new Date(o.failureAt).toISOString(), dataRecoveredThrough: new Date(o.dataThrough).toISOString(), serviceRestoredAt: new Date(o.restoredAt).toISOString(), recordedBy: o.recordedBy, ...(o.reference ? { reference: o.reference } : {}) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res || res.status !== 201) { console.error(`Not recorded (${res ? `HTTP ${res.status}` : "no answer"}).`); return 2; }
  console.log(JSON.stringify({ recorded: true, ...derived }, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; });
