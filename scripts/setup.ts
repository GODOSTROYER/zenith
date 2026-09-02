/**
 * `npm run setup` — one command between `git clone` and a running Orrery.
 *
 * It reports rather than requires: Node and Docker are checked and named, but
 * nothing here refuses to finish. Everything it does is idempotent and
 * non-destructive — an existing .env.local is never overwritten, and an
 * existing database is never re-seeded (seeding wipes the data directory, so
 * "the directory already has a state.json" is a hard stop, not a prompt).
 *
 * Run: npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isSupabaseConfigured } from "../src/lib/supabase/env";

const root = process.cwd();
const ENV_FILE = path.join(root, ".env.local");
const ENV_EXAMPLE = path.join(root, ".env.local.example");

const ok = (msg: string) => console.log(`✓ ${msg}`);
const note = (msg: string) => console.log(`! ${msg}`);
/** A problem and the way out, always together. */
const problem = (msg: string, fix: string) => console.log(`✗ ${msg}\n  Fix: ${fix}`);

/* ------------------------------- environment ------------------------------- */

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) return ok(`Node v${process.versions.node}`);
  problem(
    `Node v${process.versions.node} is too old — Orrery needs 20 or newer.`,
    "Install Node 20+ from https://nodejs.org (or `nvm install 22`), then run `npm install && npm run setup` again."
  );
}

/** Optional everywhere: `npm run dev` never needs Docker. */
function checkDocker(): boolean {
  // `version` round-trips to the daemon; `--version` would only prove the CLI
  // is installed, which is exactly the case that fails later at `compose up`.
  const res = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 6_000,
  });

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    note(
      "Docker not found — that is fine. It is only needed for LocalStack (real S3/SQS) and the container run; install Docker Desktop later if you want either."
    );
    return false;
  }
  if (res.signal || res.error) {
    problem(
      "`docker version` did not answer within 6s — the daemon is wedged or still starting.",
      "On Windows this is usually the stale-socket crash: quit Docker Desktop, rename %LOCALAPPDATA%\\Docker\\run to run.stale, relaunch. See docs/RUNNING.md → Troubleshooting. Orrery runs without it."
    );
    return false;
  }
  if (res.status !== 0) {
    note("Docker is installed but the daemon is not running — start Docker Desktop when you want LocalStack or the container run.");
    return false;
  }
  ok(`Docker daemon ${res.stdout.trim()}`);
  return true;
}

/* --------------------------------- .env.local ------------------------------- */

function ensureEnvFile(): void {
  if (fs.existsSync(ENV_FILE)) return ok(".env.local already exists — left untouched.");
  if (!fs.existsSync(ENV_EXAMPLE))
    return problem(
      ".env.local.example is missing, so there is nothing to copy from.",
      "Restore it from git (`git checkout .env.local.example`) and run `npm run setup` again. Orrery still starts without .env.local — every variable in it is optional."
    );
  fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  ok("created .env.local from .env.local.example — every value in it is optional and blank by design.");
}

/* ---------------------------------- seeding --------------------------------- */

/**
 * Seed only into a directory with no database in it. `npm run seed` calls
 * resetDb() and wipes what is there, so an existing state.json means somebody
 * has work here and setup must not touch it.
 */
function seedIfEmpty(): void {
  const dir = path.resolve(process.env.ORRERY_DATA?.trim() || path.join(root, ".data"));
  if (fs.existsSync(path.join(dir, "state.json")))
    return ok(`data directory ${dir} already has a database — not re-seeding (that would wipe it).`);

  console.log(`… seeding the demo workspace into ${dir}`);
  // npm is npm.cmd on Windows, which Node refuses to spawn without a shell.
  // Passed as one string rather than a command plus args array: with `shell`
  // set, an args array is concatenated unescaped and Node deprecates it.
  const res = spawnSync("npm run seed", { stdio: "inherit", shell: true });
  if (res.status === 0) return ok('seeded the "Kepler Labs" demo workspace.');
  problem(
    `seeding failed (npm run seed exited ${res.status ?? "on a signal"}).`,
    "Read the output above. Most often it is a stale .data directory — delete it and run `npm run seed` again. Orrery also starts empty and walks you through /onboarding."
  );
}

/* --------------------------------- next steps ------------------------------- */

function nextSteps(dockerUp: boolean): void {
  const steps = [["npm run dev", "start Orrery on http://localhost:3400"]];

  if (isSupabaseConfigured())
    steps.push(["npm run seed:users", "create the shared test accounts (Supabase keys are configured)"]);
  else
    steps.push([
      "(optional) add Supabase keys to .env.local",
      "sign-in and multi-user; without them Orrery runs as a single local admin",
    ]);

  if (dockerUp)
    steps.push(["npm run localstack:up", "start LocalStack, so S3 buckets and SQS queues provision for real"]);

  steps.push(["npm run doctor", "re-check everything above at any time"]);

  const width = Math.max(...steps.map(([cmd]) => cmd.length));
  console.log("\nNext:\n");
  for (const [cmd, why] of steps) console.log(`  ${cmd.padEnd(width)}   # ${why}`);
  console.log("\nFull instructions: docs/RUNNING.md");
}

/* ----------------------------------- main ----------------------------------- */

console.log("\nOrrery setup\n");
checkNode();
const dockerUp = checkDocker();
ensureEnvFile();
seedIfEmpty();
nextSteps(dockerUp);
