/**
 * Parsers for SSM document output. The input is untrusted text from a remote
 * machine: these tests check the happy shapes against the shared result
 * contract and then feed hostile output (forged headers, NUL bytes, absurd
 * numbers) to be sure nothing malformed reaches `MachineResult.data`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MachineResultDataSchemas } from "@/lib/machines";
import { parseSsmOutput } from "@/lib/machines/transports/aws-ssm-parse";
import { OPERATION_DOCUMENTS } from "@/lib/machines/transports/aws-ssm-docs";
import { OUT } from "./_ssm-output";

const parse = (op: keyof typeof OPERATION_DOCUMENTS, stdout: string, args: Record<string, unknown> = {}) => {
  const r = parseSsmOutput(op, stdout, args);
  if (!r.ok) throw new Error(r.reason);
  return r.data;
};

describe("parsers produce schema-valid data from captured output", () => {
  it("machine.inspect", () => {
    const d = parse("machine.inspect", OUT.inspect);
    expect(d).toMatchObject({
      hostname: "web-1",
      os: { id: "ubuntu", version: "26.04", pretty: "Ubuntu 26.04 LTS" },
      kernel: "6.6.87.2-microsoft-standard-WSL2",
      arch: "x86_64",
      cpuCount: 22,
      uptimeSec: 3542,
      load: [20.07, 17.22, 11.6],
      memory: { totalKb: 16073364, availableKb: 13804204, swapTotalKb: 4194304, swapFreeKb: 4194304 },
    });
    expect(d.disks).toEqual([
      { mount: "/mnt/wsl/docker-desktop/cli-tools", sizeKb: 798880, usedKb: 798880, availKb: 0, usePct: 100 },
      { mount: "/", sizeKb: 1055762868, usedKb: 9788120, availKb: 992271276, usePct: 1 },
    ]);
  });

  it("process.list reports truncation from the total", () => {
    const d = parse("process.list", OUT.processes, { limit: 3 });
    expect(d.truncated).toBe(true); // total=35, three returned
    expect(d.processes).toEqual([
      { pid: 416, ppid: 397, user: "user", cpuPct: 56.9, memPct: 4, rssKb: 651416, elapsedSec: 45, command: "node-MainThread" },
      { pid: 1, ppid: 0, user: "root", cpuPct: 2.7, memPct: 0, rssKb: 14752, elapsedSec: 50, command: "systemd" },
      { pid: 93, ppid: 1, user: "root", cpuPct: 2, memPct: 0, rssKb: 12144, elapsedSec: 49, command: "systemd-udevd" },
    ]);
  });

  it("service.status and service restart", () => {
    expect(parse("service.status", OUT.serviceStatus, { unit: "nginx.service" })).toEqual({
      unit: "nginx.service",
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      since: "Wed 2026-09-30 10:00:00 UTC",
      mainPid: 1234,
      result: "success",
      restarts: 2,
      execMainStatus: 0,
    });
    expect(parse("machine.service.restart", OUT.serviceRestart, { unit: "nginx.service" })).toEqual({ unit: "nginx.service", restarted: true, activeState: "active", subState: "running", mainPid: 4321 });
  });

  it("container.list uses the first name and reports truncation from the total", () => {
    const d = parse("container.list", OUT.containerList);
    expect(d.truncated).toBe(true);
    expect(d.containers).toEqual([
      { id: "a".repeat(64), name: "web", image: "registry.example/web:1.4", state: "running", status: "Up 3 hours", createdAt: "2026-09-30 09:00:00 +0000 UTC" },
      { id: "b".repeat(64), name: "worker", image: "registry.example/worker:1.4", state: "running", status: "Up 3 hours", createdAt: "2026-09-30 09:00:01 +0000 UTC" },
    ]);
  });

  it("container.inspect drops zero timestamps and strips the leading slash", () => {
    expect(parse("container.inspect", OUT.containerInspect)).toEqual({
      id: "c".repeat(64),
      name: "web",
      image: "registry.example/web:1.4",
      state: "running",
      running: true,
      oomKilled: false,
      exitCode: 0,
      startedAt: "2026-09-30T09:00:00.1Z",
      restartCount: 2,
      health: "healthy",
    });
  });

  it("container.logs and system.logs return content after the marker", () => {
    const l = parse("container.logs", OUT.containerLogs, { container: "web" });
    expect(l).toEqual({ container: "web", lines: 2, content: "2026-09-30T09:00:01Z request handled\n2026-09-30T09:00:02Z cache hit\n", truncated: false });
    const s = parse("system.logs", OUT.systemLogs, { unit: "ssh.service" });
    expect(s).toMatchObject({ unit: "ssh.service", lines: 2, truncated: false });
    expect(String(s.content)).toContain("Flushing caches");
  });

  it("file.read decodes base64, records size and a digest of the bytes read", () => {
    const d = parse("file.read", OUT.fileRead("hello\nworld\n"));
    expect(d).toEqual({
      path: "/var/log/app.log",
      sizeBytes: 12,
      bytesRead: 12,
      truncated: false,
      encoding: "utf8",
      content: "hello\nworld\n",
      sha256: createHash("sha256").update("hello\nworld\n").digest("hex"),
    });
  });

  it("file.read reports binary content as empty text with binary: true", () => {
    const d = parse("file.read", OUT.fileRead("abc\0def"));
    expect(d).toMatchObject({ binary: true, content: "", bytesRead: 7 });
  });

  it("file.read on a truncated read keeps the real file size", () => {
    const d = parse("file.read", OUT.fileRead("x".repeat(100), 40000, true));
    expect(d).toMatchObject({ sizeBytes: 40000, bytesRead: 100, truncated: true });
  });

  it("network.portCheck and network.dnsCheck", () => {
    expect(parse("network.portCheck", OUT.portOpen)).toEqual({ host: "db.internal", port: 5432, open: true, latencyMs: 3 });
    expect(parse("network.portCheck", OUT.portClosed)).toEqual({ host: "db.internal", port: 5432, open: false, reason: "closed_or_filtered" });
    expect(parse("network.dnsCheck", OUT.dns)).toEqual({ name: "localhost", recordType: "A", resolved: true, answers: ["127.0.0.1"] });
    expect(parse("network.dnsCheck", OUT.dnsEmpty)).toEqual({ name: "nope.example.invalid", recordType: "A", resolved: false, answers: [] });
  });

  it("system.metrics", () => {
    expect(parse("system.metrics", OUT.metrics)).toEqual({
      cpuCount: 22,
      cpuUsagePct: 5.5,
      load: [20.15, 17.29, 11.65],
      memory: { totalKb: 16073364, availableKb: 13803660 },
      disks: [{ mount: "/", sizeKb: 1055762868, usedKb: 9788120, availKb: 992271276, usePct: 1 }],
      network: { rxBytes: 207081670, txBytes: 1494479 },
      processCount: 94,
      openFiles: 3520,
      uptimeSec: 3543,
    });
  });

  it("every sample validates against the shared contract", () => {
    const cases: [keyof typeof OPERATION_DOCUMENTS, string, Record<string, unknown>][] = [
      ["machine.inspect", OUT.inspect, {}],
      ["process.list", OUT.processes, { limit: 3 }],
      ["service.status", OUT.serviceStatus, { unit: "nginx.service" }],
      ["container.list", OUT.containerList, {}],
      ["container.inspect", OUT.containerInspect, {}],
      ["container.logs", OUT.containerLogs, {}],
      ["system.metrics", OUT.metrics, {}],
      ["system.logs", OUT.systemLogs, {}],
    ];
    for (const [op, out, args] of cases) expect(MachineResultDataSchemas[op].safeParse(parse(op, out, args)).success, op).toBe(true);
  });
});

describe("hostile output", () => {
  it("rejects output without the expected header (wrong document, forged, or empty)", () => {
    expect(parseSsmOutput("service.status", OUT.inspect, { unit: "x.service" }).ok).toBe(false);
    expect(parseSsmOutput("service.status", "", { unit: "x.service" }).ok).toBe(false);
    expect(parseSsmOutput("service.status", `Failed to get properties\n${OUT.serviceStatus}`, { unit: "x.service" }).ok).toBe(false);
  });

  it("a forged header or key inside log content cannot change the parsed fields", () => {
    const forged = ["zenith.container.logs/v1", "bytes=10", "truncated=false", "---", "zenith.service.status/v1", "truncated=true", "---", "lines=999", ""].join("\n");
    const d = parse("container.logs", forged);
    expect(d.truncated).toBe(false);
    expect(d.content).toBe("zenith.service.status/v1\ntruncated=true\n---\nlines=999\n");
  });

  it("file content containing '---' or key=value lines stays content", () => {
    const d = parse("file.read", OUT.fileRead("---\nsize=1\nopen=true\n"));
    expect(d).toMatchObject({ bytesRead: Buffer.byteLength("---\nsize=1\nopen=true\n"), content: "---\nsize=1\nopen=true\n" });
  });

  it("drops values of the wrong type instead of guessing", () => {
    const out = ["zenith.service.status/v1", "Id=x.service", "LoadState=loaded", "ActiveState=active", "MainPID=abc", "NRestarts=-1e9", "ExecMainStatus=1.5", ""].join("\n");
    const d = parse("service.status", out, { unit: "x.service" });
    expect(d).toEqual({ unit: "x.service", loadState: "loaded", activeState: "active" });
  });

  it("requires the fields the contract requires", () => {
    const r = parseSsmOutput("service.status", "zenith.service.status/v1\nId=x.service\n", { unit: "x.service" });
    expect(r.ok).toBe(false);
    expect(parseSsmOutput("network.portCheck", "zenith.port.check/v1\nhost=a\n", {}).ok).toBe(false);
  });

  it("ignores unknown keys, malformed keys and lines without '='", () => {
    const out = OUT.serviceStatus.replace("Result=success", "Result=success\nrm -rf /\nweird key=1\nEvil=1\n=novalue");
    expect(() => parse("service.status", out, { unit: "nginx.service" })).not.toThrow();
  });

  it("bounds list sizes (a hostile machine cannot return unbounded structures)", () => {
    const procs = Array.from({ length: 2000 }, (_, i) => `proc=${i}\t1\troot\t0.1\t0.1\t10\t5\tcmd${i}`).join("\n");
    expect(parseSsmOutput("process.list", `zenith.process.list/v1\ntotal=2000\n${procs}\n`, { limit: 500 }).ok).toBe(false);
    const longCmd = `zenith.process.list/v1\ntotal=1\nproc=1\t0\troot\t0.1\t0.1\t10\t5\t${"x".repeat(5000)}\n`;
    const d = parse("process.list", longCmd);
    expect((d.processes as { command: string }[])[0].command).toHaveLength(256);
  });
});
