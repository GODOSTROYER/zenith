/**
 * `MachineResult.data` shapes, one per operation.
 *
 * This is the contract between the semantic API and everything that produces
 * results: the SSM output parsers, the Kubernetes mappers, the simulated
 * transport, and zenithd (whose wire `result`, RUNNER-PROTOCOL §5, must parse
 * with these schemas — RUNNER-PROTOCOL does not pin field names, so THIS FILE
 * is the definition the Go agent implements against).
 *
 * Conventions:
 *   - a field the transport did not read is ABSENT, never a guess ("unknown is
 *     a valid answer"); required fields are exactly those every transport can
 *     always provide;
 *   - every string and array is bounded so a hostile or buggy agent cannot
 *     return an unbounded structure;
 *   - schemas STRIP unknown keys (zod default), so an agent that adds a field
 *     cannot smuggle it to callers;
 *   - `ok: false` results carry `MachineFailureData` instead.
 */
import { z } from "zod";
import type { ImplementedOperation } from "./args";
import { MAX_OUTPUT_BYTES } from "./limits";

const str = (max = 512) => z.string().max(max);
const nonNeg = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

const disk = z.object({ mount: str(512), sizeKb: count, usedKb: count, availKb: count, usePct: z.number().min(0).max(100).optional() });
const memory = z.object({
  totalKb: count.optional(),
  availableKb: count.optional(),
  swapTotalKb: count.optional(),
  swapFreeKb: count.optional(),
});
const load = z.tuple([nonNeg, nonNeg, nonNeg]);

const containerSummary = z.object({
  id: str(300),
  name: str(200),
  image: str(300).optional(),
  state: str(64).optional(),
  status: str(200).optional(),
  createdAt: str(64).optional(),
  pod: str(253).optional(),
  namespace: str(63).optional(),
  ready: z.boolean().optional(),
  restartCount: count.optional(),
});

const containerState = z.object({
  name: str(200),
  image: str(300).optional(),
  ready: z.boolean().optional(),
  restartCount: count.optional(),
  state: str(64),
  reason: str(200).optional(),
  exitCode: z.number().int().optional(),
  startedAt: str(64).optional(),
});

const execData = z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean().optional() });

export const MachineResultDataSchemas = {
  "machine.inspect": z.object({
    /** OS Inventory is a cached snapshot, not current guest runtime state. */
    inventory: z.object({ state: z.enum(["available", "missing", "inaccessible", "unavailable"]), observedAt: str(64).optional() }).optional(),
    hostname: str(253).optional(),
    os: z.object({ id: str(64).optional(), version: str(64).optional(), pretty: str(200).optional() }).optional(),
    kernel: str(128).optional(),
    arch: str(32).optional(),
    cpuCount: count.optional(),
    uptimeSec: count.optional(),
    load: load.optional(),
    memory: memory.optional(),
    disks: z.array(disk).max(64).optional(),
  }),
  "process.list": z.object({
    processes: z
      .array(
        z.object({
          pid: count,
          ppid: count.optional(),
          user: str(64).optional(),
          cpuPct: nonNeg.optional(),
          memPct: nonNeg.optional(),
          rssKb: count.optional(),
          elapsedSec: count.optional(),
          command: str(256),
        })
      )
      .max(500),
    truncated: z.boolean(),
  }),
  "service.status": z.object({
    unit: str(160),
    loadState: str(64),
    activeState: str(64),
    subState: str(64).optional(),
    unitFileState: str(64).optional(),
    mainPid: count.optional(),
    execMainStatus: z.number().int().optional(),
    restarts: count.optional(),
    result: str(64).optional(),
    since: str(64).optional(),
  }),
  "machine.service.restart": z.object({
    unit: str(160),
    restarted: z.boolean(),
    activeState: str(64),
    subState: str(64).optional(),
    mainPid: count.optional(),
  }),
  "container.list": z.object({ containers: z.array(containerSummary).max(200), truncated: z.boolean() }),
  "container.inspect": z.object({
    id: str(300),
    name: str(200),
    image: str(300).optional(),
    state: str(64),
    running: z.boolean().optional(),
    exitCode: z.number().int().optional(),
    startedAt: str(64).optional(),
    finishedAt: str(64).optional(),
    restartCount: count.optional(),
    health: str(64).optional(),
    oomKilled: z.boolean().optional(),
    // Kubernetes pod view
    namespace: str(63).optional(),
    pod: str(253).optional(),
    node: str(253).optional(),
    phase: str(64).optional(),
    conditions: z.array(z.object({ type: str(64), status: str(16), reason: str(200).optional() })).max(16).optional(),
    containerStatuses: z.array(containerState).max(32).optional(),
  }),
  "container.logs": z.object({
    container: str(200).optional(),
    lines: count,
    content: z.string().max(MAX_OUTPUT_BYTES * 2),
    truncated: z.boolean(),
    redacted: z.boolean().optional(),
  }),
  "container.exec": execData,
  "file.read": z.object({
    path: str(1024),
    sizeBytes: count.optional(),
    bytesRead: count,
    truncated: z.boolean(),
    encoding: z.literal("utf8"),
    content: z.string().max(MAX_OUTPUT_BYTES * 2),
    binary: z.boolean().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    redacted: z.boolean().optional(),
  }),
  "network.portCheck": z.object({
    host: str(253),
    port: z.number().int().min(1).max(65535),
    open: z.boolean(),
    latencyMs: nonNeg.optional(),
    reason: str(200).optional(),
  }),
  "network.dnsCheck": z.object({
    name: str(253),
    recordType: str(8),
    resolved: z.boolean(),
    answers: z.array(str(512)).max(64),
  }),
  "system.metrics": z.object({
    cpuCount: count.optional(),
    cpuUsagePct: z.number().min(0).max(100).optional(),
    load: load.optional(),
    memory: memory.optional(),
    disks: z.array(disk).max(64).optional(),
    network: z.object({ rxBytes: count, txBytes: count }).optional(),
    processCount: count.optional(),
    openFiles: count.optional(),
    uptimeSec: count.optional(),
  }),
  "system.logs": z.object({
    unit: str(160).optional(),
    lines: count,
    content: z.string().max(MAX_OUTPUT_BYTES * 2),
    truncated: z.boolean(),
    redacted: z.boolean().optional(),
  }),
  "machine.exec": execData,
} as const satisfies Record<ImplementedOperation, z.ZodTypeAny>;

export type MachineData<Op extends ImplementedOperation> = z.output<(typeof MachineResultDataSchemas)[Op]>;

/** Stable machine-readable reasons an `ok: false` result gives in `data.error`. */
export const MACHINE_FAILURE_CODES = [
  /** the command ran and exited non-zero */
  "command_failed",
  /** a tool the operation needs is not on the target (docker, systemctl, ps) */
  "unavailable",
  "not_found",
  /** a local guard on the target refused (path allowlist, protected unit, exec disabled) */
  "refused",
  "invalid_parameters",
  "timeout",
  "cancelled",
  /** SSM could not deliver the command (agent offline, delivery timeout) */
  "delivery_failed",
  "unexpected_output",
  "malformed_result",
  /** output ran far past the cap and the session was closed before an exit status arrived */
  "output_limit",
] as const;
export type MachineFailureCode = (typeof MACHINE_FAILURE_CODES)[number];

export const MachineFailureDataSchema = z.object({
  error: z.enum(MACHINE_FAILURE_CODES),
  reason: str(1000).optional(),
  status: str(64).optional(),
  timedOut: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type MachineFailureData = z.output<typeof MachineFailureDataSchema>;
