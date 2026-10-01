/**
 * Simulated machine transport for sandbox environments.
 *
 * Returns deterministic, plausible results for every implemented operation
 * WITHOUT touching anything: the same target, operation and arguments always
 * yield the same data, nothing is executed, read or contacted, and every
 * result carries `simulated: true` (and every text payload says so). It
 * reports the `transport` the sandbox target pretends to use so callers see
 * the same shape they would see from the real driver; only `simulated` and the
 * `sim-` transport reference tell them apart.
 *
 * Nothing simulated may ever be recorded or presented as observed state: the
 * service copies `simulated` into the evidence record.
 */
import { digest } from "@/lib/controlplane/digest";
import { sha256Hex } from "@/lib/controlplane/digest";
import { IMPLEMENTED_OPERATIONS, parseMachineArgs, type ImplementedOperation } from "../args";
import { MachineOperationError } from "../errors";
import { truncateUtf8 } from "../redact";
import { MachineResultDataSchemas } from "../results";
import type { MachineDriver, MachineOperation, MachineRequest, MachineResult, MachineTransport } from "../types";

export interface SimulatedDriverOptions {
  now?: () => number;
}

/** mulberry32: tiny deterministic PRNG seeded from the request digest */
function rng(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPOCH = Date.UTC(2026, 0, 1);
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

function logLines(r: () => number, n: number, label: string): string {
  const msgs = ["request handled", "cache hit", "connection accepted", "job completed", "health check ok", "config reloaded"];
  return Array.from({ length: n }, (_, i) => `${new Date(EPOCH + i * 1000).toISOString()} [simulated] ${label}: ${pick(r, msgs)}`).join("\n") + "\n";
}

type Gen = (r: () => number, args: Record<string, unknown>, req: MachineRequest) => Record<string, unknown>;

const GENERATORS: Record<ImplementedOperation, Gen> = {
  "machine.inspect": (r, _a, req) => {
    const total = int(r, 4, 32) * 1024 * 1024;
    return {
      hostname: `sim-${sha256Hex(req.target.targetId).slice(0, 8)}`,
      os: { id: "ubuntu", version: "24.04", pretty: "Ubuntu 24.04 LTS (simulated)" },
      kernel: "6.8.0-simulated",
      arch: "x86_64",
      cpuCount: pick(r, [2, 4, 8]),
      uptimeSec: int(r, 3600, 90 * 86400),
      load: [round(r() * 2, 2), round(r() * 2, 2), round(r() * 2, 2)],
      memory: { totalKb: total, availableKb: Math.floor(total * (0.3 + r() * 0.5)), swapTotalKb: 0, swapFreeKb: 0 },
      disks: [{ mount: "/", sizeKb: 50 * 1024 * 1024, usedKb: int(r, 5, 30) * 1024 * 1024, availKb: 20 * 1024 * 1024, usePct: int(r, 10, 60) }],
    };
  },

  "process.list": (r, a) => {
    const names = ["systemd", "sshd", "nginx", "node", "postgres", "redis-server", "containerd", "dockerd", "amazon-ssm-agent", "cron"];
    const n = Math.min(Number(a.limit), names.length);
    const processes = names
      .slice(0, n)
      .map((command, i) => ({ pid: 1 + i * 37, ppid: i === 0 ? 0 : 1, user: i < 2 ? "root" : "app", cpuPct: round(r() * 20), memPct: round(r() * 10), rssKb: int(r, 2000, 400000), elapsedSec: int(r, 60, 86400), command }))
      .sort((x, y) => (a.sortBy === "memory" ? y.memPct - x.memPct : y.cpuPct - x.cpuPct));
    return { processes, truncated: names.length > n };
  },

  "service.status": (r, a) => ({ unit: String(a.unit), loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled", mainPid: int(r, 300, 40000), execMainStatus: 0, restarts: 0, result: "success" }),

  "machine.service.restart": (r, a) => ({ unit: String(a.unit), restarted: true, activeState: "active", subState: "running", mainPid: int(r, 300, 40000) }),

  "container.list": (r, a) => {
    const all = [
      { name: "web", image: "registry.example/web:1.4.2", state: "running", status: "Up 3 hours" },
      { name: "worker", image: "registry.example/worker:1.4.2", state: "running", status: "Up 3 hours" },
      { name: "migrate", image: "registry.example/web:1.4.2", state: "exited", status: "Exited (0) 3 hours ago" },
    ].filter((c) => a.all === true || c.state === "running");
    const containers = all.slice(0, Number(a.limit)).map((c) => ({ id: sha256Hex(`${c.name}${r()}`).slice(0, 12), ...c }));
    return { containers, truncated: all.length > containers.length };
  },

  "container.inspect": (r, a) => ({
    id: sha256Hex(`inspect${r()}`).slice(0, 12),
    name: typeof a.container === "string" ? a.container : "web",
    image: "registry.example/web:1.4.2",
    state: "running",
    running: true,
    startedAt: new Date(EPOCH).toISOString(),
    restartCount: 0,
    health: "healthy",
    oomKilled: false,
  }),

  "container.logs": (r, a) => {
    const content = logLines(r, Number(a.lines), typeof a.container === "string" ? a.container : "web");
    return { container: typeof a.container === "string" ? a.container : undefined, lines: Number(a.lines), content, truncated: false };
  },

  "container.exec": () => ({ exitCode: 0 }),

  "file.read": (_r, a) => {
    const content = `# [simulated] contents of ${String(a.path)}\nkey=value\n`;
    return { path: String(a.path), sizeBytes: Buffer.byteLength(content), bytesRead: Buffer.byteLength(content), truncated: false, encoding: "utf8", content, sha256: sha256Hex(content) };
  },

  "network.portCheck": (r, a) => {
    const open = [22, 80, 443, 5432, 6379, 8080].includes(Number(a.port)) || r() < 0.3;
    return { host: String(a.host), port: Number(a.port), open, ...(open ? { latencyMs: round(0.4 + r() * 12) } : { reason: "closed_or_filtered" }) };
  },

  "network.dnsCheck": (r, a) => {
    const type = String(a.recordType);
    const answers =
      type === "A" ? [`192.0.2.${int(r, 1, 254)}`] : type === "AAAA" ? [`2001:db8::${int(r, 1, 0xfff).toString(16)}`] : type === "TXT" ? ['"simulated"'] : type === "MX" ? ["10 mail.example.invalid."] : type === "NS" ? ["ns1.example.invalid."] : type === "SRV" ? ["10 5 443 svc.example.invalid."] : [`alias.${String(a.name)}.`];
    return { name: String(a.name), recordType: type, resolved: true, answers };
  },

  "system.metrics": (r) => {
    const total = 8 * 1024 * 1024;
    return {
      cpuCount: 4,
      cpuUsagePct: round(r() * 60),
      load: [round(r() * 2, 2), round(r() * 2, 2), round(r() * 2, 2)],
      memory: { totalKb: total, availableKb: Math.floor(total * (0.3 + r() * 0.5)) },
      disks: [{ mount: "/", sizeKb: 50 * 1024 * 1024, usedKb: int(r, 5, 30) * 1024 * 1024, availKb: 20 * 1024 * 1024, usePct: int(r, 10, 60) }],
      network: { rxBytes: int(r, 1e6, 1e10), txBytes: int(r, 1e6, 1e10) },
      processCount: int(r, 80, 300),
      uptimeSec: int(r, 3600, 90 * 86400),
    };
  },

  "system.logs": (r, a) => ({ unit: typeof a.unit === "string" ? a.unit : undefined, lines: Number(a.lines), content: logLines(r, Number(a.lines), typeof a.unit === "string" ? a.unit : "journal"), truncated: false }),

  "machine.exec": () => ({ exitCode: 0 }),
};

export function createSimulatedMachineDriver(transport: MachineTransport, options: SimulatedDriverOptions = {}): MachineDriver {
  const now = options.now ?? Date.now;
  const supports = IMPLEMENTED_OPERATIONS as readonly MachineOperation[];

  async function execute(req: MachineRequest): Promise<MachineResult> {
    if (!IMPLEMENTED_OPERATIONS.includes(req.operation as ImplementedOperation)) {
      throw new MachineOperationError("unsupported_operation", `${req.operation} is not implemented`);
    }
    const op = req.operation as ImplementedOperation;
    const parsed = parseMachineArgs(op, req.args);
    if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });
    const args = parsed.args as Record<string, unknown>;
    const startedAt = new Date(now()).toISOString();
    const seed = digest({ target: req.target.targetId, op, args });
    const raw = GENERATORS[op](rng(seed), args, req);
    // validate against the same contract real transports must meet; strips undefined members
    const data = MachineResultDataSchemas[op].parse(JSON.parse(JSON.stringify(raw))) as Record<string, unknown>;
    if (typeof data.content === "string") {
      const cut = truncateUtf8(data.content, req.maxOutputBytes);
      data.content = cut.text;
      if (cut.truncated) data.truncated = true;
    }
    const isExec = op === "machine.exec" || op === "container.exec";
    const argv = isExec ? (args.argv as string[]) : [];
    return {
      ok: true,
      operation: req.operation,
      data,
      ...(isExec ? { output: { stdout: `[simulated] not executed: ${argv[0]}\n`, stderr: "", exitCode: 0, truncated: false } } : {}),
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      transport,
      transportRef: `sim-${seed.slice(0, 8)}`,
      simulated: true,
    };
  }

  return { transport, simulated: true, supports, execute };
}
