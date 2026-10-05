# Canonical direct native package gate — 2026-10-05

This source packet adds the four existing root package cases to the canonical
Linux guest gate. All123 prior writer/upload identities and the exact three
optional systemd/OpenTofu skips remain required as before. The race phase retains
`./...`, `-race`, `-count=1` and cgo; an anchored `-skip` expression routes only the
four root names to a second **mandatory** phase. The combined named requirement
set is127, derived from123+4. No modeled parser leaf is native acceptance.

The unchanged canonical local/CI entry is
`GOTOOLCHAIN=local ZENITH_GUEST_ATTEMPT_ID=<fresh32hex> node scripts/ci/run-guest-file-write-gate.mjs --run`
after the existing explicitly authorized writer/upload fixture setup. CI checks
Python3.10+ and Docker presence before launch. The unprivileged runner creates a
fresh private attempt, captures actual exits and uses the existing Go event
validator for race123, package4 and exact golden phases. It publishes only the
current atomic sanitized receipt; raw streams, native state, archives, Docker
context details and private records are never selected for upload. The existing
source/commit/lock/manifest fingerprints and observed CI outcome remain required.

The package phase requires a local Unix Docker endpoint and matching actual Linux
amd64 or arm64 host, server, image, Go1.27.1 and dpkg architecture. Every Docker
command is pinned to the originally inspected Unix endpoint, while descriptor
rechecks reject context changes. The immutable official Debian index is
`sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251`;
the exact native child is selected from that fixed index and verified after pull.
Registry pulls use only a fresh private empty auth configuration; no ambient
Docker registry account/helper is selected. No QEMU, host/bootstrap package installation, tool
download or metadata repair is provided.
The actual pinned CI Go distribution and complete current Go source are copied
into the guest from bounded local snapshots with exact source readback.

A fresh labeled volume,2.5GiB ext4 loop image and private chroot carry the original
Debian12/dpkg1.21.23 registry/config bytes. Copy verification precedes fixture
creation; protected registry/config readback follows the tests. The fixed marker,
root custody, actual declared bind mounts and access ACL are created only inside
this disposable root. The container has network:none, read-only image, sole owned
volume,2GiB memory/2CPUs/512PIDs and only setup capabilities SYS_ADMIN, SYS_CHROOT,
MKNOD, CHOWN, SETUID and SETGID. It has no host binds or blanket privileged mode.
If the actual daemon reports AppArmor enabled, only this trusted fixture receives
the fixed `apparmor=unconfined` option with exact HostConfig readback; default
seccomp remains enabled. This is not an untrusted-build isolation claim. See
[Docker's AppArmor documentation](https://docs.docker.com/engine/security/apparmor/)
and the root-authorized2026-10-05 fixture boundary. Product unit CAP_CHOWN,
NoNewPrivileges/empty ambient set and the ordinary zero-cap daemon are unchanged.

The four native identities are:

- TestPackageHelperNativeNoFollowAndCustody
- TestPackageFrontendLockIndependentProcess
- TestPackageNativeSignedFirstInstallAndNonReplay
- TestPackageNativeDeclaredMountAndACLRefusals

Only their root phase sets `ZENITH_TEST_PACKAGE_INSTALL_REQUIRED=1`. It includes
the existing signed foreign audience/operation/workspace/resource/constraint
children and protected-root/HOME controls without inventing native state. Missing,
failed, skipped, duplicate, foreign, malformed, truncated, output-only or zero
Go observations fail through the existing validator. Source deletion cannot
satisfy these literal requirements. An earlier private direct-helper receipt is
never read or accepted by this canonical path.

Every Docker mutation, including exec/cp/pull/create/stop/remove, receives a private
uncertainty pin **before launch**. Only observed exit0, a drained CLI process group,
actual empty ExecIDs for exec, unchanged local context and durable successful
completion bookkeeping release it. Timeout/signal/nonzero/lost reply/parse or
bookkeeping failure keeps the pin; resource presence and read probes cannot clear
it. Cleanup refuses an unknown delivery. Exact owned loop backing identity and
mount targets precede detach. Pinned util-linux2.38.1 unbound admission requires
the actually observed exact six-field singleton (same device, four null binding
fields, ro:false); empty/partial/duplicate/foreign/unknown replies refuse. Atomic
fixed-device attach has no retry or takeover. Attached device scalars accept only
ASCII-space-padded numeric major:minor from the observed util-linux2.38.1 reply,
then compare the trimmed scalar to the exact original backing device. Tabs,
newlines, noncanonical or foreign devices never establish ownership. Own-file association absence precedes backing-volume
removal, and positively owned container/volume/new-image absence plus preserved
baseline inventories precede terminal success. The helper releases raw current Go
events only after this cleanup and its exclusive0600 terminal record. The runner
reads that current record with no-follow owner/mode/link checks and adds only fixed
image/architecture/env/state/source digests and cleanup scalars to existing evidence.

Read-only source dependencies are the prepared65 composition43b35f6b, accepted
cleanup23, package40R2 and compatibility7R3 candidate5777f8e3/freeze8fcfd720.
The prior upload daemon source fingerprint is rebound to the accepted package
addition while its original upload declarations and49 identities are retained.
Platform1059, workflows58, canonical PostgreSQL80, packaged-worker22, Linux
optional3, all existing verifier/matcher/report checks and accepted migrations are
outside this change. The previous schema/native/provider failures and review
receipts remain immutable.

Authored controls cover exact phase routing/declarations, each native4 missing,
failed, skipped and substituted case, zero/malformed/foreign/duplicate/truncated
streams, actual observed nonzero/signal/launch failure and source deletion, plus
isolated private mutation-pin/completion/context/ExecIDs models. These are source
and model controls, not observations of Linux or installed services.

UNRUN by author: compiler/lint/actionlint, all CI model tests, the canonical Linux
runner, Docker/native4, native amd64/arm64 job execution and installed CHOWN-only
helper/default backend/full lifecycle. Independent source review and root-owned
native execution are required before integration or MACH/CI acceptance. A source
pass and the private ARM64 direct helper do not supply portable canonical CI proof.

Revision2 preserves the first immutable source packet and root R8 native0 failure.
Docker29.1.3 refused archive copies into the read-only container rootfs even with
its private `/tmp` tmpfs. Both fixed Go/source archive destinations, extraction
inputs and final removal now use `/guest/go.tar.gz` and `/guest/source.tar.gz` on
the same sole owned writable volume. Read-only rootfs, setup capabilities, mount
ownership, source binding, uncertainty pins and all127/123+4 identities remain
unchanged. This transport correction supplies no native execution result.

Revision3 preserves R1/R2 and adds only `NODE_ENV: "test"` to the two new isolated
Python model child environments, alongside the existing PATH value. This matches
the locked Next ProcessEnv contract without broadening child environment input or
using a type cast. All native identities, model titles and admission guards remain
unchanged; compiler and model execution remain root-owned and unrun by author.


The next actual private attempt R9 copied the public Go archive successfully but native execution remained at zero: its donor ownership was UID 501/GID 20, mode 0600, single link. Fixture root intentionally has CHOWN without DAC_OVERRIDE or FOWNER, so it could not read that file. Revision4 admits only the three freshly staged public paths `/guest/go.tar.gz`, `/guest/source.tar.gz`, and `/guest/rootfs/root/probe.go`. It checks regular/no-symlink/single-link/exact bounded size and known host bytes, transfers those files to UID/GID 0 before chmod or reading, recaptures the same inode/device/type/size, checks mode0600, and verifies the earlier SHA. Both public archive extractions use `--no-same-owner`. The actual Debian `cp -a` and original registry/config bytes are unchanged. Fixed file checks use the existing mutation pin; no capability or rootfs permission is added.

The existing source admission case adds isolated staging refusal controls for foreign/native metadata paths, links, types, size bounds and changed SHA plus fixed ordering assertions. Native4, old123, three optional skips, worker22 and the eight title templates/nine expanded source cases stay unchanged. Revision4 and private helperR10 are separate source packets. All new code and controls remain unrun by the author; root must execute the native prerequisites, original four cases and checked cleanup before any acceptance. Installed service/default backend/full lifecycle remain separate.


Actual private R10 passed public-tool ownership and preservation of the real Debian image, including actual Go1.27.1 ARM64, but still executed zero native cases: Docker daemon could not resolve `/guest/rootfs/root` through the runtime-created loop mount. Revision5 copies the generated public probe to the daemon-visible sole owned volume at `/guest/probe.go`, applies the same original-byte staging guard there, then uses the already pinned execution path to copy it to the previously absent `/guest/rootfs/root/probe.go`. Both guest parents must be no-symlink root-owned mode0755 directories. The copy recaptures protected parent and source identity, destination regular/single-link UID/GID0 mode0600 size and the earlier known SHA before compiling. This changes fixture transport only. Debian metadata/config, caps, read-only root, mount/loop ownership, uncertainty pins, native4 and all prior counts stay unchanged. Root-owned real native execution and cleanup remain required; no source-only pass is inferred.
