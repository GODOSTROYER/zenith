/**
 * Resumable checkpoints for long harness runs (PROD-REL-04).
 *
 * A checkpoint is one small JSON file per run, written atomically (temp file + rename) after every
 * step. It records which steps finished, which was in flight, every decision a person made, and the
 * EXACT next commands an operator would type to continue, so a lost terminal, a reboot or a handover
 * never loses the thread. It deliberately does NOT claim unattended work:
 *
 *  - `unattendedClaims` is the literal `false`; nothing here says a run progressed by itself.
 *  - an `in_progress` step found on resume is never assumed finished: it is reported as `interrupted`
 *    and the harness must reconcile it (re-run it idempotently or inspect the cloud) before going on.
 *  - a checkpoint pins the scope manifest digest; resuming under a different (or unapproved-then-edited)
 *    scope is refused, so a resumed run can never outlive the permission that started it.
 *  - it holds identifiers, digests and statuses only: no credentials, no secret values, no file contents.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CHECKPOINT_FORMAT = "zenith.run-checkpoint.v1" as const;
export const STEP_STATUSES = ["pending", "in_progress", "done", "failed", "skipped", "interrupted"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export type CheckpointErrorCode = "unreadable" | "invalid" | "scope_changed" | "run_mismatch" | "unknown_step" | "illegal_transition" | "unsafe_command";
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

const Step = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/),
  status: z.enum(STEP_STATUSES),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** a short, non-secret outcome note */
  note: z.string().max(400).nullable(),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  attempts: z.number().int().nonnegative(),
}).strict();

const Schema = z.object({
  format: z.literal(CHECKPOINT_FORMAT),
  runId: z.string().min(4).max(120),
  harness: z.string().min(1).max(80),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  updatedAt: z.string(),
  unattendedClaims: z.literal(false),
  steps: z.array(Step).max(200),
  decisions: z.array(z.object({ at: z.string(), by: z.string().max(120), text: z.string().max(500) }).strict()).max(200),
  nextCommands: z.array(z.string().max(500)).max(20),
}).strict();
export type Checkpoint = z.infer<typeof Schema>;
export type CheckpointStep = z.infer<typeof Step>;

/** Commands are shown to people to copy; refuse anything that would embed a secret value. */
const SECRET_ASSIGNMENT = /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=(?!\/|\.|<|\$)[^\s]{8,}/;
const SECRET_FLAG = /--(?:token|password|secret|api-key)(?:=|\s+)(?!<|\$)[^\s-][^\s]{7,}/i;
export function assertSafeCommand(command: string): string {
  if (SECRET_ASSIGNMENT.test(command) || SECRET_FLAG.test(command) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(command)) {
    throw new CheckpointError("unsafe_command", "A next command must name credential FILES, never carry a secret value.");
  }
  return command;
}

export interface CheckpointStore {
  readonly file: string;
  read(): Checkpoint | undefined;
  write(checkpoint: Checkpoint): void;
}

export function fileStore(file: string): CheckpointStore {
  return {
    file,
    read() {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new CheckpointError("unreadable", "The checkpoint file could not be read.");
      }
      try { return Schema.parse(JSON.parse(text)); } catch { throw new CheckpointError("invalid", "The checkpoint file is malformed; it will not be trusted or overwritten."); }
    },
    write(checkpoint) {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}

export function memoryStore(): CheckpointStore & { snapshot(): Checkpoint | undefined } {
  let value: Checkpoint | undefined;
  return {
    file: "(memory)",
    read: () => (value ? (JSON.parse(JSON.stringify(value)) as Checkpoint) : undefined),
    write: (c) => { value = JSON.parse(JSON.stringify(c)) as Checkpoint; },
    snapshot: () => value,
  };
}

const LEGAL: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["in_progress", "skipped"],
  in_progress: ["done", "failed", "interrupted", "skipped"],
  interrupted: ["in_progress", "failed", "skipped", "done"],
  failed: ["in_progress", "skipped"],
  done: [],
  skipped: [],
};

export class RunCheckpoint {
  #state: Checkpoint;
  readonly #store: CheckpointStore;
  readonly #now: () => Date;

  private constructor(state: Checkpoint, store: CheckpointStore, now: () => Date) {
    this.#state = state;
    this.#store = store;
    this.#now = now;
  }

  /**
   * Start a new checkpoint, or resume the one in the store. Resuming requires the same run id, harness and scope
   * digest. A step left `in_progress` by a dead process becomes `interrupted` (never `done`).
   */
  static open(input: { store: CheckpointStore; runId: string; harness: string; scopeDigest: string; steps: readonly string[]; now?: () => Date }): { checkpoint: RunCheckpoint; resumed: boolean; interrupted: string[] } {
    const now = input.now ?? (() => new Date());
    const existing = input.store.read();
    if (!existing) {
      const at = now().toISOString();
      const state: Checkpoint = {
        format: CHECKPOINT_FORMAT, runId: input.runId, harness: input.harness, scopeDigest: input.scopeDigest, createdAt: at, updatedAt: at, unattendedClaims: false,
        steps: input.steps.map((id) => ({ id, status: "pending", startedAt: null, endedAt: null, note: null, evidenceDigest: null, attempts: 0 })), decisions: [], nextCommands: [],
      };
      const cp = new RunCheckpoint(state, input.store, now);
      cp.#save();
      return { checkpoint: cp, resumed: false, interrupted: [] };
    }
    if (existing.runId !== input.runId || existing.harness !== input.harness) throw new CheckpointError("run_mismatch", "The checkpoint belongs to a different run or harness.");
    if (existing.scopeDigest !== input.scopeDigest) throw new CheckpointError("scope_changed", "The scope manifest changed since this run started; start a new run under the current approval.");
    const known = new Set(existing.steps.map((s) => s.id));
    const interrupted: string[] = [];
    for (const step of existing.steps) {
      if (step.status === "in_progress") {
        step.status = "interrupted";
        step.note = "The process ended while this step was running; reconcile before continuing.";
        interrupted.push(step.id);
      }
    }
    for (const id of input.steps) {
      if (!known.has(id)) existing.steps.push({ id, status: "pending", startedAt: null, endedAt: null, note: null, evidenceDigest: null, attempts: 0 });
    }
    const cp = new RunCheckpoint(existing, input.store, now);
    cp.#save();
    return { checkpoint: cp, resumed: true, interrupted };
  }

  get state(): Readonly<Checkpoint> { return this.#state; }

  #step(id: string): CheckpointStep {
    const step = this.#state.steps.find((s) => s.id === id);
    if (!step) throw new CheckpointError("unknown_step", `Step "${id}" is not part of this run.`);
    return step;
  }

  #save(): void {
    this.#state.updatedAt = this.#now().toISOString();
    this.#store.write(this.#state);
  }

  #move(id: string, to: StepStatus, note?: string, evidenceDigest?: string): void {
    const step = this.#step(id);
    if (!LEGAL[step.status].includes(to)) throw new CheckpointError("illegal_transition", `Step "${id}" cannot go from ${step.status} to ${to}.`);
    const at = this.#now().toISOString();
    if (to === "in_progress") { step.startedAt = at; step.endedAt = null; step.attempts += 1; }
    else step.endedAt = at;
    step.status = to;
    step.note = note ? note.slice(0, 400) : null;
    if (evidenceDigest) step.evidenceDigest = evidenceDigest;
    this.#save();
  }

  begin(id: string): void { this.#move(id, "in_progress"); }
  complete(id: string, note?: string, evidenceDigest?: string): void { this.#move(id, "done", note, evidenceDigest); }
  fail(id: string, note: string): void { this.#move(id, "failed", note); }
  skip(id: string, reason: string): void { this.#move(id, "skipped", reason); }

  decide(by: string, text: string): void {
    this.#state.decisions.push({ at: this.#now().toISOString(), by: by.slice(0, 120), text: text.slice(0, 500) });
    this.#save();
  }

  /** The exact commands to continue. Replaces the previous list; refuses anything carrying a secret value. */
  setNextCommands(commands: readonly string[]): void {
    this.#state.nextCommands = commands.map(assertSafeCommand);
    this.#save();
  }

  /** Steps a resumed run still has to do, in order: pending, interrupted and failed. `done` and `skipped` are not repeated. */
  remaining(): string[] {
    return this.#state.steps.filter((s) => s.status === "pending" || s.status === "interrupted" || s.status === "failed").map((s) => s.id);
  }

  summary(): { done: string[]; skipped: string[]; failed: string[]; interrupted: string[]; pending: string[]; complete: boolean } {
    const by = (status: StepStatus) => this.#state.steps.filter((s) => s.status === status).map((s) => s.id);
    const pending = this.#state.steps.filter((s) => s.status === "pending" || s.status === "in_progress").map((s) => s.id);
    return { done: by("done"), skipped: by("skipped"), failed: by("failed"), interrupted: by("interrupted"), pending, complete: this.#state.steps.every((s) => s.status === "done" || s.status === "skipped") };
  }
}
