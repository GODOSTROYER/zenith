# Pinned offline package install source handoff

This packet adds the first bounded native `package.install` slice for
PROD-MACH-01. It is source-only and awaits independent review and root runtime
verification. It does not close MACH-01, approve a customer installation or
establish the whole package lifecycle. The 40 owned paths are frozen separately
from the reviewed upload dependency; no ledger, native manifest or golden is
changed. The ordinary unprivileged `zenithd.service` remains byte-exact.

The prior unsupported operation now has strict signed metadata arguments:
`profileRef`, a purpose-separated `profileVersion`, and explicit nullable
`expectedInstalledVersion`. The existing signer, typed machine transport,
capability grant, audit/evidence and request limits are reused. Cloud/simulated
transports refuse. Direct decoded operation arguments cannot invoke the root
helper or a caller-supplied runner. The original token stays in private daemon
memory/socket custody and is independently verified by the fixed-purpose root
process. No bytes, path, URL, command, key or credential is in the signed args,
result, replay or evidence.

Supported hosts are Debian 12/dpkg 1.21 on native amd64/arm64. A root-reviewed
local original ar/gzip/ustar data-only package must match exact archive identity,
package/version/architecture and every payload path/kind/mode/size/hash. Only
root-owned regular files/directories under `/opt/zenith-packages/<profileRef>`
are admitted. Links, special modes, xattrs, control extensions, scripts, triggers,
conffiles, dependencies, relationships and unknown effects refuse. This first
slice does not authenticate publisher/repository provenance itself; independent
local verification before pinning remains an operator prerequisite.

Null prior version permits only a genuinely absent package and absent exact
payload targets. Exact pinned installed version permits only a full verified
no-op. Updates, downgrade, replacement, residual state, repair, removal and
wildcards refuse. Helper readiness requires actual eligible archive/native
state and an exact profile set; neither the maximum typed operation list nor an
enabled flag proves executable support. Native registration compatibility is
bounded by the separate seven-path correction below. Incomplete/pending state,
unsupported options, malformed/foreign records and effect/custody overlaps
refuse. Existing state must not be cleared to make the preview green.

The optional root helper has a fixed configuration path, argv and Unix socket,
SO_PEERCRED checks, no network address families, a CAP_CHOWN-only bounding set,
empty ambient capabilities and NoNewPrivileges. The existing daemon is not
granted sudo or additional exec
privilege. Configuration pins all configured write/upload custody even when
disabled, with bidirectional overlap refusal for package source/payload/helper/
archive/replay/intent/native dpkg paths. Descriptor walks reject symlinks,
hardlinks, ACLs, writable/special ancestors and unexpected mounts; native,
source, payload and retained custody require persistent local ext-family, XFS
or Btrfs. Approved fixed systemd anchors are explicit in source. A privileged
operator replacing roots or performing unrelated direct privileged writes is
outside the supported actor model.

Revision2 corrects the installed helper's socket ownership contract within
four of the original 40 paths. Revision1 and its correction-required review
remain immutable. The earlier empty capability bound could not transfer the
new root-owned socket to the nonzero daemon UID; adding CHOWN alone while
keeping chown before chmod would still leave a foreign-owner mode change.
The helper now validates the fresh root-owned socket, sets mode0600 first,
rechecks that same device/inode/type/root ownership, transfers ownership with
CAP_CHOWN, and rechecks the same socket with the configured UID/group0/mode0600
before serving. No CAP_FOWNER, DAC_OVERRIDE, SETUID, SYS_ADMIN or additional
capability is added. The ordinary daemon, all peer/signature/profile checks,
native locks, replay and uncertainty controls are unchanged. No test name or
body changes. All installed-unit syscall/capability, authenticated IPC and
actual dpkg execution checks remain UNRUN; no EPERM or runtime pass is claimed.

Lifetime flock precedes replay-cache loading/compaction. The real dpkg frontend
fcntl lock remains open across native snapshot/preparation/child/postconditions;
no backup/inventory opens and closes either native lock inode. Only fixed
`/usr/bin/dpkg` argv and a clean environment are used. Root-only staging and
backups precede fsynced accepted intent. The 64 MiB retained intent/stage/backup
admission bound counts verified history too and never deletes or prunes it.
Success requires complete native metadata and payload postconditions with
unchanged unrelated native state, then a separate fsynced verified intent.

Accepted partial writes, cancellation, timeout, loss and failed postconditions
remain uncertain. Backup custody is not package atomicity or automatic rollback.
Orphan preparation and torn/unpaired state refuse new attempts; a new request
or grant ID does not clear them. Recovery, rotation, scheduling, durable fault
settlement and additional distro/manager/package lifecycle support remain open.
The helper owns no automatic retry, unlink, history clearance or reconciliation.

All author compiler, project imports, vet/lint, tests, service, database,
container, install and cloud execution are UNRUN. Only stdlib source/Git checks
and explicitly authorized owned-Go gofmt were performed. Root's separately
executed upload acceptance is not package evidence. The original five write
artifacts and prepared upload bytes are read-only except the authorized common
isolation hook and maximum-list model expectation.

The case contract separates Go archive/schema/receipt models, real unprivileged
ancillary IPC control, signed issuer/queue protocol models, local TLS daemon
helper-unavailable control, and four required owning Linux/dpkg cases. The
native first-install test invokes actual fixed dpkg with an original signed
request and retained state; its CP issuer is modeled. It does not prove an
installed systemd helper, peer UID isolation, full default backend/browser
composition or acceptance of a real publisher package. Required native tests
fail if the owned marker/host/filesystem/mount/ACL/custody prerequisites are
missing. Their optional development skips need strict canonical registration
before root integration.

Root must review/run pinned Node 22 compiler, scoped ESLint and the affected TS
machine/signer suites with maxWorkers=1, then owned Go formatting/vet/race and
actual privileged/unprivileged Linux package/helper service/socket/native-lock/
mount/ACL/fault/restart/signature gates. The fixed native marker is
`/run/zenith-package-acceptance-owned` containing
`zenith-owned-disposable-package-install-v1` plus LF. Required Go flag is
`ZENITH_TEST_PACKAGE_INSTALL_REQUIRED=1`. Root provisions private fixed custody,
actual nested/file-mount and ACL fixtures, compatible native Debian state and
explicit trusted public verification keys inside its owned disposable guest;
no author service or install was started. Strict native gate registration,
service lifecycle fixtures and an actual result artifact are outside this
packet. No handwritten golden is supplied.

The initial resumed Git status refreshed only the real index stat cache.
Original preparation raw index SHA remains preserved; its source/stage entries
are unchanged and cached diff is empty. Freeze records the current raw index
before/after private-index work and does not claim the historical raw bytes are
identical. All subsequent Git reads disable optional locks. No source is staged,
committed or imported into root by the author.

Primary implementation references are [Debian dpkg](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html),
[dpkg-deb](https://manpages.debian.org/bookworm/dpkg/dpkg-deb.1.en.html),
[trigger semantics](https://manpages.debian.org/bookworm/dpkg-dev/deb-triggers.5.en.html)
and [maintainer-script policy](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html).
The exact design/addenda, ownership expansions, before/after source hashes,
case names, patch, full/outside inventories, index bindings and verification
commands are in the private freeze receipt.

## Native Debian registration compatibility correction

The separate seven-path source packet is based on the accepted root-owned
package R2 preparation, with newer upload source preserved. Root's read-only
official Bookworm slim probe found dpkg 1.21.23, two dash diversion triplets,
one debianutils File interest, an explicit libc-bin ldconfig interest, empty
Unincorp and exactly 18 `/usr/share/` Docker documentation filter rows. That
probe had PID 1 `sh` and no systemd, so it establishes format inputs only.

The private parser independently recognizes complete LF-terminated triplets,
statoverride fields and File/explicit interest frames. Diversion endpoints,
overrides and interests must be disjoint from the actual parsed archive,
shared `/opt` directories, destination subtree, every configured write/upload
source/destination/backup and helper/native custody. Canonical native package
and architecture identities come only from the captured installed status.
Foreign interests, duplicates/conflicts, unknown flags, ambiguous paths,
partial states, nonempty updates/Unincorp and pending/awaited tuples refuse.
Missing Unincorp is unproven initialization; an absent File can mean genuinely
no interests, as dpkg removes the last empty File registry. The parser does
not follow registrations, settle work or grant permission.

Named override identities require exact protected passwd/group bytes and one
files-first NSS stanza without action overrides (`files` or `files systemd`).
Numeric IDs are canonical bounded native `#` IDs. Used identity data joins the
same raw snapshot, backup and before/pre-child/post digest comparisons. Native
fragment names use dpkg's alphanumeric/underscore/hyphen filter; inactive files
remain opaque but are captured and compared. The only new active config rows
are the exact 18 observed documentation filters. Their `/usr/share/` prefix
must be disjoint from the captured effect frame; no Go glob approximation is
used. The original compatibility revision refused raw `force-unsafe-io`.
The later genuine R11 target contains the exact Docker fragment described in
the effective-policy correction below. Fixed argv includes `--refuse-unsafe-io`;
configuration is never changed. The fixed
`HOME=/nonexistent` parent itself must be absent beneath protected root; any
existing file, directory or symlink parent refuses before native admission.

Readiness and install admission use this frame. The pre-child reread repeats
it after durable accepted intent. The verified no-op now requires a second
complete exact snapshot. Native postconditions repeat admission and require
all original registry/config/used identity bytes and unrelated installed tuples
unchanged. Any unexpected state after accepted intent remains permanently
unknown; the original signing, peer UID, replay, archive, fcntl, CAP_CHOWN-only
helper, ordinary daemon and current-profile checks remain in force.

The original four mandatory native names and flag
`ZENITH_TEST_PACKAGE_INSTALL_REQUIRED=1` are unchanged. Their genuine signed
first-install/no-op case now reads and compares original metadata/config and
unrelated package tuples without clearing the native database. New pure
registration/config models and Linux postcondition models are explicitly
synthetic. They are not native race or installed-service evidence. All author
imports, compiler/tests, services and native operations remain UNRUN.

Root acceptance still needs fresh native four-case execution and separate
owned disposable targets for real overlap/pending/late metadata change
refusals, safe-I/O behavior and actual installed systemd privilege/IPC plus
current default backend dispatch. A direct root test does not establish the
installed helper's available capabilities. Upgrades, dependencies, repair,
removal, maintainer scripts, privileged external writers and package atomicity
remain unsupported. Required new model/gate registrations and genuine backend
acceptance belong to follow-up paths, not this seven-path correction.

Primary format references: [dpkg 1.21.23 diversions](https://raw.githubusercontent.com/guillemj/dpkg/1.21.23/lib/dpkg/db-fsys-divert.c),
[statoverrides](https://raw.githubusercontent.com/guillemj/dpkg/1.21.23/lib/dpkg/db-fsys-override.c),
[interest serialization](https://raw.githubusercontent.com/guillemj/dpkg/1.21.23/lib/dpkg/triglib.c),
and [config fragment selection](https://raw.githubusercontent.com/guillemj/dpkg/1.21.23/lib/dpkg/options.c).
These are format references; no source from them is executed by the author.

### Revision 2: native HOME and identity fidelity

The immutable compatibility R1 has a source correction: refusing only a present
home option file did not prevent a writable or symlink HOME parent from allowing
an independent local writer to create that file after the snapshot. Revision 2
requires `/nonexistent` itself absent beneath protected root, so every existing
parent type refuses. The original native descriptor case now exercises genuine
protected/writable directory, symlink and regular-file parents; an independent
fixed dash child with nonzero UID/GID creates the option file in the positively
owned writable/alias cases. Only exact test-created identities are removed.
Restored absence and unchanged original native database/config are required
before continuing. This direct fixture needs root's existing disposable native
marker and credentials sufficient to start that nonprivileged test child; it
does not extend the installed helper's CAP_CHOWN-only capability set.

Named override resolution now validates the passwd GID as well as UID before
accepting the local tuple. Malformed/missing GID models refuse rather than
allowing a later NSS module to supply an identity; the original valid local
named positive remains. The original four native identities, 64 existing model
leaves and all registry/config preservation, signing, replay, profile and
uncertainty controls remain. Two additive modeled leaves bring the modeled
leaf count to 66 (68 events including parents). All author runtime remains
UNRUN; separate native/systemd/default backend acceptance is still required.


### Revision 3: owning filesystem root admission

Revision 2 correctly refused every existing HOME parent and malformed passwd
GID, but still assumed the filesystem root itself was protected. The descriptor
walker had checked only subsequent child components. Revision 3 validates the
actual no-follow opened `/` descriptor as a root-owned directory without
group/other write, special mode bits or POSIX access/default ACLs before any
child walk. Native capture independently opens that protected root and checks
HOME absence through `openat` on the same descriptor, then repeats descriptor
policy. Caller paths and DTOs supply no parent protection proof.

The original native custody case exercises this private predicate with genuine
fresh directory and file descriptors under its already owned disposable custody
root. Writable/special modes, foreign UID, actual access/default ACLs and a
non-directory descriptor refuse. Each exact control is restored; the genuine
root descriptor identity/policy and complete original native state must remain
unchanged. These controls never chmod, chown, mount or otherwise modify the host,
container or chroot `/`. They use the existing disposable setup privileges and
do not extend the installed helper's CAP_CHOWN-only capability set.

R1 and R2 plus both correction-required source receipts remain immutable. All
four native names, 66 modeled leaves (68 events including parents), raw native
registration/config fidelity, signing, fcntl, profile, replay and uncertainty
controls are retained. Author imports, compiler, tests and services are UNRUN.
Actual direct native execution, installed/default backend and portable canonical
CI acceptance remain separate root-owned obligations.

## Exact native effective safe-I/O correction

Actual root-owned R11 executed the original four native identities with
1 passed, 3 failed and 0 skipped. The three failures reached the shared native
snapshot prerequisite before their main controls: the pinned original Debian
config contains `dpkg.cfg.d/docker-apt-speedup`, 259 bytes with SHA256
`ab3af717d57cbbea36555833dc1ae031fa46750b879199ec579ee00be9aa0124`,
whose sole active row is `force-unsafe-io`. Original and copied native state,
and the independently checked final native registry/config state, were exact.
The failed attempt and cleanup receipts remain historical failures.

Root's actual read-only dpkg1.21.23 observation confirms that the existing
`--refuse-unsafe-io` removes `unsafe-io` from enabled flags while preserving
`security-mac,downgrade`. [Debian documents the refuse/no-force
semantics](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html). The pure
raw parsers remain unchanged and continue to refuse unsafe config. A separate
private canonical path recognizes only the exact named fragment and uses a
local grammar projection; it never changes the original map, config, snapshot,
backup or digest. The same private fixed command builder supplies actual
install argv, including `--no-triggers`, `--refuse-unsafe-io`, the fixed custody
log, `--install` and one generated custody archive. An exact command validator
refuses extra/reordered options, foreign paths, altered env or output capture
before native mutation.

Whenever that exact fragment appears, each actual native snapshot also runs
one fixed read-only `--no-triggers --refuse-unsafe-io --force-help` observation
with the same safe environment and a five-second child timeout inherited from
the operation context. Success requires exit0, no truncation/error and exactly
the observed safe enabled-flags tail;
unknown, partial, duplicate or effectively unsafe replies refuse. The original
raw fragment still participates in all final byte/digest comparisons. Unknown
options, hooks, other unsafe fragments, pending/foreign registrations, custody,
current profile, signing, fcntl, replay and permanent uncertainty controls
retain their prior semantics. After that final proof and staged-byte reread,
exact current config/profile, signed envelope/grant times and caller
cancellation are repeated immediately before validated native command entry.
The existing native signed case adds internal canceled-context, genuine signed
expiry-after-proof and actual owned-config-change-after-proof controls. They
observe the actual `packageCurrent` predicate using a genuine verifier-produced
identity, not a forced delayed end-to-end install or a supplied authorization
callback. Only that positively owned helper config is restored through the same descriptor;
no native database/config is repaired and no new native case name is introduced.

The original 66 modeled leaves and four native identities remain. This adds
31 modeled leaves across finite effective-policy, exact command, native flag
reply and raw postcondition controls. They are source-only declarations, not
executed native evidence. Canonical source-fingerprint/private runtime-helper
rebinding, actual original4 successor, installed CHOWN-only helper/zero-cap
daemon and genuine default backend/queue acceptance remain separate root-owned
follow-ups. No author import, compiler, test, service or native command ran.

## Native status syntax correction, revision 6

The genuine R13 run compiled and passed all seven Linux-only modeled controls,
but the original four native identities ended 1 passed / 3 failed / 0 skipped;
the five signed subcontrols were not reached. That failed receipt stays failed.
The read-only snapshot diagnostic captured native status and all bounded input
files, admitted the fixed safe-I/O output, and recorded zero installed packages.
The first genuine paragraph has `Conffiles:` with no initial value or following
space, then continuation lines. The native status parser's colon-space-only
header check refused that paragraph before any installed tuple was added.

This correction accepts the empty first line and retains the existing
colon-space value form and exact continuation bytes. Field names use the finite
ASCII deb822 syntax, and presence is tracked independently of the value with
case-insensitive duplicate refusal. Recognized identity, version, installed-size,
Conffiles and pending/awaited-trigger field names are normalized without changing
the raw input, so a lone case variant cannot hide pending work. Required installed
status, package identity,
architecture, pending/awaited triggers, bounded reads, locks, protected root/HOME,
raw archive/config/registry comparisons and fixed safe-I/O command are unchanged.
No native database is rewritten. The
[Debian deb822 primary syntax](https://manpages.debian.org/bookworm/dpkg-dev/deb822.5.en.html)
permits an empty first line for a multiline field and forbids duplicate fields;
the internal database format is established by the actual pinned native capture.

All prior 97 modeled leaves, four native names and five signed child names/bodies
are retained. One new Linux-only modeled parser suite adds 24 leaves (121 modeled
leaves and 127 modeled Go events including parents), with empty-first-line and
continuation positives, duplicate/invalid-header negatives, raw-byte preservation,
and actual existing registration-guard checks for missing/pending identities.
These are modeled syntax controls, not a fabricated native database or a native
acceptance receipt. All author compiler/tests/services/native commands are unrun.
Root must separately rebind canonical/private source fingerprints, compile Linux,
execute the new modeled controls and original native four/five signed children,
and verify unchanged raw native metadata plus owned-resource cleanup. Genuine
installed CHOWN-only helper, zero-cap daemon and default-backend acceptance remain
outside this correction.
