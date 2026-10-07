# Installing zenithd on a Linux VM

zenithd is a single static binary (amd64 or arm64) plus a systemd unit. It only
makes outbound HTTPS connections to your Zenith control plane. No inbound port,
no SSH, no cloud credentials. Read `docs/platform/ZENITHD.md` first for what it
can and cannot do.

Everything below runs as root on the VM.

## 1. Get and verify the binary

Build it (`go/build.sh`, see `docs/platform/ZENITHD.md`) or download a release
build, then verify it against the `SHA256SUMS` file published with it:

```sh
cd /tmp/zenith-release
sha256sum --check --ignore-missing SHA256SUMS      # must print "zenithd: OK"
install -m 0755 linux-amd64/zenithd /usr/local/bin/zenithd   # or linux-arm64
zenithd version
```

## 2. Create the service account and the unit

```sh
install -m 0644 zenithd.sysusers.conf /usr/lib/sysusers.d/zenithd.conf
systemd-sysusers                      # creates user "zenithd", member of systemd-journal
install -m 0644 zenithd.service /etc/systemd/system/zenithd.service
```

The unit requires unified cgroup v2. It delegates the `cpu`, `memory` and `pids`
controllers to the unprivileged `zenithd` account; other units remain root-owned.
It keeps an empty capability set and `NoNewPrivileges=yes`, and bounds the whole
service to 512 MiB, 256 tasks and one CPU. `ProtectControlGroups=no` lets the
service use its delegated subtree. Check effective delegation under PID 1 with
the gated harness in `deploy/zenithd/acceptance/`; a unit property alone is not
runtime verification. Kernel/cgroup delegation unavailable: fail the acceptance
check rather than run the agent as root. Adjust resource ceilings in a reviewed
drop-in for a workload that needs more.

## 3. Configure it

```sh
install -d -m 0750 -o root -g zenithd /etc/zenithd
install -m 0640 -o root -g zenithd config.example.yaml /etc/zenithd/config.yaml
$EDITOR /etc/zenithd/config.yaml      # control plane URL, name, what to open
zenithd --config /etc/zenithd/config.yaml check
```

`check` validates the file and prints exactly which operations this machine will
accept. The defaults are read-only: inspect, processes, service status, metrics,
journal logs and network checks.

### Opt in to more, deliberately

| You want | Do |
|---|---|
| restart specific services | list them in `services.restartAllow`, **and** install the polkit rule below |
| read specific files | list prefixes in `files.readAllow`; make sure the `zenithd` user can read them (for `/var/log`: `usermod -aG adm zenithd`) |
| Docker list / inspect / logs | set `containers.enabled: true` and add the user to the `docker` group (**root-equivalent**, read `docs/platform/ZENITHD.md`) |
| `machine.exec` / `container.exec` | set `exec.enabled: true` (and narrow with `exec.allowArgv0`) |

Restart permission, without running the agent as root:

```sh
install -m 0644 50-zenithd-restart.rules.example /etc/polkit-1/rules.d/50-zenithd-restart.rules
$EDITOR /etc/polkit-1/rules.d/50-zenithd-restart.rules     # same unit list as restartAllow
```

## 4. Register and start

In Zenith, create a **machine** registration token (single use, valid for at most
an hour). Put it in a file only the service user can read, register, and delete it:

```sh
install -d -m 0700 -o zenithd -g zenithd /var/lib/zenithd
install -m 0600 -o zenithd -g zenithd /dev/null /run/zenithd-register.token
$EDITOR /run/zenithd-register.token   # paste the token
sudo -u zenithd zenithd --config /etc/zenithd/config.yaml register --token-file /run/zenithd-register.token
shred -u /run/zenithd-register.token
systemctl enable --now zenithd
journalctl -u zenithd -f
```

Registration generates an Ed25519 key on this machine
(`/var/lib/zenithd/identity.json`, mode 0600) and sends Zenith only the public
half. The token is consumed by the registration and is not stored anywhere.

You can also pass the token through the environment for the registration only:
`ZENITH_REGISTRATION_TOKEN=... sudo -E -u zenithd zenithd register`.

## 5. Operate it

Control-plane update intent is exposed at
`GET|POST /api/platform/v1/machines/<id>/update` (the runner route is analogous).
A signed-in workspace admin posts `{ expectedRevision, hold, manifestSha256 }`.
Use `hold: true, manifestSha256: null` to hold automatic remote updates; use
`hold: false` and the SHA-256 of the exact signed envelope at the locally pinned
channel URL to request an update. The control plane cannot choose a different
URL or release key. The response records intent, not machine acknowledgement.
A hold is acknowledged only after the local controller persists it; an already
started stage finishes first. Health checks and automatic rollback still run
while held. A local host owner retains the manual update CLI.

Integration prerequisites are explicit: the storage migration and the small
agent-loop patch described in `docs/build/production/verify/PROD-MACH-04.md`.
Requests refuse with 409 for an agent without `agent.update.control.v1` and 503
when durable storage is absent. Do not deploy the API schema without the loop
integration. The native harness refuses an installed binary without the marker.

| Task | How |
|---|---|
| see what it did | `/var/lib/zenithd/audit.jsonl` (root-readable; one JSON line per request, never file contents) |
| upgrade | replace `/usr/local/bin/zenithd`, `systemctl restart zenithd` (identity and replay cache persist), or enable the signed `update` channel (`docs/platform/RUNNER-UPDATES.md`) |
| update state | `zenithd update status` (running, staged, pending health, rolled back); `zenithd update rollback` reverts by hand |
| undelivered results | spooled durably in `/var/lib/zenithd/spool` and replayed after the next reconnect or start |
| revoke | revoke the machine in Zenith; the agent exits with code 3 and systemd leaves it stopped |
| uninstall | `systemctl disable --now zenithd`, remove the unit, `/etc/zenithd`, `/var/lib/zenithd`, the user |

A revoked or upgrade-required agent exits with code 3 or 4 and is **not**
restarted by systemd (`RestartPreventExitStatus=3 4`). After revocation, register
again with `--force` and a new token. The revocation is also recorded in
`/var/lib/zenithd/revoked.json`, so even a manual start takes no work until the
machine is registered again.

Exit codes 75 (a verified release was staged) and 76 (a release failed its health
check and was rolled back) are expected: systemd restarts the agent with
`Restart=on-failure`, and the packaged binary launches the right release.

## Optional offline package helper

The existing `zenithd.service` continues to run as `zenithd` with empty Linux
capabilities and `NoNewPrivileges=yes`. Package installation requires the
separate `zenithd-package-install.service`; do not add sudo, arbitrary exec or
privileges to the ordinary daemon. This first slice accepts only Debian 12,
dpkg 1.21, native amd64/arm64 and reviewed offline data-only packages. Its
native service, socket, restart and fault acceptance remain a separate gate.

Provision the helper only after approving an exact local package. Verify its
publisher/repository provenance independently and copy the immutable archive
into `/var/lib/zenithd-package-install/archives`. dpkg itself does not authenticate
an archive. No helper network fetch or repository update exists. The approved
profile records its exact archive SHA-256/size, package/version/architecture and
all payload paths, kinds, modes, sizes and SHA-256 values. The only payload root
is `/opt/zenith-packages/<profileRef>`; every contained directory is explicit.
The archive dialect and refusal rules are in `docs/platform/ZENITHD.md`.

Pre-create `/var/lib/zenithd-package-install/{archives,staged,backups,intents}`
and the state root as root-owned mode 0700. Pre-create root-owned mode 0755
`/opt/zenith-packages`; `/opt` also remains 0755. These custody trees and
`/var/lib/dpkg` must use local ext-family, XFS or Btrfs with directory/file fsync.
Unexpected ancestor, nested and file mounts, ACLs, writable ancestors, hard
links and symlinks refuse. Fixed systemd bind anchors may exist only at the
helper's documented roots. No automatic mount, chmod, cleanup or repair occurs.

Copy `package-install.example.json` to `/etc/zenithd/package-install.json`,
root-owned mode 0600, and complete it locally. The deliberately disabled empty
example cannot start the helper. Set the exact persisted machine/workspace IDs,
the numeric `zenithd` UID and existing trusted control-plane public keys. Never
copy registration tokens, private keys, cloud credentials or an authenticated
request into this file. Pin all configured write/upload sources, destinations
and backup directories in its `fileWrite`/`fileUpload` metadata, even when those
operations are disabled. They must remain disjoint from all package, helper,
archive, native dpkg, replay and intent custody in both directions.

Use the canonical `ops.PackageInstallProfileVersion` metadata function to form
`profileVersion`; its input is the complete profile with a blank version and
payload sorted by path, purpose-separated as `zenith.package.install.profile/v1`.
It binds Debian 12/dpkg 1.21 and the whole archive/effects description. The normal
daemon's `packageInstall.profiles` must match the root file's refs and versions.
There is no caller-selected root configuration or decoded permission proof.

Install the optional unit only after completing that review. Its fixed command
is `zenithd package-helper --config /etc/zenithd/package-install.json`. The helper
creates one root-authenticated Unix socket owned by the configured daemon UID,
mode 0600, under `/run/zenithd-package-install`. It accepts only bounded metadata
availability or an original signed machine request. Peer identity and the
original signature, audience, workspace, operation, grant and current local
profile are checked again in the root process. Socket rights/extra fields and
shell/argv/URL inputs refuse. The helper has no network address families and
starts no server API.

Only the dedicated root helper bounds `CAP_CHOWN`; its ambient capabilities
remain empty and `NoNewPrivileges=yes` remains enabled. It validates the fresh
root-owned socket, applies mode 0600 before transferring ownership to the
configured nonzero daemon UID, then checks the same device, inode, socket type,
owner, group and mode before serving. It does not need `CAP_FOWNER`, broader
capabilities or any change to the ordinary daemon. Verify the actual installed
helper and daemon capability sets and authenticated IPC in a disposable native
acceptance run. Direct root tests do not establish that installed-unit result.

Readiness refuses missing archives, mismatched profiles, unresolved/torn or
orphaned custody, a competing frontend lock and incomplete native package state.
Existing diversions, statoverrides and trigger interests are supported only when
strictly parsed and disjoint from the exact archive, shared directories, all
configured profiles and helper/native custody. Complete original bytes remain
captured before, immediately before native entry and after. Pending updates,
Unincorp activations, awaited/pending package states, foreign/unknown interest
identities, overlaps and malformed records refuse. Do not clear or repair native
records to obtain readiness. `--no-triggers` still records activation and cannot
replace this overlap check.

Configuration admission recognizes only comments, `no-debsig`, the fixed
`log /var/log/dpkg.log` and the 18 observed Docker documentation/locale filters
under the literal `/usr/share/` prefix. Native fragment filename selection is
preserved; inactive files still join the exact raw snapshot. Unknown options,
hooks and root redirects refuse. Raw `force-unsafe-io` policy remains refused.
One exact observed 259-byte `docker-apt-speedup` fragment (SHA256
`ab3af717d57cbbea36555833dc1ae031fa46750b879199ec579ee00be9aa0124`)
is compatible only with the helper's private fixed `--refuse-unsafe-io`
command and a bounded native read-only effective-flags check. Unsafe I/O must
be disabled; any altered fragment or other unsafe option refuses. Original
config bytes remain in every snapshot/backup/readback; no config is rewritten.
The fixed
`HOME=/nonexistent` parent itself must be absent beneath protected root; any
existing file, directory or symlink parent refuses before native admission. The actual no-follow root descriptor must be a root-owned directory without group/other write, special mode bits or POSIX access/default ACLs. This check precedes every child walk and descriptor-relative HOME absence check. Named disjoint statoverride
identities require captured root-owned passwd/group data and files-first default
NSS success semantics; other identity resolution refuses. This remains a
limited first-install/no-op slice, not support for every Debian host.

The signed prior-state value is `null` for a genuinely absent package and every
payload destination, or the exact pinned version for a fully verified no-op.
Upgrades, downgrades, residual configuration, repair, removal, dependencies,
maintainer scripts, conffiles, triggers, links, devices, capabilities and special
mode bits are unsupported. There is no wildcard write or arbitrary package
name/version request. The root helper stages and fsyncs the pinned archive,
retains a private native-state backup and accepted intent, then invokes fixed
`/usr/bin/dpkg` arguments with a clean environment while holding its actual
frontend fcntl lock. It verifies native metadata, all payload bytes/modes and
unchanged unrelated state before recording success.

Accepted partial effects, timeout, cancellation, lost response, failed
postconditions and incomplete intent persistence remain uncertain. Backups do
not establish package atomicity or implement rollback. The lifetime lock is
held before replay-cache load/compaction; distinct fsynced replay/intent records
survive restart. Unknown custody blocks new attempts, including new request
IDs. Nothing deletes, retries or prunes it. Investigate under an independently
approved recovery procedure; restarting or removing state is not safe retry
approval. Evidence contains metadata and opaque transaction refs, not package
contents, paths, tokens, keys or dpkg output.

Native dpkg status must remain an initialized installed database. Its multiline
`Conffiles` field may start with an empty value on the header line; continuation
bytes are retained exactly. Duplicate fields (including case variants), malformed
headers, missing package/architecture/status, and pending or awaited triggers
remain refusal conditions. This syntax support does not change native metadata,
configuration, helper privileges or the requirement to run genuine native tests.
Recognized identity and pending-trigger names are interpreted case-insensitively;
their original raw status bytes remain part of the captured state.
