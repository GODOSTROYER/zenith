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
| `file.write` | Linux + `fileWrite.enabled` + exact local template profile | canonical `path`, opaque `contentRef`, immutable `contentVersion`, required `expectedSha256` (64 lowercase hex or null for create-only) | bounded unprivileged customer application files only; see below |
| `file.upload` | Linux + `fileUpload.enabled` + exact local binary profile | canonical `path`, opaque `sourceRef`, immutable `sourceVersion`, required `expectedSha256` (64 lowercase hex or null for create-only) | bounded local binary source copied through the same atomic writer; see below |
| `service.configure` | Linux + `serviceConfigure.enabled` + exact local service profile + unit in `services.restartAllow` | allowlisted `.service` `unit`, opaque `profileRef`, immutable `profileVersion`, required `expectedSha256` (64 lowercase hex or null for create-only) | atomic application-config write plus a closed `reload`/`restart` convergence and an active-state postcondition; see below |
| `package.install` | **off** | Debian 12/dpkg 1.21, separate local root helper | pinned offline data-only first install or verified exact-version no-op; refuses unavailable helper |

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
`allowArgv0`) become your only layer. Prefer the polkit route. The `file.write` slice refuses execution as root regardless of this legacy option for other operations.

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

### Customer-local template writes (partial PROD-MACH-01)

`file.write` is an opt-in Linux primitive, not full guest lifecycle acceptance.
Its signed arguments contain only the exact canonical destination, bounded
opaque local content reference, deterministic 64-hex immutable profile version, and prior SHA256 (or explicit null for
create-only). Contents, source paths, URLs, credentials, arbitrary modes,
owners, substitutions and validation commands never enter the envelope.
Signed resource scope and the existing policy decision remain mandatory.
Under the current high-risk policy, agent-origin writes require human approval;
human-origin requests at autonomy level 5 can be allowed without a separate
per-operation approval. When required, human approval comes only through the
authenticated browser and binds the immutable proposal digest. The global
autonomy tier is not an explicit bounded standing grant. Acceptance of scoped
standing grants and the complete guest approval journey remains release work
under PROD-DUR-04; this primitive does not establish that acceptance.
Unknown write-grant constraints are refused; `pathPrefixes` means
canonical directory boundaries and intersects the exact local allowlist.
Existing operations retain their previous constraint behavior.

The operator configures a versioned `fileWrite` profile locally. Versions cannot
be reused with changed profile semantics. `zenithd file-write-versions --config
/absolute/local/config.yaml` reads metadata only and prints exact path/ref/version
triples; copy each version into its local profile before ordinary `check` or
execution. It never reads template bytes, starts an agent, rewrites config or
changes files. A source digest must already be independently pinned locally.

The single Go `FileWriteProfileVersion` helper computes lowercase SHA256 of
UTF-8 `zenith.file.write.profile/v1`, then one NUL byte, then compact JSON in
exact field order: `path`, `contentRef`, `sourcePath`, `sha256`, `mode`, `maxBytes`,
`backupDir`, `maxBackupBytes`, `maxBackups`. Values are canonical exact strings
and integer decimal counts, with no whitespace and no version field. Source
identity is its exact local path plus pinned bytes digest; per-execution inode/
mount identity is separately pinned and rechecked. Every relevant profile or
backup-authority change requires a freshly reviewed version. Config loading
rejects a mismatched reused version; execution recomputes it before any effects
and again before commit. The expected prior digest remains separately signed.
This binding prevents a local profile edit from changing previously approved
request semantics, while preserving the trusted host-operator boundary. Each destination
maps to one ref/version, one regular source file pinned by SHA256, fixed `0600`
or `0640`, and a byte ceiling (at most 1 MiB). Sources and destination parents
must be provisioned already and owned by the service UID; source files may also
be root-owned. Ancestors must belong to root or the service UID, have no group/
world write bits, special directory bits or access/default ACLs, and contain no
symlinks. Existing targets must be regular single-link service-owned files in
0600/0640; templates may additionally be 0400/0440. `0640` uses the process group;
no caller supplies a group. The private backup directory must be service-owned
0700 and has bounded retained transaction/byte capacity. Exhaustion refuses
new writes. The agent never prunes backup, intent or audit files.

All descriptors are opened component-by-component with no-follow semantics.
Exact parent/store anchors must use persistent local ext-family, XFS or Btrfs
filesystems; volatile, network, FUSE and overlay stores are refused. Fsync-based
durability still depends on the operator's storage guarantees; power-loss
acceptance is not established by these source tests.
Targets, templates and backups are verified independently, including mount IDs,
identity, digest, size and permissions. The primitive refuses executable files,
protected system/configuration directories, dotfiles, identity/replay/audit
state, its actual config/audit/state paths and other configured template paths.
Template sources also cannot read the agent's actual state/config/audit/backup
custody.
It makes an exclusive temp file in the pinned parent, writes bounded pinned
bytes, applies fixed mode and fsyncs. Before replacement, it retains a durable
0600 prior-content backup and intent record in private storage. Create also
retains a durable intent. A backup/store failure refuses destination mutation.
Rename uses the same parent descriptor; directory fsync and an independent
no-follow reopen must measure the expected inode/content/size/mode before success.
Noop also measures and fsyncs existing postconditions.

The implementation serializes its own writers and takes a private-store advisory
lock across instances. This is not a filesystem compare-and-swap against an
external process with the same UID. The operator must exclude concurrent writers
sharing that UID or root privilege. Directory/target changes detected after
rename yield `mutation_uncertain`, with phase/effect and opaque retained backup/
transaction references. Cancellation, fsync, readback or completion-audit failure after rename
never says that nothing ran. There is no retry, root/sudo/Docker/raw-exec fallback
or automatic rollback. The service surfaces unknown writes as uncertainty,
including a cached unknown receipt, and retains available bounded phase/backup/
transport evidence. A precommit `effect: none` refusal remains a definitive
failure. A retained intent says `commit-may-have-run`; after crash
or lost reply, independently inspect customer-local state. Any repair requires a
new approval and expected current digest. Reusing an old prior digest refuses.
Temporary files left by process death are not automatically swept.

Only bounded metadata reaches result/evidence/audit; prior/desired template
hashes and plaintext backups stay customer-local except the caller-supplied
prior digest in the signed request. Hashes can identify low-entropy content;
choose profiles accordingly. Sandbox transport refuses this operation.
Non-Linux agents do not advertise it and cannot mutate through this primitive.

Each exact operator-configured destination parent is a trusted mount anchor.
The full ancestor chain is opened no-follow and checked for trusted ownership,
permissions and ACLs. A mount transition is allowed only at that final local
parent, independently at the exact template parent and private backup root;
all earlier transitions and file mounts below an anchor are refused. The
operator may therefore provision a narrow systemd `ReadWritePaths` bind mount.
The agent pins and rechecks directory inode/device/mount identity and rejects
unexpected target/temp/backup cross-mount effects. There is no caller mount
option and no protection promised against hostile host root or an authorized
operator changing the approved mount. `/tmp`, writable ancestors, root
execution and arbitrary mounted subtrees remain refused. `/proc/self/fdinfo`
and local ACL queries must be accessible; failures close the guard.

Required Linux tests run as an unprivileged UID in an owned root-mount tree
(`ZENITH_FILE_WRITE_TEST_ROOT`). The required ACL suite provisions real Linux
POSIX access/default ACL xattrs on its owned fixture and fails if the fixture
filesystem cannot support that check. The separate actual-mount suite requires
operator-provisioned mount fixtures in `ZENITH_FILE_WRITE_MOUNT_FIXTURES`: an
owned `anchor` directory bind-mounted at the exact final parent, `nested/parent`
with a bind mount in an ancestor, and `file-anchor/target.txt` with a mounted
regular file, plus `backup-anchor` as a separate trusted private directory
mount. These are real fixtures, not mocked mount identities. That required
suite fails explicitly when the fixtures are absent. Root coordinates their
provisioning and teardown in Linux verification; source work starts no mount
or service. The candidate hardened example
`deploy/zenithd/zenithd-file-write.conf.example` retains `User=zenithd`,
`NoNewPrivileges=yes`, empty capabilities and only exact application/backup
paths writable. Disposable actual systemd install acceptance remains unverified.
Never broadly open `/etc`, `/usr`, `/var` or host system paths.

Authentic file.write golden generation additionally requires an empty private
service-UID-owned `/opt/zenith-file-write-golden` on a supported local filesystem.
Generic `-run '^TestResultGoldens$'` generation includes its `file.write-filesystem`
subtest;
Linux fails if the owned fixture root is absent, and non-Linux generation fails
explicitly rather than silently omitting new success fixtures. Ordinary
non-Linux comparison does not manufacture a successful mutation mapper.
The helper executes real create/noop/replace/prior-refusal/post-rename-uncertainty
operations and checks retained files before normalizing random opaque receipt
IDs. No other result field is fabricated. That fixed path makes profile versions
reproducible across golden regeneration and comparison. Source work does not
emit these JSON fixtures.

Source changes and written tests are not executed verification. Required gates
remain Node 22 full typecheck, scoped lint/Vitest, Linux gofmt/vet/race and real
fault/swap/crash suites without skipped required cases, actual Linux-generated
Go result fixtures parsed by TS, preserved provider/revocation/security policy
regressions, and separately disposable systemd install/guest acceptance. Upload,
packages, service configuration and privilege-separated host changes remain
unimplemented follow-ups.


## Local binary upload

`file.upload` is a separate opt-in Linux operation. It copies a previously
provisioned, locally pinned regular binary source to one exact allowed customer
application file. Signed arguments are exactly `path`, `sourceRef`,
`sourceVersion`, and `expectedSha256`. Explicit null means create only when the
target is absent. Replacement or verified noop requires the exact SHA256 of the
existing target. There is no wildcard prior state. No bytes, base64, source
paths, URLs, credentials, mode, owner or command can enter a signed upload.
The operation requires its own current operation/resource-scoped capability
grant and the existing approval policy. A file.write grant or profile version
does not authorize file.upload.

The local `fileUpload` object has `enabled`, `backupDir`, `maxBackupBytes`,
`maxBackups`, and `profiles`. It defaults off. Each profile has `path`,
`sourceRef`, `sourceVersion`, `sourcePath`, `sha256`, `mode`, and `maxBytes`.
Reference, path, 0600/0640 mode, 1 MiB source ceiling, at most 64 profiles,
private backup capacity and all Linux ownership/mount/ACL rules are the same
as file.write. Sources may contain non-UTF8 and NUL bytes. They must be
provisioned locally; upload performs no network fetch, extraction, package
installation or executable activation.

`zenithd file-upload-versions --config /absolute/local/config.yaml` reads only
local profile metadata and emits path/sourceRef/sourceVersion triples. It does
not read source bytes, change config, register, start the agent or write files.
Compute and independently review the source SHA256 before deriving a version.
The version is lowercase SHA256 of UTF-8 `zenith.file.upload.profile/v1`, one
NUL byte, and compact JSON in this exact order: `path`, `sourceRef`,
`sourcePath`, `sha256`, `mode`, `maxBytes`, `backupDir`, `maxBackupBytes`,
`maxBackups`. The version field itself is excluded. Config loading rejects a
mismatched version. Execution checks the current enabled exact profile before
any effect and again before commit; changes require a newly reviewed version.

Upload reuses the hardened atomic Linux writer, process lock and private
backup-store flock. Neither operation may overwrite the other's configured
source or private backup custody, including configured backup custody for a
disabled operation. Existing parent directories must already be provisioned.
No symlink, mount-transition, ownership, ACL, backup budget, fsync or independent
postcondition guard is relaxed. Targets on supported exact local mount anchors
can be created or replaced; mounted files below an anchor remain refused.
Unresolved intents and binary backups remain private on the host. Upload
intents additionally record the operation/sourceRef/sourceVersion. Success
returns only bounded destination/version, changed/created/byte count,
postcondition and opaque transaction/backup references. No contents or source
path appears in results or evidence. An outcome lost after rename or audit
failure is uncertain and must not be redispatched; the retained intent is not
a recovery instruction.

Non-Linux, simulated and cloud transports refuse upload. This source slice has
not received native upload acceptance. Root-owned authentic unprivileged Linux,
mount/ACL/race/crash, protocol and exhaustive gates are still required. Prior
file.write native evidence remains evidence for file.write; it cannot be
relabeled as upload or full guest lifecycle acceptance. No standing grant,
installation, browser approval journey or live guest permission is established
by the source/model controls.


### Convergent service configuration (`service.configure`)

Off by default. One approved operation writes one application-owned configuration
file from a locally pinned source and converges one allowlisted systemd service.
The signed envelope carries only `unit`, `profileRef`, `profileVersion` and the
required `expectedSha256` (the exact prior config digest, or null for create-only).
It cannot carry bytes, paths, modes, owners, unit-file edits, command lines or the
convergence action: all of those are local profile fields bound into
`profileVersion`.

Privilege separation: zenithd stays unprivileged and never writes unit files or
anything under `/etc` (the shared writer's protected-path denylist still applies
to the config path). It reaches systemd only through the same
`services.restartAllow` authority `machine.service.restart` uses, and every
profile's unit must match that list at config load. Only unprotected `.service`
units are eligible: ssh, systemd-*, dbus, the SSM agent, zenithd and zenith-runner
are refused in both the TypeScript schema and the guest.

The local `serviceConfigure` object has `enabled`, `backupDir`, `maxBackupBytes`,
`maxBackups` and `profiles`. Each profile has `unit`, `profileRef`,
`profileVersion`, `path`, `sourcePath`, `sha256`, `mode` (0600 or 0640),
`maxBytes`, `action` (`reload` or `restart`) and `settleSec` (1 to 60). It reuses
the hardened atomic Linux writer, process lock and private backup-store flock, so
create/replace/noop, exact-prior-digest, symlink, mount, ACL, ownership, fsync and
backup-budget guards are identical to file.write. It needs its own backup
directory; it may not share a destination or backup store with file.write or
file.upload.

Convergence: after a changed file, zenithd runs `systemctl <action> -- <unit>`
(argv only, never a shell). A byte-identical config on a unit that is not active is
restarted; on an active unit nothing runs (`action: none`). The postcondition is
the unit reporting `loaded` and `active` within `settleSec` (polled, bounded by
poll count). A unit that does not verify healthy after the commit yields a
definite `service_failed` result with `effect: committed` and the retained
backup/transaction refs: the previous file is in the private backup store and
rollback is a new approved operation, not an automatic privileged fallback. A
cancellation or timeout while an action may be in flight yields
`mutation_uncertain` and the request is never re-dispatched.

`zenithd service-configure-versions --config /absolute/local/config.yaml` reads
only local metadata and emits unit/profileRef/profileVersion triples. The version
is lowercase SHA256 of UTF-8 `zenith.service.configure.profile/v1`, one NUL byte,
and compact JSON in this exact order: `unit`, `profileRef`, `path`, `sourcePath`,
`sha256`, `mode`, `maxBytes`, `action`, `settleSec`, `backupDir`,
`maxBackupBytes`, `maxBackups`. Config loading rejects a mismatched version.

## Pinned offline package installation

`package.install` is an opt-in typed operation routed only to the fixed local
root helper. The ordinary unprivileged daemon, read-only operations and exec
policy stay intact. Its signed arguments are exactly `profileRef`,
`profileVersion` and `expectedInstalledVersion`. No package bytes, source path,
URL, credentials or command enter that envelope. The original control-plane
signature and exact machine/resource grant are independently verified by the
root helper; a decoded `ops.Env` call cannot grant package authority.

The supported first slice is Debian 12/dpkg 1.21 on native amd64/arm64. A reviewed
root-owned local `.deb` is pinned by SHA-256/size and complete payload metadata.
Only original ar containing `debian-binary` 2.0, one `control.tar.gz` and one
`data.tar.gz` is accepted; gzip has one member and tar uses ordinary root-owned
ustar regular files/directories. Raw extensions are checked before Go tar
normalization. The control archive contains only a bounded flat `control` file.
All scripts, relationships/dependencies, trigger/conffile metadata, unknown
control fields, PAX/GNU extensions, xattrs, links, devices, special bits and
undeclared payloads refuse. Each profile's data stays below
`/opt/zenith-packages/<profileRef>` with exact 0644/0755 files and 0755 directories.
No installed service or executable launch is implied by copying a file.

Profiles use a purpose-separated version over Debian/dpkg identity and the
complete canonical archive/effects metadata. There are at most 32 unique local
profiles, 4 MiB compressed archive bytes, 256 explicit payload entries, 1 MiB per
file and 8 MiB total file bytes. The helper reads root config at its fixed path
and repeats the exact config/profile/native/claims guards after locks/staging.
All configured file write/upload source, destination and backup custody stays
protected even when disabled. Fixed-root local persistent filesystem, mount,
root ownership, hard-link and ACL guards apply separately to source/state,
native metadata and payload. Direct privileged operators replacing these
approved roots remain outside the supported actor model.

A null prior version is create-only: the package and every payload target must
be absent, without a foreign installed package claiming that subtree. An exact
pinned prior version permits only a complete verified no-op. Upgrade/downgrade,
repair, residual configuration and uninstall paths remain unavailable. Native
incomplete states, pending trigger work and unsupported dpkg options refuse.
Existing strictly framed diversion/statoverride/interest records may remain when
both endpoints and interests are disjoint from every actual archive entry,
shared directory, destination subtree and protected custody. Installed interest
identity and architecture must match the captured native status. Complete raw
registry/config bytes and used local identity inputs must remain unchanged;
missing/ambiguous state, overlaps, unknown flags and foreign identities refuse.
Do not erase native history/configuration as an intermediate step. [Debian
documents partial states and trigger activation, including activation with
`--no-triggers`](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html).

Only the 18 root-observed `/usr/share/` documentation filters join comments,
`no-debsig` and the fixed conventional log in the config allowlist. No glob
engine or text-to-argv conversion supplies permission. The fixed
`HOME=/nonexistent` parent itself must be absent beneath protected root; any
existing file, directory or symlink parent refuses before native admission. The actual no-follow root descriptor must be a root-owned directory without group/other write, special mode bits or POSIX access/default ACLs. This check precedes every child walk and descriptor-relative HOME absence check. Inactive native fragments
remain raw comparison data. Raw `force-unsafe-io`, hooks, redirects and every
other unknown option refuse. The exact observed 259-byte `docker-apt-speedup`
fragment (SHA256 `ab3af717d57cbbea36555833dc1ae031fa46750b879199ec579ee00be9aa0124`)
has a private canonical effective-policy path only: fixed native argv pins
`--refuse-unsafe-io`, and a bounded read-only native check must show only the
observed safe enabled flags. Altered bytes/names/options refuse, unsafe I/O
remains disabled, and original config bytes are preserved throughout. [Debian's
refuse semantics](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html)
apply to the fixed command; callers cannot select policy or argv. Named disjoint
statoverrides require actual protected local passwd/group and files-first NSS
with default success behavior. Readiness, pre-child checks, no-op and post-read
verification all repeat the native admission; this is not account-wide package
lifecycle or concurrent privileged-writer coverage.

The helper holds lifetime flock before replay load and compaction and the real
dpkg frontend fcntl lock across snapshot, preparation and fixed argv execution.
It never reopens/closes that lock inode through backup scanning. An immutable
staged archive, private backup and fsynced accepted intent precede the child.
Success requires exact installed metadata, all payload hashes/modes and
unchanged unrelated native state, followed by a verified intent. Replay and
intent files are separate. Torn records, orphaned preparation and accepted
unknown attempts refuse without cleanup or new-ID retry. Cancellation, timeout,
loss or postcondition failure preserves unknown effects; backup custody is not
rollback or package atomicity.

The socket is root-authenticated, restricted to the configured daemon UID, has
closed bounded framing and rejects ancillary descriptors. Only public profile
metadata or the original signed token crosses it; tokens live only in memory
and are excluded from replay/results/evidence. Results contain verified package
metadata or a fixed refused/uncertain receipt and opaque transaction ref.
Cloud and simulated transports refuse. Other distros/managers, repository
fetch/verification automation, updates, removal, helper rotation, scheduling,
restart recovery and multi-instance crash/fault acceptance remain open. Native
service/privilege, package/parser, lock/race and signed-dispatch tests must pass
on disposable Linux before this source slice is accepted for execution. See
[the local installation procedure](../../deploy/zenithd/INSTALL.md).

Package native status accepts dpkg's empty first line of a multiline `Conffiles`
field while retaining its continuation bytes. It refuses duplicate field names
even when the first value is empty or the spelling differs only by case. Required
installed package identity, architecture and status, pending-trigger checks, raw
native state custody and the fixed safe native command remain mandatory. This
source correction establishes no installed-service or default-backend acceptance.
Recognized identity and pending-trigger names are normalized case-insensitively
without changing the captured raw status bytes.
