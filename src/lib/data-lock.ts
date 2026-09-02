/**
 * Assert the single-process assumption the store is built on.
 *
 * `lib/db/store.ts` keeps the whole database in memory and rewrites
 * `state.json` wholesale on save. Two processes against one data directory
 * therefore do not merge — the last save wins and the other process's writes
 * are gone, with nothing in the UI to suggest it happened. `npm run dev` in
 * one terminal and `npm run smoke` in another is all it takes.
 *
 * So: claim the directory with a pid file at boot, and refuse to start when
 * someone else holds it. The error names the running pid, the directory both
 * processes resolved to, and the way out.
 *
 * ponytail: a pid file, not a real lock. It cannot survive a machine with two
 * containers sharing a volume (different pid namespaces, same directory).
 * Upgrade path is an exclusive open of the state file itself, or moving off
 * whole-file rewrites — both bigger than this problem is today.
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = ".orrery.lock";

interface Holder {
  pid: number;
  startedAt: string;
  /** the working directory that produced this data dir — see resolve note below */
  cwd: string;
}

/** True when a process with this pid exists and we are allowed to see it. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 tests existence without delivering anything
    return true;
  } catch (err) {
    // EPERM: it exists, it just is not ours. Anything else: gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function read(file: string): Holder | null {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")) as Holder;
    return typeof h?.pid === "number" ? h : null;
  } catch {
    return null; // missing, truncated, or hand-edited — treat as unheld
  }
}

/**
 * Claim `dataDir` for this process. Throws if another live process holds it.
 *
 * Idempotent within a process, so it is safe on a boot path that Next.js may
 * run more than once (HMR, route warm-up).
 */
export function claimDataDir(dataDir: string): void {
  const dir = path.resolve(dataDir);
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const held = read(file);
  if (held && held.pid !== process.pid && alive(held.pid)) {
    throw new Error(
      `Another Orrery process (pid ${held.pid}, started ${held.startedAt}) is already using the data directory ${dir}. ` +
        `Orrery keeps the whole database in memory and rewrites it on save, so a second process would silently overwrite the first one's writes. ` +
        `Fix: stop that process, or give this one its own directory with ORRERY_DATA=<path>. ` +
        `If pid ${held.pid} is gone, delete ${file} and start again.` +
        (held.cwd !== process.cwd()
          ? ` (That process ran from ${held.cwd}; this one runs from ${process.cwd()}. ORRERY_DATA is resolved relative to the working directory when it is not absolute, so the two can disagree about where the database lives.)`
          : "")
    );
  }

  if (held?.pid === process.pid) return;

  const holder: Holder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(file, JSON.stringify(holder, null, 2));

  // Best effort: a SIGKILL or a power cut leaves the file behind, which is why
  // the liveness check above exists rather than trusting the file's presence.
  const release = () => {
    try {
      if (read(file)?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* exiting anyway */
    }
  };
  process.once("exit", release);
}
