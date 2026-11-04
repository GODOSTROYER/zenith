/**
 * Parsers for the output of the Zenith SSM documents.
 *
 * Each document prints a first line `zenith.<name>/v1`, then `key=value`
 * lines (repeated keys for lists, tab-separated fields for rows), and for the
 * log-like documents a line `---` followed by raw content. Parsing is
 * deliberately tolerant of extra lines and strict about shape: a value that is
 * not the expected type is dropped (becomes "unknown", never a guess), and the
 * final object must satisfy `MachineResultDataSchemas[op]` or the whole result
 * is reported as `unexpected_output`.
 *
 * Everything parsed here is untrusted text from a remote machine: it is split,
 * type-checked and bounded, never evaluated, and raw content (logs, file
 * bytes) is returned as a string for the service to redact.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { MachineResultDataSchemas } from "../results";
import type { SsmDocumentOperation } from "./aws-ssm-docs";

export type ParseResult = { ok: true; data: Record<string, unknown> } | { ok: false; reason: string };

const HEADERS: Record<SsmDocumentOperation, string> = {
  "machine.inspect": "zenith.machine.inspect/v1",
  "process.list": "zenith.process.list/v1",
  "service.status": "zenith.service.status/v1",
  "machine.service.restart": "zenith.service.restart/v1",
  "container.list": "zenith.container.list/v1",
  "container.inspect": "zenith.container.inspect/v1",
  "container.logs": "zenith.container.logs/v1",
  "file.read": "zenith.file.read/v1",
  "network.portCheck": "zenith.port.check/v1",
  "network.dnsCheck": "zenith.dns.check/v1",
  "system.metrics": "zenith.system.metrics/v1",
  "system.logs": "zenith.system.logs/v1",
};

interface Split {
  kv: Map<string, string[]>;
  /** everything after the `---` marker line, when present */
  body?: string;
}

const KEY = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function split(stdout: string, header: string): Split | null {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== header) return null;
  const kv = new Map<string, string[]>();
  let body: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") {
      body = lines.slice(i + 1).join("\n");
      break;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    if (!KEY.test(k)) continue;
    const arr = kv.get(k);
    if (arr) arr.push(line.slice(eq + 1));
    else kv.set(k, [line.slice(eq + 1)]);
  }
  return { kv, body };
}

const first = (s: Split, k: string): string | undefined => {
  const v = s.kv.get(k)?.[0];
  return v === undefined || v === "" ? undefined : v;
};
const int = (v: string | undefined): number | undefined => (v !== undefined && /^-?\d{1,15}$/.test(v) ? Number(v) : undefined);
const num = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,12}(\.\d{1,6})?$/.test(v) ? Number(v) : undefined);
const bool = (v: string | undefined): boolean | undefined => (v === "true" ? true : v === "false" ? false : undefined);
const drop = <T extends Record<string, unknown>>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

const sub = <T extends Record<string, unknown>>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

const loadOf = (v: string | undefined): [number, number, number] | undefined => {
  const p = v?.split(" ").map(num);
  return p && p.length === 3 && p.every((x) => x !== undefined) ? (p as [number, number, number]) : undefined;
};

const memoryOf = (s: Split) =>
  drop({
    totalKb: int(first(s, "mem.memtotal_kb")),
    availableKb: int(first(s, "mem.memavailable_kb")),
    swapTotalKb: int(first(s, "mem.swaptotal_kb")),
    swapFreeKb: int(first(s, "mem.swapfree_kb")),
  });

const disksOf = (s: Split) =>
  (s.kv.get("disk") ?? []).flatMap((row) => {
    const [mount, size, used, avail, pct] = row.split("\t");
    const sizeKb = int(size);
    const usedKb = int(used);
    const availKb = int(avail);
    if (!mount || sizeKb === undefined || usedKb === undefined || availKb === undefined) return [];
    return [drop({ mount, sizeKb, usedKb, availKb, usePct: int(pct?.replace("%", "")) })];
  });

const unitFields = (s: Split, unit: string) =>
  drop({
    unit: first(s, "Id") ?? unit,
    loadState: first(s, "LoadState"),
    activeState: first(s, "ActiveState"),
    subState: first(s, "SubState"),
    unitFileState: first(s, "UnitFileState"),
    mainPid: int(first(s, "MainPID")),
    execMainStatus: int(first(s, "ExecMainStatus")),
    restarts: int(first(s, "NRestarts")),
    result: first(s, "Result"),
    since: first(s, "ActiveEnterTimestamp"),
  });

const linesIn = (body: string): number => body.split("\n").filter((l) => l !== "").length;

type Builder = (s: Split, args: Record<string, unknown>) => Record<string, unknown>;

const BUILDERS: Record<SsmDocumentOperation, Builder> = {
  "machine.inspect": (s) =>
    drop({
      hostname: first(s, "hostname"),
      os: sub(drop({ id: first(s, "os_id"), version: first(s, "os_version"), pretty: first(s, "os_pretty") })),
      kernel: first(s, "kernel"),
      arch: first(s, "arch"),
      cpuCount: int(first(s, "cpu_count")),
      uptimeSec: int(first(s, "uptime_sec")),
      load: loadOf(first(s, "load")),
      memory: sub(memoryOf(s)),
      disks: disksOf(s),
    }),

  "process.list": (s) => {
    const processes = (s.kv.get("proc") ?? []).flatMap((row) => {
      const [pid, ppid, user, cpu, mem, rss, etimes, command] = row.split("\t");
      if (int(pid) === undefined || !command) return [];
      return [drop({ pid: int(pid), ppid: int(ppid), user, cpuPct: num(cpu), memPct: num(mem), rssKb: int(rss), elapsedSec: int(etimes), command: command.slice(0, 256) })];
    });
    const total = int(first(s, "total")) ?? processes.length;
    return { processes, truncated: total > processes.length };
  },

  "service.status": (s, args) => unitFields(s, String(args.unit)),

  "machine.service.restart": (s, args) => {
    const u = unitFields(s, String(args.unit));
    return drop({ unit: u.unit, restarted: bool(first(s, "restarted")) ?? false, activeState: u.activeState, subState: u.subState, mainPid: u.mainPid });
  },

  "container.list": (s) => {
    const containers = (s.kv.get("container") ?? []).flatMap((row) => {
      const [id, names, image, state, status, createdAt] = row.split("\t");
      if (!id || !names) return [];
      return [drop({ id, name: names.split(",")[0].replace(/^\//, ""), image: image || undefined, state: state || undefined, status: status || undefined, createdAt: createdAt || undefined })];
    });
    return { containers, truncated: (int(first(s, "total")) ?? containers.length) > containers.length };
  },

  "container.inspect": (s) => {
    const row = s.kv.get("inspect")?.[0] ?? "";
    const [id, name, image, state, running, oom, exit, startedAt, finishedAt, restarts, health] = row.split("\t");
    return drop({
      id,
      name: name?.replace(/^\//, ""),
      image: image || undefined,
      state,
      running: bool(running),
      oomKilled: bool(oom),
      exitCode: int(exit),
      startedAt: startedAt && !startedAt.startsWith("0001-") ? startedAt : undefined,
      finishedAt: finishedAt && !finishedAt.startsWith("0001-") ? finishedAt : undefined,
      restartCount: int(restarts),
      health: health || undefined,
    });
  },

  "container.logs": (s, args) => {
    const body = s.body ?? "";
    return drop({ container: typeof args.container === "string" ? args.container : undefined, lines: linesIn(body), content: body, truncated: bool(first(s, "truncated")) ?? false });
  },

  "file.read": (s) => {
    const b64 = first(s, "content_b64") ?? "";
    const bytes = Buffer.from(b64, "base64");
    const binary = bytes.includes(0);
    return drop({
      path: first(s, "path"),
      sizeBytes: int(first(s, "size")),
      bytesRead: bytes.length,
      truncated: bool(first(s, "truncated")) ?? false,
      encoding: "utf8",
      content: binary ? "" : bytes.toString("utf8"),
      binary: binary || undefined,
      sha256: sha256Hex(bytes),
    });
  },

  "network.portCheck": (s) =>
    drop({
      host: first(s, "host"),
      port: int(first(s, "port")),
      open: bool(first(s, "open")),
      latencyMs: num(first(s, "latency_ms")),
      reason: first(s, "reason"),
    }),

  "network.dnsCheck": (s) => {
    const answers = (s.kv.get("answer") ?? []).map((a) => a.slice(0, 512));
    return { name: first(s, "name"), recordType: first(s, "type"), resolved: answers.length > 0, answers };
  },

  "system.metrics": (s) => {
    const rx = int(first(s, "net_rx_bytes"));
    const tx = int(first(s, "net_tx_bytes"));
    return drop({
      cpuCount: int(first(s, "cpu_count")),
      cpuUsagePct: num(first(s, "cpu_usage_pct")),
      load: loadOf(first(s, "load")),
      memory: sub(memoryOf(s)),
      disks: disksOf(s),
      network: rx !== undefined && tx !== undefined ? { rxBytes: rx, txBytes: tx } : undefined,
      processCount: int(first(s, "process_count")),
      openFiles: int(first(s, "open_files")),
      uptimeSec: int(first(s, "uptime_sec")),
    });
  },

  "system.logs": (s, args) => {
    const body = s.body ?? "";
    return drop({ unit: typeof args.unit === "string" ? args.unit : undefined, lines: int(first(s, "lines")) ?? linesIn(body), content: body, truncated: bool(first(s, "truncated")) ?? false });
  },
};

/** Parse the stdout of the document implementing `op` into schema-valid `MachineResult.data`. */
export function parseSsmOutput(op: SsmDocumentOperation, stdout: string, args: Record<string, unknown>): ParseResult {
  const s = split(stdout, HEADERS[op]);
  if (!s) return { ok: false, reason: `output does not start with ${HEADERS[op]}` };
  const parsed = MachineResultDataSchemas[op].safeParse(BUILDERS[op](s, args));
  return parsed.success ? { ok: true, data: parsed.data as Record<string, unknown> } : { ok: false, reason: `output failed validation: ${parsed.error.issues[0]?.path.join(".") || "(root)"}` };
}
