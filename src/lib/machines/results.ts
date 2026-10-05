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
  "file.write": z.object({
    path: str(1024), contentVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    changed: z.boolean(), created: z.boolean(), bytesWritten: count.max(1048576),
    postcondition: z.literal("verified"), phase: z.literal("verified"),
    effect: z.enum(["none", "committed"]),
    backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
    transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  }).superRefine((d, ctx) => {
    if (d.changed !== (d.effect === "committed") || (d.created && !d.changed) || (!d.changed && d.bytesWritten !== 0) || (d.changed && !d.transactionRef) || (d.created && d.backupRef) || (d.changed && !d.created && !d.backupRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent write receipt" });
  }),
  "file.upload": z.object({
    path: str(1024), sourceVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    changed: z.boolean(), created: z.boolean(), bytesWritten: count.max(1048576),
    postcondition: z.literal("verified"), phase: z.literal("verified"),
    effect: z.enum(["none", "committed"]),
    backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
    transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  }).superRefine((d, ctx) => {
    if (d.changed !== (d.effect === "committed") || (d.created && !d.changed) || (!d.changed && d.bytesWritten !== 0) || (d.changed && !d.transactionRef) || (d.created && d.backupRef) || (d.changed && !d.created && !d.backupRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent upload receipt" });
  }),
  "package.install": z.object({
    profileRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    profileVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    package: z.string().max(64).regex(/^[a-z0-9][a-z0-9+.-]{1,63}$/),
    version: z.string().max(128).regex(/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+~-]{0,127}$/),
    changed: z.boolean(), phase: z.literal("verified"), effect: z.enum(["none", "committed"]), postcondition: z.literal("verified"),
    transactionRef: z.string().length(35).regex(/^pi_[0-9a-f]{32}$/).optional(),
  }).superRefine((d, ctx) => {
    if (d.changed !== (d.effect === "committed") || (d.changed && !d.transactionRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent package receipt" });
  }),
  "service.configure": z.object({
    unit: str(128).regex(/^[A-Za-z0-9@._:-]{1,128}.service$/),
    profileRef: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    profileVersion: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    /** the configuration file changed on disk */
    changed: z.boolean(), created: z.boolean(), bytesWritten: count.max(1048576),
    /** the service action performed to converge: none when the file was unchanged and the unit already active */
    action: z.enum(["none", "reload", "restart"]),
    activeState: z.literal("active"),
    postcondition: z.literal("verified"), phase: z.literal("verified"),
    effect: z.enum(["none", "committed"]),
    backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
    transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  }).superRefine((d, ctx) => {
    if (d.effect !== (d.changed || d.action !== "none" ? "committed" : "none") || (d.created && !d.changed) || (!d.changed && d.bytesWritten !== 0) || (d.changed && !d.transactionRef) || (!d.changed && (d.transactionRef || d.backupRef)) || (d.created && d.backupRef) || (d.changed && !d.created && !d.backupRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent service configuration receipt" });
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
  "mutation_uncertain",
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
  phase: z.enum(["guard", "prepare", "backup", "commit", "rename", "directory_sync", "postcondition", "audit"]).optional(),
  effect: z.enum(["none", "unknown"]).optional(),
  postcondition: z.literal("unverified").optional(),
  backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  reason: str(1000).optional(),
  status: str(64).optional(),
  timedOut: z.boolean().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type MachineFailureData = z.output<typeof MachineFailureDataSchema>;

/** A write failure cannot carry arbitrary agent text or command output. */
export const FileWriteFailureDataSchema = z.object({
  error: z.enum(["refused", "mutation_uncertain"]),
  phase: z.enum(["guard", "prepare", "backup", "commit", "rename", "directory_sync", "postcondition", "audit"]),
  effect: z.enum(["none", "unknown"]),
  postcondition: z.literal("unverified"),
  backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
}).superRefine((d, ctx) => {
  if ((d.effect === "unknown") !== (d.error === "mutation_uncertain") || (["rename", "directory_sync", "audit"].includes(d.phase) && d.effect !== "unknown")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent mutation effect receipt" });
});

/** Package outcomes carry no archive bytes, command output or arbitrary errors. */
export const PackageInstallFailureDataSchema = z.object({
  error: z.enum(["refused", "mutation_uncertain"]), phase: z.enum(["guard", "uncertain", "audit"]),
  effect: z.enum(["none", "unknown"]), postcondition: z.literal("unverified"),
  transactionRef: z.string().length(35).regex(/^pi_[0-9a-f]{32}$/).optional(),
}).superRefine((d, ctx) => {
  if ((d.effect === "unknown") !== (d.error === "mutation_uncertain") || (d.phase !== "guard" && d.effect !== "unknown")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent package effect receipt" });
});

/**
 * Service configuration outcomes carry no file contents, paths, command output or arbitrary
 * errors. `committed` with `service_failed` means the configuration (or a restart) took effect
 * but the unit did not verify healthy: it is a definite, retained failure, never an unknown.
 */
export const ServiceConfigureFailureDataSchema = z.object({
  error: z.enum(["refused", "mutation_uncertain", "service_failed"]),
  phase: z.enum(["guard", "prepare", "backup", "commit", "rename", "directory_sync", "postcondition", "service_action", "service_postcondition", "audit"]),
  effect: z.enum(["none", "committed", "unknown"]),
  postcondition: z.literal("unverified"),
  backupRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
  transactionRef: z.string().length(35).regex(/^fw_[0-9a-f]{32}$/).optional(),
}).superRefine((d, ctx) => {
  const servicePhase = d.phase === "service_action" || d.phase === "service_postcondition";
  const bad =
    (d.effect === "unknown") !== (d.error === "mutation_uncertain") ||
    (d.error === "service_failed") !== (d.effect === "committed") ||
    (d.effect === "committed" && !servicePhase) ||
    (["rename", "directory_sync", "audit"].includes(d.phase) && d.effect !== "unknown") ||
    (d.effect === "none" && (d.backupRef || d.transactionRef) && !["commit", "backup", "prepare"].includes(d.phase));
  if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent service configuration effect receipt" });
});
