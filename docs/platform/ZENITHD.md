# zenithd — operator guide

`zenithd` is Zenith's machine agent for a **Linux VM**. It runs **semantic
operations** — inspect, service status, bounded file reads, logs, network checks,
and (only if you turn them on) service restarts, container operations and
`machine.exec` — on behalf of the Zenith control plane, with **no inbound port,
no SSH and no cloud credentials**. The wire protocol is in
[`RUNNER-PROTOCOL.md`](RUNNER-PROTOCOL.md) (`zenith.machine/v1`); ADR-0012 sets
the machine-plane policy. Install steps: [`deploy/zenithd/INSTALL.md`](../../deploy/zenithd/INSTALL.md).

It shares its core with the runner (same Go module, same registration, request
signing, long-poll, heartbeat, revocation and replay protection). Read
[`RUNNER.md`](RUNNER.md) §§ 2, 3, 5–8 for those; this document covers what is
specific to the machine.

## 1. Trust model

* zenithd only **dials out** over HTTPS. Requests carry an Ed25519 signature
  made with a key generated on this machine at registration; the private key never
  leaves `/var/lib/zenithd/identity.json` (0600).
* Every request is a compact JWS signed by the control plane, verified against
  the pinned key: `typ: zenith-machine+jwt`, addressed to this machine, unexpired,
  not seen before (persisted replay cache), carrying a capability grant whose
  audience is `machine:<id>`, whose capability equals the operation, and whose
  operation id matches.
* Every operation is **fixed code**. No shell string is ever built from an
  argument. Arguments are decoded strictly (unknown fields rejected), validated,
  then used to build an argv list, a file open, or a Docker Engine API call.
* Each operation has a **local guard** in `/etc/zenithd/config.yaml` that the
  control plane cannot override. The defaults are read-only.

## 2. Operations

Results are `{ok, operation, data, output?}` in the `result` of the posted result
(job status `succeeded`, `failed` or `timed_out`). The authoritative result schemas
are [`src/lib/machines/results.ts`](../../src/lib/machines/results.ts), shared
with the SSM and Kubernetes transports. Semantic failures carry
`data: {error: <MachineFailureCode>, reason?}`; exec also carries `data.exitCode`
and `output: {stdout, stderr, exitCode, truncated}`.
Protocol/validation rejections from the shared agent loop carry the protocol
reason; the machine queue adapter/driver maps them to a machine failure.

Two kinds of non-success:

* `rejected` — validation or a local guard said no; nothing ran. `error` is
  `"<code>: <message>"`: `invalid_payload`, `not_allowed`, `disabled_by_config`,
  `unsupported_operation`, `guard_denied`, plus the protocol codes in
  [`RUNNER.md`](RUNNER.md) §6.
* `failed` / `timed_out` — it ran (or tried to) and did not complete.

| Operation | Enabled when | Args | Notes |
|---|---|---|---|
| `machine.inspect` | always | none | hostname, OS (`/etc/os-release`), kernel, arch, CPU count, uptime, load, memory and swap, disks (real filesystems only, with `statfs` capacity) |
| `process.list` | always | `limit` (1–500, default 50), `sortBy` (`cpu`\|`memory`, default `cpu`) | `/proc` scan: `pid`, `ppid`, `command` (comm only), `user` (numeric UID string), `rssKb`. CPU sorting uses cumulative ticks; memory sorting uses RSS. **Command arguments are never returned** (they carry passwords) |
| `service.status` | always | `unit` | `systemctl show --property=… -- <unit>` (fixed property list): load/active/sub state, unit-file state, main PID, `restarts`, `since` timestamp |
| `machine.service.restart` | `services.restartAllow` non-empty | `unit` | `systemctl restart -- <unit>`; unit must match the allowlist; returns `unit`, `restarted`, `activeState`, optional `subState` and `mainPid` after restart |
| `container.list` | `containers.enabled` | `all` (default false), `limit` (1–200, default 100) | Docker Engine API over the unix socket; `containers` with id, name, image, createdAt, state, status; `truncated`. `labelSelector` is Kubernetes-only and refused here |
| `container.inspect` | `containers.enabled` | `container` | flat state, running, exitCode, startedAt, finishedAt, restartCount, health and oomKilled. **Environment variables, command and entrypoint are never decoded**, so they cannot leak |
| `container.logs` | `containers.enabled` | `container`, `lines` (1–5000, default 200), `since?`, `timestamps` (default false) | multiplexed or TTY stream, redacted, newest lines kept within the byte budget |
| `container.exec` | `containers.enabled` **and** `exec.enabled` | `container`, `argv[]`, `timeoutSec` | Docker exec, argv array only; result carries `output{stdout,stderr,exitCode,truncated}` |
| `file.read` | `files.readAllow` non-empty | `path`, `maxBytes` (1–1048576, default 65536) | see §3 |
| `network.portCheck` | always | `host`, `port`, `timeoutSec` (1–30, default 5) | TCP connect; metadata/link-local refused; loopback allowed |
| `network.dnsCheck` | always | `name`, `recordType` (A, AAAA, CNAME, TXT, MX, NS, SRV; default A) | system resolver |
| `system.metrics` | always | none | CPU usage (250 ms sample), load, memory, network counters, file descriptors, disks |
| `system.logs` | always | `unit?`, `since` (default `1h`), `lines` (1–5000, default 200) | `journalctl` with an argv built only from validated fields; newest lines kept within the byte budget, redacted |
| `machine.exec` | `exec.enabled` | `argv[]`, `cwd?`, `timeoutSec` | see §4 |
| `file.write`, `file.upload`, `package.install` | **never** | — | in the platform vocabulary, deliberately not implemented: answered with `unsupported_operation` |

Unit names must match `^[A-Za-z0-9@._:-]{1,128}\.(service|socket|timer)$` and, in
addition, must **not start with `-`** (a regex alone would let `--help.service`
reach `systemctl` as an option; the name is also passed after `--`).
Arguments are the normalized `MachineArgsSchemas` shapes. `since` is a positive
relative duration (`15m`, `2h`, `2d`, `900s`), bounded to 7d. Signed negative
durations, absolute timestamps, `until`, `priority`, `tail`, `offset` and `length`
are refused. Durations become absolute timestamps only inside the fixed transport code.

Operations that cannot work on the host (no `/proc`, no systemd, no Docker socket)
**fail with a clear error**, they do not guess. `process.list`, `machine.inspect`
and `system.metrics` need Linux `/proc`; on other platforms the binary still
builds and starts, and those operations return `data.error: "unavailable"` with an explanatory reason.

### Output rules

Every operation result is bounded by the request's `maxOutputBytes` (clamped to
`limits.maxOutputBytes`) and its `timeoutSec` (clamped to `limits.maxTimeoutSec`).
Text that might carry credentials (logs, file contents, exec output, error
messages) is redacted for credential shapes before it leaves the machine. This is
pattern-based and best-effort; it does not replace choosing what you allow.

## 3. `file.read` guard

`files.readAllow` lists absolute directory or file prefixes (clean paths; `/` is
refused). With the list empty the operation is off.

1. The requested path must be absolute and, cleaned, lie inside an allowed prefix
   (on a path boundary: `/etc/app` does not contain `/etc/application`). Nothing
   outside the allowlist is touched.
2. Symbolic links are **resolved** (`filepath.EvalSymlinks`), and the resolved
   path must again lie inside a resolved allowed prefix: a link under an allowed
   directory that points outside it is refused, including chained links and links
   into a directory.
3. The file is opened without following a final link and without blocking
   (`O_NOFOLLOW|O_NONBLOCK`), and on Linux the opened descriptor is re-checked
   through `/proc/self/fd` to be exactly the path that passed step 2, closing the
   window in which a local user could swap a directory for a link.
4. Only regular files are read (a FIFO cannot hang the agent). Reads are bounded
   (`files.maxReadBytes`, default 1 MiB, and the request budget), with
   `maxBytes` bounding the read from byte zero and a `truncated` flag.
5. zenithd's **own state directory and config file are never readable**, whatever
   the allowlist says (they hold the identity key).

Text is returned as UTF-8 with credential shapes redacted (`redacted: true` says
so); binary content is omitted (`binary: true`, `content: ""`, `encoding: "utf8"`).
The result carries the requested canonical path, `sizeBytes`, `bytesRead`, and a
SHA-256 of the raw bounded read. The resolved path is used only for guard checks.

## 4. `machine.exec` (and `container.exec`)

Off by default. When `exec.enabled` is true:

* `argv[0]` must be an **absolute path** (no `PATH` search) and, if
  `exec.allowArgv0` is set, be one of those paths;
* the program is started with `execve` — **never through a shell** — so `$(id)`,
  `;`, `&&` or `` ` `` in an element are just bytes (this is tested with real
  processes);
* it gets a fixed minimal environment (`PATH`, `LANG`, …), none of zenithd's own;
* it runs in its own process group with SIGTERM on timeout and SIGKILL after 5 s;
* stdout and stderr are captured separately, each capped at half the budget, and
  reported with the exit code and a `truncated` flag.

Honest limit: enabling exec lets the control plane run **any program the zenithd
user can run**, including a shell given as `argv[0]` with `-c`. `allowArgv0` is
how you narrow that. Zenith's own policy (`machine.exec` is an escape-hatch
capability, critical risk, denied in production by default) is a separate layer.
For `container.exec` the Docker Engine has no API to kill an exec'd process, so a
timed-out command may keep running inside the container.

## 5. Audit log

`/var/lib/zenithd/audit.jsonl` (mode 0600, append-only, `fsync`ed per entry).
Every request — accepted or rejected — leaves lines:

```json
{"ts":"…","phase":"start","requestId":"mreq_…","operation":"file.read","verified":true,
 "grantJti":"grt_…","operationId":"op_…","outcome":"started",
 "argsSha256":"…","target":{"path":"/var/log/nginx/error.log"}}
{"ts":"…","phase":"end","requestId":"mreq_…","operation":"file.read","verified":true,
 "outcome":"succeeded","outputSha256":"…","outputBytes":1842,"durationMs":3}
{"ts":"…","phase":"rejected","requestId":"mreq_…","operation":"file.read","verified":true,
 "outcome":"rejected","reason":"not_allowed: the path resolves … outside files.readAllow"}
```

It records the request id, operation, grant id, outcome, and the **SHA-256 and
size of the output** — never the output, never file contents. `target` names what
the operation was aimed at (unit, file path, container, host:port; for exec the
argv with credential patterns and separate credential flag values redacted).
Pattern redaction cannot recognize an arbitrary unmarked secret; pass secret
references rather than secret values in argv. `verified:false`
marks an entry for a token whose signature did not verify (its ids are only
hints). **zenithd refuses to run an operation whose `start` line cannot be
written**, so there is no unaudited execution.

## 6. Privilege model (read this before enabling anything)

The shipped unit runs zenithd as an unprivileged user with an **empty capability
bounding set** and these sandbox options: `NoNewPrivileges`, `ProtectSystem=strict`
(state directory writable only), `ProtectHome`, `PrivateTmp`, `PrivateDevices`,
`ProtectKernel*`, `ProtectControlGroups`, `ProtectClock`, `RestrictNamespaces`,
`RestrictSUIDSGID`, `LockPersonality`, `MemoryDenyWriteExecute`,
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallFilter=@system-service`,
`UMask=0077`. `systemd-analyze verify` passes and `systemd-analyze security` scores
the unit **1.7 (OK)**.

What the unprivileged user needs, and what it costs:

| Capability | How it is granted | Tradeoff |
|---|---|---|
| read the system journal | `SupplementaryGroups=systemd-journal` | can read every service's logs |
| restart **specific** units | polkit rule (`50-zenithd-restart.rules.example`) for exactly the units in `restartAllow` | two independent allowlists (polkit and zenithd); keep them identical |
| read `/var/log` and similar | add the user to `adm`, or grant ACLs | broadens what `readAllow` can reach |
| Docker operations | `docker` group | **root-equivalent on the host**: anyone who can talk to the Docker socket can start a privileged container. Off by default |
| `machine.exec` | `exec.enabled` | runs as this user; use `allowArgv0` |

If you need zenithd to do things only root can (restart arbitrary units, read root-only
files, manage Docker without the group trick), you can run it as root with a
drop-in (`User=root`) and **keep every other hardening option**; the empty
capability set then still removes `CAP_SYS_ADMIN` and friends, but root can read
and write nearly everything, so the local guards (`restartAllow`, `readAllow`,
`allowArgv0`) become your only layer. Prefer the polkit route.

**Verified:** the unit file with `systemd-analyze verify`/`security`, and that the
built binary runs (`zenithd check`) under the same seccomp filter,
`MemoryDenyWriteExecute`, address-family and namespace restrictions in a transient
systemd *user* unit. **Not verified:** a full system-level install as the
`zenithd` user with `ProtectSystem=strict`, the polkit rule, or the `docker`
group path on a real VM.

## 7. Configuration

Same file format, `--config`, environment overrides, `check`, `register`,
exit codes and `run` lifecycle as the runner ([`RUNNER.md`](RUNNER.md) §§ 3, 5).
Defaults: state dir `/var/lib/zenithd`, `limits` 30 s / 300 s timeouts and
64 KiB / 1 MiB output. Machine settings:

```yaml
services:   { restartAllow: [nginx.service, "app@*.service"] }
files:      { readAllow: [/var/log/nginx, /etc/nginx/nginx.conf], maxReadBytes: 1048576 }
containers: { enabled: false, socket: /var/run/docker.sock }
exec:       { enabled: false, allowArgv0: [/usr/bin/ss] }
audit:      { path: /var/lib/zenithd/audit.jsonl }
systemctlPath: /usr/bin/systemctl
journalctlPath: /usr/bin/journalctl
rejectUnknownConstraints: false
```

`zenithd check` prints the operations that are enabled. The capabilities sent at
registration and in every heartbeat are exactly that list: `machine.exec`,
`container.*`, `machine.service.restart` and `file.read` are not advertised until
their guard is opened.

## 8. Testing status

The Go suite covers guards, argv passthrough, fixture `/proc` reads, the signed
agent lifecycle and Docker wire parsing. Linux-only process, symlink and unix
socket tests are skipped on Windows; real systemd remains gated behind
`ZENITH_TEST_SYSTEMD=1`. These are fixture/fake-daemon tests, not real Docker,
polkit or fleet verification. No live cloud or systemd verification was performed
in this workstream on Windows.

Cross-language goldens live in `go/internal/machine/testdata/results/*.json`.
`TestResultGoldens` produces them using Go operations over deterministic fixtures
(and the file-read mapper over bounded fixture bytes); TS validates their
normalized args and result data without dropping unknown fields. Regenerate
with `ZENITH_UPDATE_MACHINE_GOLDENS=1 go test ./internal/machine/ops -run TestResultGoldens`,
then run `npx vitest run tests/machines/go-results.test.ts` from the repo root.
Memory and disk fields ending in `Kb` mean KiB, uptime is whole seconds, `load`
is a three-number tuple, and network metrics aggregate interface byte counters.
Fields that were not measured are absent; a CPU sample with no tick delta does
not invent a usage percentage.
