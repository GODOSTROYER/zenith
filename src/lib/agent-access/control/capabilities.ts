/**
 * What this deployment can actually do with an agent, asked of the
 * configuration rather than of a flag somebody set once.
 *
 * Until this file existed the answer came from two lines in `runtime.ts`:
 *
 * ```ts
 * if (process.env.ZENITH_AGENT_CONTROL !== '1' || isServerless()) throw …   // control_disabled
 * if (process.env.ZENITH_AGENT_WRITES  !== '1' || isPostgres())   throw …   // writes_disabled
 * ```
 *
 * Both were honest about the host they were written for and wrong about the
 * one Zenith now runs on. `isServerless()` refused Vercel because a SQLite
 * journal under a per-instance `/tmp` is not durable — true, and still true.
 * `isPostgres()` refused reviewed writes because the application had no
 * DB-enforced claim to put an intent in — true then, and no longer true.
 *
 * So neither guard is deleted and neither becomes configurable. They are
 * **replaced by the question they were standing in for**: is there a durable,
 * DB-enforced place to put an intent, and a credential authority to bind it to?
 *
 * | `ZENITH_STORE` | serverless | `ZENITH_AGENT_CONTROL` | journal reachable | control | writes |
 * |---|---|---|---|---|---|
 * | `file`     | no  | `1`   | —          | yes | yes if `ZENITH_AGENT_WRITES=1` |
 * | `file`     | no  | unset | —          | no  | no |
 * | `file`     | yes | `1`   | —          | no  | no |
 * | `postgres` | any | `1`   | yes        | yes | yes |
 * | `postgres` | any | `1`   | no         | no  | no |
 * | `postgres` | any | unset | yes        | no  | no |
 *
 * Three properties of the old code this keeps on purpose:
 *
 * 1. **`ZENITH_AGENT_CONTROL=1` is still required.** Nothing turns on by
 *    upgrading.
 * 2. **The file mode keeps the process mutation gate as its coordination** —
 *    `withMutationGate` and the pid lock. Neither is distributed, and
 *    `coordination: 'process-gate'` says so to anybody who asks, including
 *    `zenith_get_capabilities`.
 * 3. **Serverless + file is still refused**, which was the honest half of the
 *    original guard.
 *
 * `ZENITH_AGENT_WRITES` keeps its meaning on the file store only. On Postgres,
 * writes follow the scopes on the credential, because that credential was
 * minted through a browser consent that named them; a process-wide flag there
 * would be a second, weaker gate sitting on top of a per-credential one.
 */
import { env } from '@/lib/env';
import { isPostgres } from '@/lib/db/store';
import { isServerless } from '@/lib/serverless';
import { credentialAuthority } from '../authority';
import { ControlError } from './journal';

export interface ControlCapabilities {
  /** 'file' = single-host SQLite journal; 'postgres' = `agent.*` on Supabase. */
  journal: 'file' | 'postgres';
  /** The credential authority actually in use. */
  credentials: 'file' | 'postgres';
  /** DB-enforced claim/lease/fence ('database') or a single process's gate ('process-gate'). */
  coordination: 'process-gate' | 'database';
  /** May prepare and read. */
  control: boolean;
  /** May execute a reviewed operation. */
  writes: boolean;
  /** Why not, in the operator's words. Absent when both are true. */
  reason?: string;
}

/**
 * Where the credential authority lives — asked of the authority itself.
 *
 * `credentialAuthority()` (F1, `authority/index.ts`) is cheap: it holds no
 * connection and opens nothing, so this stays a local fact and
 * `controlCapabilitiesSync()` stays synchronous. Whether that authority is
 * *reachable* is a separate question, and the one every link endpoint asks
 * through `requireCredentialAuthority()`.
 */
function credentialAuthorityKind(): 'file' | 'postgres' {
  return credentialAuthority().kind;
}

/** How the journal reachability probe has turned out so far, this process. */
type ProbeState = { status: 'unknown' } | { status: 'ok' } | { status: 'failed'; error: unknown };

let probeState: ProbeState = { status: 'unknown' };
let probe: Promise<void> | undefined;

/**
 * Ask the `agent` schema whether it is there, once.
 *
 * A failure is remembered and re-thrown to every later caller rather than
 * retried — the same rule `createPostgresAuthority()` follows, and for the same
 * reason: a hundred instances re-checking a schema that is still missing is
 * load the project does not need, and the answer will not change without
 * somebody applying the migration.
 */
async function probeJournal(): Promise<void> {
  if (!probe)
    probe = (async () => {
      try {
        const { pgAgentJournal } = await import('./journal-pg');
        await pgAgentJournal().ready();
        probeState = { status: 'ok' };
      } catch (error) {
        probeState = { status: 'failed', error };
        throw error;
      }
    })();
  return probe;
}

/** Forget the probe. Tests and scripts that move `SUPABASE_DB_URL` under it. */
export function resetCapabilityProbe(): void {
  probe = undefined;
  probeState = { status: 'unknown' };
}

const CONTROL_FIX =
  'Fix: set ZENITH_AGENT_CONTROL=1 on the deployment (production and preview) and redeploy. ' +
  'Agent control is opt-in and nothing enables it by upgrading.';

const SERVERLESS_FILE_FIX =
  'Fix: set ZENITH_STORE=postgres and SUPABASE_DB_URL to the Supavisor transaction-mode pooler URI (port 6543), ' +
  'apply supabase/migrations/0006_agent_link.sql and supabase/migrations/0007_agent_control.sql, and redeploy — ' +
  'or run Zenith on a long-lived single-writer host, where the file journal is durable.';

const JOURNAL_FIX =
  'Fix: set SUPABASE_DB_URL to the Supavisor transaction-mode pooler URI (port 6543) and apply ' +
  'supabase/migrations/0006_agent_link.sql and supabase/migrations/0007_agent_control.sql in the Supabase SQL editor, then redeploy. ' +
  'Both migrations are idempotent. Until the agent schema answers, reviewed operations are refused rather than written somewhere that is not durable.';

const WRITES_FIX =
  'Fix: set ZENITH_AGENT_WRITES=1 on the single-writer file-store host and restart. ' +
  'On ZENITH_STORE=postgres this variable governs nothing: writes follow the scopes on the linked credential, ' +
  'which a person approved in the browser.';

/** The message a refused probe carries, without leaking a connection string. */
function probeReason(error: unknown): string {
  const message = error instanceof ControlError ? error.message : 'The agent control database did not answer.';
  return message.includes('Fix:') ? message : `${message} ${JOURNAL_FIX}`;
}

/**
 * The decision, without the network.
 *
 * Everything in the table except *reachability* is a local fact, so this
 * answers from configuration plus whatever the probe has already established.
 * It exists because two callers cannot await: `catalog()` (which every MCP
 * transport iterates synchronously) and the synchronous `requireControl()` that
 * `browser.ts` and `boundary.ts` call. Both are strictly at least as strict as
 * the guards they replace; the full check, reachability included, is
 * `controlCapabilities()` and it runs on every write path.
 */
export function controlCapabilitiesSync(): ControlCapabilities {
  const postgres = isPostgres();
  const journal: 'file' | 'postgres' = postgres ? 'postgres' : 'file';
  const base: ControlCapabilities = {
    journal,
    credentials: credentialAuthorityKind(),
    coordination: postgres ? 'database' : 'process-gate',
    control: false,
    writes: false,
  };
  if (env().ZENITH_AGENT_CONTROL !== '1') return { ...base, reason: `Agent control is not enabled on this deployment. ${CONTROL_FIX}` };
  if (!postgres && isServerless())
    return {
      ...base,
      reason:
        'Agent control needs a durable journal, and on a serverless host the SQLite journal would live in a per-instance /tmp ' +
        `that is discarded when the instance freezes — so an approved operation could not be found again. ${SERVERLESS_FILE_FIX}`,
    };
  if (postgres) {
    if (!env().SUPABASE_DB_URL) return { ...base, reason: `The agent control journal is configured for Postgres but SUPABASE_DB_URL is not set. ${JOURNAL_FIX}` };
    if (probeState.status === 'failed') return { ...base, reason: probeReason(probeState.error) };
    // Not yet probed: advertise, and let the write path's `controlCapabilities()`
    // be the one that refuses. Kicking the probe off here means the first
    // request converges rather than the tenth.
    if (probeState.status === 'unknown') void probeJournal().catch(() => {});
    return { ...base, control: true, writes: true };
  }
  if (env().ZENITH_AGENT_WRITES !== '1') return { ...base, control: true, reason: `Reviewed writes are not enabled on this host. ${WRITES_FIX}` };
  return { ...base, control: true, writes: true };
}

/**
 * The whole decision, reachability included.
 *
 * On the file store this is `controlCapabilitiesSync()` and no round trip. On
 * Postgres it awaits the remembered schema probe, so a database that is missing
 * `0006`/`0007` — or is simply not answering — **fails closed** with the
 * migration named, rather than accepting an operation it cannot make durable.
 */
export async function controlCapabilities(): Promise<ControlCapabilities> {
  const local = controlCapabilitiesSync();
  if (local.journal !== 'postgres' || !local.control) return local;
  try {
    await probeJournal();
    return local;
  } catch (error) {
    return {
      journal: local.journal, credentials: local.credentials, coordination: local.coordination,
      control: false, writes: false, reason: probeReason(error),
    };
  }
}

/** May this deployment prepare and read at all? Throws `control_disabled` (503). */
export async function requireControl(): Promise<void> {
  const capabilities = await controlCapabilities();
  if (!capabilities.control) throw new ControlError('control_disabled', capabilities.reason ?? CONTROL_FIX, 503);
}

/** May this deployment execute a reviewed operation? Throws `writes_disabled` (503). */
export async function requireWrites(): Promise<void> {
  const capabilities = await controlCapabilities();
  if (!capabilities.control) throw new ControlError('control_disabled', capabilities.reason ?? CONTROL_FIX, 503);
  if (!capabilities.writes) throw new ControlError('writes_disabled', capabilities.reason ?? WRITES_FIX, 503);
}

/** The synchronous half, for the call sites that cannot await. See `controlCapabilitiesSync`. */
export function requireControlSync(): void {
  const capabilities = controlCapabilitiesSync();
  if (!capabilities.control) throw new ControlError('control_disabled', capabilities.reason ?? CONTROL_FIX, 503);
}

/** The synchronous half of the write guard. See `controlCapabilitiesSync`. */
export function requireWritesSync(): void {
  const capabilities = controlCapabilitiesSync();
  if (!capabilities.control) throw new ControlError('control_disabled', capabilities.reason ?? CONTROL_FIX, 503);
  if (!capabilities.writes) throw new ControlError('writes_disabled', capabilities.reason ?? WRITES_FIX, 503);
}
