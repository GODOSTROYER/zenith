/**
 * Argument validation is the first wall: everything a machine will ever see is
 * constrained here. These tests are adversarial — injection shapes in every
 * string field, metadata targets in every spelling an address parser might
 * accept, and size limits at their exact edges.
 */
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTED_OPERATIONS,
  MachineRequestSchema,
  MACHINE_OPERATIONS,
  UNIMPLEMENTED_OPERATIONS,
  parseMachineArgs,
  type ImplementedOperation,
} from "@/lib/machines";
import { checkNetworkHost, normalizeAbsolutePath, parseSince } from "@/lib/machines/guards";

const ok = (op: ImplementedOperation, args: unknown) => {
  const r = parseMachineArgs(op, args);
  if (!r.ok) throw new Error(`expected ok, got ${r.issues.join("; ")}`);
  return r.args as Record<string, unknown>;
};
const bad = (op: ImplementedOperation, args: unknown) => {
  const r = parseMachineArgs(op, args);
  if (r.ok) throw new Error(`expected a validation error for ${JSON.stringify(args)}`);
  return r.issues;
};

describe("operation vocabulary", () => {
  it("every operation is either implemented or explicitly declared unimplemented", () => {
    expect(new Set([...IMPLEMENTED_OPERATIONS, ...UNIMPLEMENTED_OPERATIONS])).toEqual(new Set(MACHINE_OPERATIONS));
    expect([...UNIMPLEMENTED_OPERATIONS].sort()).toEqual(["file.upload", "package.install"]);
  });

  it("rejects unknown keys on every operation (no silent widening)", () => {
    const minimal: Record<ImplementedOperation, unknown> = {
      "machine.inspect": {},
      "process.list": {},
      "service.status": { unit: "nginx.service" },
      "machine.service.restart": { unit: "nginx.service" },
      "container.list": {},
      "container.inspect": {},
      "container.logs": {},
      "container.exec": { argv: ["ls"], timeoutSec: 5 },
      "file.write": { path: "/opt/customer/settings.txt", contentRef: "settings", contentVersion: "c".repeat(64), expectedSha256: null },
      "file.read": { path: "/var/log/syslog" },
      "network.portCheck": { host: "example.com", port: 80 },
      "network.dnsCheck": { name: "example.com" },
      "system.metrics": {},
      "system.logs": {},
      "machine.exec": { argv: ["ls"], timeoutSec: 5 },
    };
    for (const op of IMPLEMENTED_OPERATIONS) {
      expect(() => ok(op, minimal[op]), op).not.toThrow();
      expect(bad(op, { ...(minimal[op] as object), surprise: 1 }).join(" "), op).toMatch(/unrecognized/);
    }
  });
});

describe("unit names", () => {
  const good = ["nginx.service", "docker.socket", "logrotate.timer", "getty@tty1.service", "systemd-resolved.service", "a.b_c:d-e@f.service", "x".repeat(128) + ".service"];
  const evil = [
    "nginx", // no suffix
    "nginx.service; id",
    "$(id).service",
    "`id`.service",
    "a b.service",
    "a\n.service",
    "a\0.service",
    "a\r.service",
    "-x.service", // would parse as an option
    "--help.service",
    "../x.service",
    "a/b.service",
    "x".repeat(129) + ".service",
    "nginx.service\n",
    "nginx.service.evil",
    "nginx.service‮",
    "",
  ];
  it.each(good)("accepts %s", (unit) => {
    expect(ok("service.status", { unit })).toEqual({ unit });
  });
  it.each(evil)("refuses %j on every unit-taking operation", (unit) => {
    bad("service.status", { unit });
    bad("machine.service.restart", { unit });
    bad("system.logs", { unit });
  });
  it("refuses to restart protected units but allows reading their status", () => {
    for (const unit of ["sshd.service", "ssh.service", "systemd-journald.service", "dbus.service", "amazon-ssm-agent.service", "snap.amazon-ssm-agent.amazon-ssm-agent.service", "zenithd.service"]) {
      expect(bad("machine.service.restart", { unit }).join(" "), unit).toMatch(/protected/);
      expect(() => ok("service.status", { unit }), unit).not.toThrow();
    }
  });
});

describe("paths", () => {
  it.each([
    ["/var/log/syslog", "/var/log/syslog"],
    ["/var//log/./nginx/error.log", "/var/log/nginx/error.log"],
    ["/etc/nginx/conf.d/site@1.conf", "/etc/nginx/conf.d/site@1.conf"],
    ["/var/log/", "/var/log"],
  ])("normalizes %s", (input, expected) => {
    expect(ok("file.read", { path: input }).path).toBe(expected);
  });

  it.each([
    "var/log/syslog",
    "./syslog",
    "/var/log/../../etc/shadow",
    "/var/log/..",
    "/var/log/a..b",
    "/var/log/a;b",
    "/var/log/a b",
    "/var/log/$(id)",
    "/var/log/`id`",
    "/var/log/a|b",
    "/var/log/a&b",
    "/var/log/a\nb",
    "/var/log/a\0b",
    "/var/log/a\\b",
    "/var/log/*.log",
    "/var/log/~root",
    "/var/log/" + "a".repeat(1100),
    "/",
    "",
  ])("refuses %j", (path) => {
    bad("file.read", { path });
  });

  it("bounds maxBytes to 1 MiB", () => {
    expect(ok("file.read", { path: "/var/log/x", maxBytes: 1048576 }).maxBytes).toBe(1048576);
    bad("file.read", { path: "/var/log/x", maxBytes: 1048577 });
    bad("file.read", { path: "/var/log/x", maxBytes: 0 });
    expect(ok("file.read", { path: "/var/log/x" }).maxBytes).toBe(65536);
  });

  it("normalizeAbsolutePath reports a reason and never throws", () => {
    expect(normalizeAbsolutePath("/a/../b")).toMatchObject({ ok: false });
    expect(normalizeAbsolutePath("/a/b")).toEqual({ ok: true, path: "/a/b" });
  });
});

describe("network targets", () => {
  const refused = [
    "169.254.169.254",
    "169.254.170.2",
    "169.254.0.1",
    "169.254.169.254.", // trailing dot
    "0.0.0.0",
    "100.100.100.200",
    "168.63.129.16",
    "metadata.google.internal",
    "METADATA.GOOGLE.INTERNAL.",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
    "foo.metadata.google.internal",
    "metadata.goog",
    "fe80::1",
    "fe80::a9fe:a9fe",
    "febf::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:a9fe:a9fe::1",
    "::",
    // spellings a URL/inet parser would turn into 169.254.169.254
    "2852039166",
    "0xA9FEA9FE",
    "0251.0376.0251.0376",
    "169.254.43518",
    "169.0xfe.169.254",
    "fe80::1%eth0",
    // not hosts at all
    "",
    "a b",
    "a;b",
    "a/b",
    "http://169.254.169.254",
    "user@host",
    "host:80",
    "example.com\n",
    "-flag",
    "a".repeat(254),
    "exa_mple.com",
  ];
  it.each(refused)("refuses host %j", (host) => {
    expect(checkNetworkHost(host).ok).toBe(false);
    bad("network.portCheck", { host, port: 80 });
  });

  it.each(["example.com", "Example.COM.", "localhost", "10.0.0.5", "192.168.1.1", "::1", "2001:db8::1", "2606:4700:4700::1111", "db-1.internal", "1.2.3.4", "a.b.c.d.e.f"])("accepts %s", (host) => {
    expect(checkNetworkHost(host).ok).toBe(true);
    ok("network.portCheck", { host, port: 443 });
  });

  it("canonicalizes hosts (lowercase, no trailing dot)", () => {
    expect(ok("network.portCheck", { host: "Example.COM.", port: 443 }).host).toBe("example.com");
  });

  it("allows underscores only for dns names (SRV/TXT service labels)", () => {
    expect(ok("network.dnsCheck", { name: "_sip._tcp.example.com", recordType: "SRV" }).name).toBe("_sip._tcp.example.com");
    bad("network.portCheck", { host: "_sip._tcp.example.com", port: 5060 });
  });

  it("bounds ports, timeouts and record types", () => {
    for (const port of [0, -1, 65536, 1.5, "80"]) bad("network.portCheck", { host: "example.com", port });
    for (const timeoutSec of [0, 31]) bad("network.portCheck", { host: "example.com", port: 80, timeoutSec });
    bad("network.dnsCheck", { name: "example.com", recordType: "ANY" });
    bad("network.dnsCheck", { name: "metadata.google.internal" });
    bad("network.dnsCheck", { name: "169.254.169.254" });
  });
});

describe("exec argv", () => {
  const exec = (argv: unknown, extra: object = {}) => ({ argv, timeoutSec: 10, ...extra });

  it("accepts an argv vector and keeps arbitrary data in later elements verbatim", () => {
    const args = ok("machine.exec", exec(["/usr/bin/env", "FOO=bar baz", "$(id)", "a;b", "line1\nline2", "it's", "{{ssm:x}}", ""]));
    expect(args.argv).toEqual(["/usr/bin/env", "FOO=bar baz", "$(id)", "a;b", "line1\nline2", "it's", "{{ssm:x}}", ""]);
  });

  it("limits item count and item length at the exact edges", () => {
    ok("machine.exec", exec(Array.from({ length: 32 }, () => "x")));
    bad("machine.exec", exec(Array.from({ length: 33 }, () => "x")));
    bad("machine.exec", exec([]));
    ok("machine.exec", exec(["echo", "a".repeat(4096)]));
    bad("machine.exec", exec(["echo", "a".repeat(4097)]));
    // total size
    bad("machine.exec", exec(["echo", ...Array.from({ length: 10 }, () => "a".repeat(4000))]));
  });

  it("refuses NUL, a shell string, a non-array and an executable with metacharacters", () => {
    bad("machine.exec", exec(["echo", "a\0b"]));
    bad("machine.exec", exec("ls -la; id"));
    bad("machine.exec", exec({ 0: "ls" }));
    for (const exe of ["ls -la", "ls;id", "$(id)", "`id`", "a\nb", "sh -c", "", "a|b", "a&b", "a'b", 'a"b']) bad("machine.exec", exec([exe]));
    bad("machine.exec", exec([1, 2]));
  });

  it("requires a bounded timeoutSec", () => {
    bad("machine.exec", { argv: ["ls"] });
    bad("machine.exec", { argv: ["ls"], timeoutSec: 0 });
    bad("machine.exec", { argv: ["ls"], timeoutSec: 301 });
    bad("machine.exec", { argv: ["ls"], timeoutSec: 1.5 });
    ok("machine.exec", { argv: ["ls"], timeoutSec: 300 });
  });

  it("validates and normalizes cwd like any other path", () => {
    expect(ok("machine.exec", exec(["ls"], { cwd: "/srv//app/./" })).cwd).toBe("/srv/app");
    bad("machine.exec", exec(["ls"], { cwd: "/srv/../etc" }));
    bad("machine.exec", exec(["ls"], { cwd: "app" }));
    bad("machine.exec", exec(["ls"], { cwd: "/srv/a;b" }));
  });

  it("container.exec has the same argv rules and no cwd", () => {
    ok("container.exec", exec(["cat", "/etc/hostname"], { container: "web" }));
    bad("container.exec", exec(["cat"], { cwd: "/" }));
    bad("container.exec", exec(["cat", "a\0"]));
    bad("container.exec", exec(["cat"], { container: "web; id" }));
  });
});

describe("since, lines, limits", () => {
  it.each([
    ["900s", true],
    ["15m", true],
    ["2h", true],
    ["7d", true],
    ["168h", true],
    ["10080m", true],
    ["8d", false],
    ["169h", false],
    ["0m", false],
    ["-5m", false],
    ["15", false],
    ["15x", false],
    ["1.5h", false],
    ["yesterday", false],
    ["2026-01-01", false],
    ["15m; id", false],
    ["", false],
  ])("since %j -> %s", (since, valid) => {
    expect(parseSince(since) !== null).toBe(valid);
    expect(parseMachineArgs("container.logs", { container: "web", since }).ok).toBe(valid);
    expect(parseMachineArgs("system.logs", { since }).ok).toBe(valid);
  });

  it("bounds lines and supplies defaults", () => {
    expect(ok("container.logs", { container: "web" })).toEqual({ container: "web", lines: 200, timestamps: false });
    expect(ok("system.logs", {})).toEqual({ since: "1h", lines: 200 });
    for (const lines of [0, -1, 5001, 1.5, "10"]) {
      bad("container.logs", { container: "web", lines });
      bad("system.logs", { lines });
    }
    ok("system.logs", { lines: 5000 });
  });

  it("bounds process and container list limits", () => {
    bad("process.list", { limit: 501 });
    bad("process.list", { limit: 0 });
    bad("process.list", { sortBy: "pid" });
    bad("container.list", { limit: 201 });
    expect(ok("process.list", {})).toEqual({ limit: 50, sortBy: "cpu" });
  });

  it("container references are ids or names, never option-like", () => {
    for (const container of ["-rf", "--help", "a b", "a;b", "$(x)", "a/b", "", "a".repeat(129)]) bad("container.inspect", { container });
    ok("container.inspect", { container: "4f3c2a1b9d8e" });
    ok("container.inspect", { container: "my-app_web.1" });
  });

  it("label selectors use the selector alphabet only", () => {
    ok("container.list", { labelSelector: "app=web,tier in (a,b),!canary" });
    for (const labelSelector of ["a;b", "$(x)", "a`b`", "a\nb", "a'b", "a".repeat(257)]) bad("container.list", { labelSelector });
  });
});

describe("error messages never echo the offending value", () => {
  it("names the field and rule only", () => {
    const canary = "CANARY-SECRET-VALUE-9f8e7d";
    const cases: [ImplementedOperation, unknown][] = [
      ["service.status", { unit: `${canary};rm -rf /` }],
      ["file.read", { path: `/var/log/${canary}\0` }],
      ["network.portCheck", { host: `${canary}/x`, port: 80 }],
      ["machine.exec", { argv: [`${canary} bad`], timeoutSec: 5 }],
      ["container.logs", { container: `${canary}!`, since: canary }],
      ["process.list", { sortBy: canary }],
      ["machine.inspect", { [canary]: 1 }],
    ];
    for (const [op, args] of cases) {
      const r = parseMachineArgs(op, args);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.issues)).not.toContain(canary);
    }
  });
});

describe("request envelope", () => {
  const valid = {
    operationId: "op-1",
    target: { workspaceId: "ws", transport: "aws_ssm", targetId: "i-0123456789abcdef0" },
    operation: "machine.inspect",
    args: {},
    timeoutSec: 30,
    maxOutputBytes: 65536,
  };
  it("accepts a well-formed request and bounds the two hard limits", () => {
    expect(MachineRequestSchema.safeParse(valid).success).toBe(true);
    expect(MachineRequestSchema.safeParse({ ...valid, timeoutSec: 300 }).success).toBe(true);
    expect(MachineRequestSchema.safeParse({ ...valid, timeoutSec: 301 }).success).toBe(false);
    expect(MachineRequestSchema.safeParse({ ...valid, timeoutSec: 0 }).success).toBe(false);
    expect(MachineRequestSchema.safeParse({ ...valid, maxOutputBytes: 1048576 }).success).toBe(true);
    expect(MachineRequestSchema.safeParse({ ...valid, maxOutputBytes: 1048577 }).success).toBe(false);
  });
  it("refuses unknown operations, transports, extra keys and unsafe operation ids", () => {
    expect(MachineRequestSchema.safeParse({ ...valid, operation: "machine.format" }).success).toBe(false);
    expect(MachineRequestSchema.safeParse({ ...valid, target: { ...valid.target, transport: "ssh" } }).success).toBe(false);
    expect(MachineRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    for (const operationId of ["", "a b", "a;b", "a\nb", "x".repeat(129)]) {
      expect(MachineRequestSchema.safeParse({ ...valid, operationId }).success, operationId).toBe(false);
    }
  });
});
