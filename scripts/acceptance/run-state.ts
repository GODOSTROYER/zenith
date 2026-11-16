/**
 * The run-state file: what a live run created that a later cleanup must know
 * about and cannot discover from tags alone.
 *
 * Written next to the evidence (`<out>/<runId>/run-state.json`) as soon as a
 * scenario creates something, so a crash, a kill or a lost terminal does not
 * lose it. It holds identifiers only (environment ids, state bucket, DNS record
 * names): no credentials, no values.
 *
 * Why it exists: Route53 records cannot be found through the tagging API, and
 * the `zenith:live-run` tag is applied to Zenith-created resources by the
 * harness after the fact (see `adopt.ts`), so cleanup needs the environment ids
 * to adopt anything that was created but not yet tagged when the run died.
 *
 * The file is read back as untrusted input: it is validated strictly and
 * refused when it names a different run, account or region than the caller.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ENVIRONMENT_ID_PATTERN } from "@/lib/credentials/aws/naming";
import { RUN_ID_PATTERN } from "./safety";

const RunStateSchema = z
  .object({
    schema: z.literal(1),
    runId: z.string().regex(RUN_ID_PATTERN),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    createdAt: z.string(),
    /** Zenith environment ids this run created; their resources are adopted into the run */
    environmentIds: z.array(z.string().regex(ENVIRONMENT_ID_PATTERN)).max(20),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    stateBucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
    /** Route53 records the run's deployment created (records cannot be tagged) */
    dnsRecords: z
      .array(z.object({ zoneId: z.string().regex(/^Z[A-Z0-9]{1,30}$/), name: z.string().max(253), type: z.enum(["A", "AAAA", "CNAME", "TXT"]) }).strict())
      .max(50)
      .optional(),
  })
  .strict();

export type RunState = z.infer<typeof RunStateSchema>;

export const RUN_STATE_FILE = "run-state.json";

// Separate from the environment inventory: scenarios may rewrite that inventory,
// but must never erase an unresolved external mutation. There is deliberately no
// caller-controlled "quiescent" flag or automatic clearance API.
const CleanupBlockSchema = z.object({
  schema: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  accountId: z.string().regex(/^\d{12}$/).optional(),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).optional(),
  status: z.literal("blocked"),
  reason: z.literal("provider_quiescence_unverified"),
}).strict();
export type CleanupBlock = z.infer<typeof CleanupBlockSchema>;
export const cleanupBlockPath = (stateFile: string): string => `${stateFile}.cleanup-block.json`;

export class CleanupAdmissionError extends Error {
  readonly code = "cleanup_resolution_required";
  constructor() {
    super("Destructive cleanup requires authoritative resolution of submitted mutations and worker/provider quiescence; terminal operation status is insufficient.");
    this.name = "CleanupAdmissionError";
  }
}

type CleanupIdentity = { runId: string; accountId?: string; region?: string };

export async function readCleanupBlock(stateFile: string, expect: CleanupIdentity): Promise<CleanupBlock | undefined> {
  let text: string;
  try { text = await readFile(cleanupBlockPath(stateFile), "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CleanupAdmissionError();
  }
  try {
    const block = CleanupBlockSchema.parse(JSON.parse(text));
    if (block.runId !== expect.runId || (expect.accountId !== undefined && block.accountId !== expect.accountId) || (expect.region !== undefined && block.region !== expect.region)) throw new CleanupAdmissionError();
    return block;
  } catch { throw new CleanupAdmissionError(); }
}

/** Persist BEFORE dispatch. A crash or lost response leaves the same blocker.
 * An existing or partially written marker is revalidated, never overwritten. */
export async function blockRunCleanup(stateFile: string, identity: CleanupIdentity): Promise<void> {
  try {
    const block = CleanupBlockSchema.parse({ schema: 1, ...identity, status: "blocked", reason: "provider_quiescence_unverified" });
    await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    try { await writeFile(cleanupBlockPath(stateFile), `${JSON.stringify(block, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!await readCleanupBlock(stateFile, identity)) throw new CleanupAdmissionError();
    }
  } catch { throw new CleanupAdmissionError(); }
}

export class RunStateError extends Error {
  readonly code = "run_state_invalid";
}

export function newRunState(input: { runId: string; accountId: string; region: string; now?: Date }): RunState {
  return RunStateSchema.parse({ schema: 1, runId: input.runId, accountId: input.accountId, region: input.region, createdAt: (input.now ?? new Date()).toISOString(), environmentIds: [] });
}

export function parseRunState(raw: unknown): RunState {
  const parsed = RunStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RunStateError(`The run-state file is not valid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join(", ")}.`);
  }
  return parsed.data;
}

export function runStatePath(evidenceParent: string, runId: string): string {
  return path.join(evidenceParent, runId, RUN_STATE_FILE);
}

/** Write atomically (temp file, then rename) so a crash never leaves half a file. */
export async function writeRunState(file: string, state: RunState): Promise<void> {
  parseRunState(state);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** Read and validate; `undefined` when there is no file. Throws `RunStateError` for a file that does not match the caller. */
export async function readRunState(file: string, expect: { runId: string; accountId?: string; region?: string }): Promise<RunState | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RunStateError("The run-state file is not JSON.");
  }
  const state = parseRunState(json);
  if (state.runId !== expect.runId) throw new RunStateError(`The run-state file belongs to ${state.runId}, not ${expect.runId}.`);
  if (expect.accountId && state.accountId !== expect.accountId) throw new RunStateError("The run-state file belongs to a different AWS account.");
  if (expect.region && state.region !== expect.region) throw new RunStateError("The run-state file belongs to a different region.");
  return state;
}

/** Add an environment id to the state (idempotent) and persist it. */
export async function recordEnvironment(file: string, state: RunState, environmentId: string): Promise<RunState> {
  if (state.environmentIds.includes(environmentId)) return state;
  const next = parseRunState({ ...state, environmentIds: [...state.environmentIds, environmentId] });
  await writeRunState(file, next);
  return next;
}
