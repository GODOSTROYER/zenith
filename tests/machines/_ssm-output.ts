/**
 * Sample stdout of the Zenith SSM documents. The host-facts documents
 * (inspect, process list, service status, metrics, system logs, dns, port) are
 * trimmed copies of real output captured by running the scripts under dash on
 * Ubuntu 26.04 (WSL2). The Docker documents are written from the script's
 * format strings because no Docker daemon was reachable while testing; they
 * exercise the parsers, not Docker.
 */
export const OUT = {
  inspect: [
    "zenith.machine.inspect/v1",
    "hostname=web-1",
    "os_id=ubuntu",
    "os_version=26.04",
    "os_pretty=Ubuntu 26.04 LTS",
    "kernel=6.6.87.2-microsoft-standard-WSL2",
    "arch=x86_64",
    "cpu_count=22",
    "uptime_sec=3542",
    "load=20.07 17.22 11.60",
    "mem.memtotal_kb=16073364",
    "mem.memavailable_kb=13804204",
    "mem.swaptotal_kb=4194304",
    "mem.swapfree_kb=4194304",
    "disk=/mnt/wsl/docker-desktop/cli-tools\t798880\t798880\t0\t100%",
    "disk=/\t1055762868\t9788120\t992271276\t1%",
    "",
  ].join("\n"),

  processes: [
    "zenith.process.list/v1",
    "total=35",
    "proc=416\t397\tuser\t56.9\t4.0\t651416\t45\tnode-MainThread",
    "proc=1\t0\troot\t2.7\t0.0\t14752\t50\tsystemd",
    "proc=93\t1\troot\t2.0\t0.0\t12144\t49\tsystemd-udevd",
    "",
  ].join("\n"),

  serviceStatus: [
    "zenith.service.status/v1",
    "Id=nginx.service",
    "LoadState=loaded",
    "ActiveState=active",
    "SubState=running",
    "UnitFileState=enabled",
    "ActiveEnterTimestamp=Wed 2026-09-30 10:00:00 UTC",
    "MainPID=1234",
    "Result=success",
    "NRestarts=2",
    "ExecMainStatus=0",
    "",
  ].join("\n"),

  serviceRestart: [
    "zenith.service.restart/v1",
    "restarted=true",
    "Id=nginx.service",
    "LoadState=loaded",
    "ActiveState=active",
    "SubState=running",
    "MainPID=4321",
    "",
  ].join("\n"),

  containerList: [
    "zenith.container.list/v1",
    "total=3",
    `container=${"a".repeat(64)}\tweb\tregistry.example/web:1.4\trunning\tUp 3 hours\t2026-09-30 09:00:00 +0000 UTC`,
    `container=${"b".repeat(64)}\tworker,alias\tregistry.example/worker:1.4\trunning\tUp 3 hours\t2026-09-30 09:00:01 +0000 UTC`,
    "",
  ].join("\n"),

  containerInspect: [
    "zenith.container.inspect/v1",
    `inspect=${"c".repeat(64)}\t/web\tregistry.example/web:1.4\trunning\ttrue\tfalse\t0\t2026-09-30T09:00:00.1Z\t0001-01-01T00:00:00Z\t2\thealthy`,
    "",
  ].join("\n"),

  containerLogs: ["zenith.container.logs/v1", "bytes=61", "truncated=false", "---", "2026-09-30T09:00:01Z request handled", "2026-09-30T09:00:02Z cache hit", ""].join("\n"),

  fileRead: (content: string, size = Buffer.byteLength(content), truncated = false, path = "/var/log/app.log") =>
    ["zenith.file.read/v1", `path=${path}`, `size=${size}`, `truncated=${truncated}`, `content_b64=${Buffer.from(content).toString("base64")}`, ""].join("\n"),

  portOpen: ["zenith.port.check/v1", "host=db.internal", "port=5432", "address=10.0.0.5", "open=true", "latency_ms=3", ""].join("\n"),
  portClosed: ["zenith.port.check/v1", "host=db.internal", "port=5432", "open=false", "reason=closed_or_filtered", ""].join("\n"),

  dns: ["zenith.dns.check/v1", "name=localhost", "type=A", "answer=127.0.0.1", ""].join("\n"),
  dnsEmpty: ["zenith.dns.check/v1", "name=nope.example.invalid", "type=A", ""].join("\n"),

  metrics: [
    "zenith.system.metrics/v1",
    "cpu_usage_pct=5.5",
    "cpu_count=22",
    "uptime_sec=3543",
    "load=20.15 17.29 11.65",
    "mem.memtotal_kb=16073364",
    "mem.memavailable_kb=13803660",
    "net_rx_bytes=207081670",
    "net_tx_bytes=1494479",
    "open_files=3520",
    "process_count=94",
    "disk=/\t1055762868\t9788120\t992271276\t1%",
    "",
  ].join("\n"),

  systemLogs: [
    "zenith.system.logs/v1",
    "bytes=180",
    "lines=2",
    "truncated=false",
    "---",
    "2026-09-30T16:47:09+00:00 host systemd-resolved[81]: Clock change detected. Flushing caches.",
    "2026-09-30T16:47:09+00:00 host node[416]: agent runtime plugins pre-warmed in 187ms",
    "",
  ].join("\n"),
} as const;
