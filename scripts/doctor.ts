/**
 * `npm run doctor` — what is configured, what is reachable, and what to do
 * about each thing that is not.
 *
 * This is the script you run when the app will not start, so it never throws:
 * a broken environment is a reported line, not a stack trace. Every non-OK
 * line carries its own fix, and the fixes for the secret key and SMTP are
 * imported from lib/env rather than restated, so they cannot drift from what
 * the server itself says at boot.
 *
 * Run: npm run doctor
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decodeSecretKey, SECRET_KEY_FIX, SMTP_FIX } from "../src/lib/env";
import { isSupabaseConfigured, SUPABASE_URL } from "../src/lib/supabase/env";

type Status = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail: string;
  /** Required for warn and fail. A finding without a fix is just a complaint. */
  fix?: string;
}

const MARK: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

/** `.env.local` is loaded by the npm script's --env-file-if-exists flag. */
const val = (key: string): string => (process.env[key] ?? "").trim();

/* --------------------------------- checks ---------------------------------- */

function nodeAndNpm(): Check[] {
  const major = Number(process.versions.node.split(".")[0]);
  const node: Check =
    major >= 20
      ? { label: "Node", status: "ok", detail: `v${process.versions.node}` }
      : {
          label: "Node",
          status: "fail",
          detail: `v${process.versions.node} — Orrery needs 20 or newer (Next 15 and the --env-file flags this repo's scripts use).`,
          fix: "Install Node 20+ from https://nodejs.org (or `nvm install 22`), then re-run.",
        };

  // Already in the environment when launched as `npm run doctor`, which is the
  // documented way to launch it — cheaper and more reliable than spawning npm.
  const agent = /npm\/(\S+)/.exec(process.env.npm_config_user_agent ?? "");
  const npm: Check = agent
    ? { label: "npm", status: "ok", detail: `v${agent[1]}` }
    : {
        label: "npm",
        status: "warn",
        detail: "version unknown — this process was not started by npm.",
        fix: "Run it as `npm run doctor` to report the npm version.",
      };

  return [node, npm];
}

function docker(): Check {
  // Timed out rather than trusted: a wedged Docker Desktop makes the CLI hang
  // indefinitely, and a doctor that hangs is worse than one that says "no".
  // `version` (not `--version`) deliberately: it round-trips to the daemon, so
  // a wedged Docker Desktop is caught here rather than at `docker compose up`.
  const res = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 6_000,
  });

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT")
    return {
      label: "Docker",
      status: "warn",
      detail: "the `docker` command is not on PATH.",
      fix: "Optional. Install Docker Desktop (https://docs.docker.com/get-docker/) if you want LocalStack or the container run; `npm run dev` needs neither.",
    };

  if (res.signal || res.error)
    return {
      label: "Docker",
      status: "warn",
      detail: "`docker version` did not answer within 6s — the daemon is wedged or still starting.",
      fix: "On Windows this is usually the stale-socket crash: quit Docker Desktop, rename %LOCALAPPDATA%\\Docker\\run to run.stale, relaunch. See docs/RUNNING.md → Troubleshooting.",
    };

  if (res.status !== 0)
    return {
      label: "Docker",
      status: "warn",
      detail: "the CLI is installed but the daemon did not answer.",
      fix: "Start Docker Desktop (or `sudo systemctl start docker`) and re-run. Only LocalStack and the container run need it.",
    };

  return { label: "Docker", status: "ok", detail: `daemon ${res.stdout.trim()}` };
}

async function localstack(endpoint: string): Promise<Check> {
  const url = `${endpoint}/_localstack/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!res.ok)
      return {
        label: "LocalStack",
        status: "warn",
        detail: `${url} answered ${res.status} ${res.statusText}.`,
        fix: "It is up but unhealthy — `npm run localstack:logs`, then restart it with `npm run localstack:down && npm run localstack:up`.",
      };
    const body = (await res.json()) as { services?: Record<string, string>; version?: string };
    const svc = body.services ?? {};
    const up = (n: string) => svc[n] === "running" || svc[n] === "available";
    const missing = ["s3", "sqs"].filter((n) => !up(n));
    return missing.length
      ? {
          label: "LocalStack",
          status: "warn",
          detail: `up at ${endpoint}, but ${missing.join(" and ")} not available — those are the two Orrery provisions for real.`,
          fix: "Set SERVICES=s3,sqs on the container (docker-compose.yml already does) and restart it.",
        }
      : {
          label: "LocalStack",
          status: "ok",
          detail: `${body.version ?? "up"} at ${endpoint} — s3 and sqs available.`,
        };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      label: "LocalStack",
      status: "warn",
      detail: timedOut
        ? `${url} did not answer within 2.5s — something holds the port but is not answering.`
        : `nothing answered at ${url}.`,
      fix: "Optional. `npm run localstack:up` starts it. If the port is held by something else, point ORRERY_LOCALSTACK_ENDPOINT elsewhere.",
    };
  }
}

function supabase(): Check {
  if (isSupabaseConfigured())
    return {
      label: "Supabase auth",
      status: "ok",
      detail: `configured (${SUPABASE_URL})${val("SUPABASE_SERVICE_ROLE_KEY") ? ", service-role key present" : ""}.`,
    };
  return {
    label: "Supabase auth",
    status: "warn",
    detail: "not configured — Orrery runs in local demo mode as a single admin user.",
    fix: "Optional. Put NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local (see .env.local.example), then restart the dev server.",
  };
}

function secretKey(): Check {
  const raw = val("ORRERY_SECRET_KEY");
  if (!raw)
    return {
      label: "Secret store",
      status: "warn",
      detail: "ORRERY_SECRET_KEY unset — every secret write is refused (Orrery says so rather than pretending).",
      fix: `Optional. ${SECRET_KEY_FIX}`,
    };
  return decodeSecretKey(raw)
    ? { label: "Secret store", status: "ok", detail: "ORRERY_SECRET_KEY decodes to 32 bytes." }
    : {
        label: "Secret store",
        status: "fail",
        detail: `ORRERY_SECRET_KEY is set (${raw.length} chars, hidden) but does not decode to 32 bytes — the server refuses to boot on this.`,
        fix: SECRET_KEY_FIX,
      };
}

function smtp(): Check {
  const url = val("ORRERY_SMTP_URL");
  const from = val("ORRERY_ALERT_FROM");
  if (!url && !from)
    return {
      label: "Email alerts",
      status: "warn",
      detail: "no SMTP configured — email channels refuse to send. Webhook and Slack channels are unaffected.",
      fix: `Optional. ${SMTP_FIX}`,
    };
  if (!url || !from)
    return {
      label: "Email alerts",
      status: "fail",
      detail: `${url ? "ORRERY_ALERT_FROM" : "ORRERY_SMTP_URL"} is missing — the two are only useful together, so every send is refused.`,
      fix: SMTP_FIX,
    };
  return { label: "Email alerts", status: "ok", detail: `SMTP configured, from ${from}.` };
}

function dataDir(dir: string): Check {
  const resolved = path.resolve(dir);
  const lock = path.join(resolved, ".orrery.lock");

  if (!fs.existsSync(resolved))
    return {
      label: "Data directory",
      status: "warn",
      detail: `${resolved} does not exist yet — it is created on first boot, and holds no demo workspace.`,
      fix: "Run `npm run setup` (or `npm run seed`) to create it with the Kepler Labs demo workspace.",
    };

  interface Holder {
    pid?: number;
    startedAt?: string;
    cwd?: string;
  }
  let holder: Holder | null;
  try {
    holder = JSON.parse(fs.readFileSync(lock, "utf8")) as Holder;
  } catch {
    holder = null; // missing, truncated or hand-edited — all mean "unheld"
  }

  if (typeof holder?.pid !== "number")
    return { label: "Data directory", status: "ok", detail: `${resolved} — no lock holder.` };

  let alive = false;
  try {
    process.kill(holder.pid, 0);
    alive = true;
  } catch (err) {
    alive = (err as NodeJS.ErrnoException).code === "EPERM";
  }

  return alive
    ? {
        label: "Data directory",
        status: "ok",
        detail: `${resolved} — held by pid ${holder.pid} since ${holder.startedAt ?? "?"}${holder.cwd && holder.cwd !== process.cwd() ? ` (started from ${holder.cwd})` : ""}.`,
        fix: "Expected if a dev server is running. A second process against this directory would silently overwrite its writes — give it ORRERY_DATA=<other path>.",
      }
    : {
        // Not a warning: data-lock reclaims a dead holder's file on the next
        // boot, so this is self-healing and nothing is blocked by it.
        label: "Data directory",
        status: "ok",
        detail: `${resolved} — stale lock from dead pid ${holder.pid}, reclaimed automatically on next boot.`,
      };
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  const checks: Check[] = [...nodeAndNpm()];

  // env() throws on an invalid variable. Doctor is what you run *because* it
  // throws, so the failure is a line here and the defaults carry the rest.
  let endpoint = val("ORRERY_LOCALSTACK_ENDPOINT") || "http://localhost:4566";
  let data = val("ORRERY_DATA") || path.join(process.cwd(), ".data");
  try {
    const { env } = await import("../src/lib/env");
    const e = env();
    endpoint = e.ORRERY_LOCALSTACK_ENDPOINT;
    data = e.ORRERY_DATA;
    checks.push({ label: "Environment", status: "ok", detail: "every ORRERY_* variable validates." });
  } catch (err) {
    checks.push({
      label: "Environment",
      status: "fail",
      detail: (err instanceof Error ? err.message : String(err)).split("\n").join(" ").slice(0, 400),
      fix: "Fix the named variables in .env.local (see .env.local.example). The server refuses to boot until they validate.",
    });
  }

  checks.push(docker(), await localstack(endpoint), supabase(), secretKey(), smtp(), dataDir(data));

  const width = Math.max(...checks.map((c) => c.label.length));
  console.log("\nOrrery doctor\n");
  for (const c of checks) {
    console.log(`${MARK[c.status]} ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`${" ".repeat(width + 4)}→ ${c.fix}`);
  }

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn");
  console.log(
    failed.length
      ? `\n${failed.length} blocking problem(s): ${failed.map((c) => c.label).join(", ")}. Orrery will not start until those are fixed.`
      : warned.length
        ? `\nReady to run. ${warned.length} optional feature(s) are off: ${warned.map((c) => c.label).join(", ")}.`
        : "\nEverything configured and reachable."
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ doctor failed unexpectedly:", e instanceof Error ? e.message : e);
  console.error("  Fix: this is a bug in scripts/doctor.ts — report it with the message above.");
  process.exit(1);
});
