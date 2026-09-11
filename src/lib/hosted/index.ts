/**
 * Hosted subsystem boot. `ensureBoot()` calls `ensureHosted()` right after
 * the data-directory claim, so the control authority is open — and hosted
 * mode's preconditions are proven — before any route can read hosted state.
 *
 * Hosted mode (`ZENITH_HOSTED_MODE=1`) fails closed: no identity provider,
 * an old Node, or an invalid `ZENITH_*` variable stops the process with the
 * fix in the message rather than serving a private app on guesswork.
 *
 * Outbox handlers are registered by the modules that own the effects
 * (invitation email, revocation ledger, spending alerts); their registration
 * functions are called here before the boot replay so rows left `sending` by
 * a dead process are drained by the right handler.
 */
import { registerAccessOutboxHandlers } from "@/lib/hosted/access";
import { authorityOpen, openAuthority, replayOutbox } from "@/lib/hosted/authority";
import { startHostedJobRunner } from "@/lib/hosted/release";
import { registerOpsOutboxHandlers } from "@/lib/hosted/usage";
import { hostedConfig, hostedMode, hostedStoreKind } from "@/lib/hosted/config";
import { log } from "@/lib/log";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/** `node:sqlite` gained `backup()` and `busy_timeout` handling in 22.16. */
export const MIN_NODE = { major: 22, minor: 16 } as const;

export function nodeMeetsFloor(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10));
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/**
 * Preconditions for serving private apps. Throws with a `Fix:` sentence, the
 * boot-layer error shape from docs/CONTRACTS.md.
 */
export function assertHostedPreconditions(): void {
  hostedConfig(); // validates every ZENITH_* variable, throwing with the offender
  // The authority implementation is chosen here, before `openAuthority()`.
  // Only the SQLite authority exists in this build; the flag parses end to end,
  // so a deployment that asks for Postgres is told at boot instead of finding
  // out from a half-open authority later.
  if (hostedStoreKind() === "postgres")
    throw new Error(
      "ZENITH_HOSTED_STORE=postgres is not available in this build yet. " +
        "Fix: unset ZENITH_HOSTED_STORE (or set it to sqlite) to use the embedded control authority."
    );
  if (!hostedMode()) return;
  if (!isSupabaseConfigured())
    throw new Error(
      "ZENITH_HOSTED_MODE=1 needs an identity provider, and no Supabase keys are set. " +
        "Fix: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, or unset ZENITH_HOSTED_MODE for local demo mode."
    );
  if (!nodeMeetsFloor())
    throw new Error(
      `ZENITH_HOSTED_MODE=1 needs Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer for the SQLite backup API; this process is Node ${process.versions.node}. ` +
        "Fix: upgrade Node (the Docker image and CI already use Node 22)."
    );
}

type G = typeof globalThis & { __zenithHostedBooted?: boolean };

/**
 * Open the authority and replay the outbox. Idempotent per process; safe to
 * call from `ensureBoot()` and from scripts. Synchronous so `boot()` cannot
 * proceed with the authority half-open.
 */
export function ensureHosted(): void {
  const g = globalThis as G;
  if (g.__zenithHostedBooted) return;
  assertHostedPreconditions();
  openAuthority();
  g.__zenithHostedBooted = true;
  registerAccessOutboxHandlers();
  registerOpsOutboxHandlers();
  startHostedJobRunner();
  // Effects the previous process left `sending` (an invite email, a ledger
  // append) are reclaimed and drained — after this tick, so a slow transport
  // never holds boot, and unref'd so it never holds the process open.
  const replay = setTimeout(() => {
    // A test that closed the authority before this tick fired has nothing to replay.
    if (!authorityOpen()) return;
    void replayOutbox().catch((err) =>
      log.error("hosted outbox replay failed", { scope: "hosted", error: err })
    );
  }, 0);
  (replay as { unref?: () => void }).unref?.();
}

