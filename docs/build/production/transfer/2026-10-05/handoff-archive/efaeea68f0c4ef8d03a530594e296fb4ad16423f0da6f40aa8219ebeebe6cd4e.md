# Guest file.upload v1, 2026-10-05

This bounded source slice implements an opt-in customer-local binary source
profile for native Linux zenithd. A signed upload contains only an exact
canonical destination, opaque sourceRef, purpose-separated sourceVersion and
an explicit absent-target or exact prior-SHA256 precondition. Sources are
provisioned locally and pinned by digest. Arbitrary URLs, inline bytes,
credentials, owner/mode changes, shell commands and raw-exec fallback are
refused. Both absent-target create and exact replacement use the existing
hardened atomic writer.

The exact prepared dependency is root60 tree
`479d5284346e6b1e880760e74cf452584e94c1a7` over
`8ee702d8fc4e7e01e01dd6a1da36eb65c96d04da`. The 31 owned paths include the
explicitly approved signed-envelope admission in runners/payloads.ts and its
existing real signing/queue fixture.
The independent prepared inventory and expansion receipt are in
`logs/guest-upload-20261005`. Root preparation is a read-only prerequisite.
All other prepared files must remain exact.

The private writer purpose selector uses the actual locally loaded config and
never clones Env or accepts a version callback. Old file.write canonical
metadata/domain and result/intent fields remain unchanged. Upload has a
separate profile version domain and current enabled-profile lookup before
execution and before rename. Both purposes share the process mutex, private
flock, exact local mount anchors, no-follow descriptors, ACL/UID/mode rules,
source and prior-state checks, bounded retained backups, atomic rename/fsync
and independent postconditions. Configured sources and backup custody cannot
be overwritten across purposes, including custody configured for a disabled
operation. Only enabled destinations gain mutation admission. No backup or
intent is pruned. Linux rename is not a conditional filesystem CAS against
external same-UID or root writers; operators must exclude those concurrent
writers. Detected post-rename changes remain uncertain.

Upload successes bind sourceVersion and their signed create/replace kind.
Unverified or contradictory receipts are uncertain. Completed unknown effects
retain their existing cache/evidence custody and nonretryable classification.
The simulated and cloud drivers refuse uploads. Metadata-only version commands
read no source bytes. No upload source, binary or secret values enter signed
envelopes, result/evidence summaries or fixed diagnostics. Private local binary
backup files remain necessary recovery custody, just as for file.write.

Go tests add genuine filesystem binary create/replace/noop, exact prior/source
refusals, source/profile changes before effects/rename, real ACLs, real configured
mount anchors and mounted-file refusal, concurrent cross-purpose backup
capacity, cancel/fault/uncertain custody, metadata CLI and audit failure
controls. They use the unchanged required unprivileged persistent Linux fixture
admission. The existing file.write mount/ACL/crash harness and five authentic
goldens are untouched. Only the obsolete signed upload unsupported rejection
becomes a default-disabled rejection in the existing agent end-to-end model;
all surrounding grant/replay/approval/state controls remain. An additive
Linux control drives actual scoped signed grants through owned TLS polling,
the real daemon/verifier/replay/audit and the registered upload kernel. It
checks binary create and exact replacement, retained prior backup, audience/
capability/operation/workspace/resource/path/inline-data refusals, zero
rejected effects and no replay. The issuing control-plane fixture is modeled.
Non-Linux executes only the explicit unadvertised-operation branch, and is
not evidence for the Linux path. A second signed control requires the fixed
private, empty /opt/zenith-file-upload-golden root and computes its version
from exact deterministic profile paths. It validates the actual retained
intent before normalizing only transactionRef. Every Linux run compares the
actual receipt to file.upload.json; only ZENITH_UPDATE_MACHINE_GOLDENS=1 may
write that artifact, after every control and daemon drain succeeds. No
artifact was generated or hand-authored in this source packet. TS controls model
signed-boundary validation, grant scope, result custody, privacy and an explicit
runOnce cache protocol. They establish no native filesystem, durable-store,
live/default authority or customer guest acceptance. The TS models do not
exercise the native daemon or filesystem. The
existing runner fixture additionally uses actual signing/queue logic and
independent node:crypto signature verification with modeled authority
transport. It checks exact operation/grant and tenant isolation without
logging compact grants; this does not prove default/native authority.

No author project imports, compiler, lint, tests, dependency installation,
services, database, Docker, cloud calls, staging or commits ran. All checks
below are root-owned and UNRUN for this exact packet. Source review cannot
substitute for native acceptance. The original 801-leaf file.write evidence
and ledger history remain unchanged, and PROD-MACH-01 remains open.

Root verification requires the pinned Node 22 compiler/scoped lint and affected
machines/payload suites with maxWorkers=1, plus a fresh owned persistent Linux
fixture at ZENITH_FILE_WRITE_TEST_ROOT and genuinely mounted fixtures at
ZENITH_FILE_WRITE_MOUNT_FIXTURES, using the existing native Go gate before its
full race/exhaustive suite. Root must separately prove privileged refusal,
actual authenticated upload protocol/approval/replay and crash-restart
behavior, including the newly authored daemon-path control on Linux. The
separate fixture helper must first own/provision/check/drain/clean the fourth
fixed upload golden root; its current three-root implementation is unchanged.
Root alone captures go/internal/machine/testdata/results/file.upload.json
from successful exact Linux execution. The existing strict go-results success
completeness assertion is unchanged and requires this authentic new artifact.
New upload case identities and actual native admission must be registered through a separate canonical gate packet; no manifest or golden
was changed here. The shared-kernel source tests and old native evidence do not
prove that the new registered operation satisfies those future gates.

Precise source-only verification commands, all UNRUN:

```sh
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/typescript/bin/tsc --noEmit
PATH=/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin:$PATH node node_modules/vitest/vitest.mjs run tests/machines/args.test.ts tests/machines/service.test.ts tests/machines/zenithd.test.ts tests/machines/file-write.test.ts tests/machines/file-upload.test.ts tests/runners/dispatch.test.ts --maxWorkers=1
```

After independently reviewed fixture/gate integration and actual golden
capture, root runs the existing canonical Linux command:

```sh
ZENITH_GUEST_ATTEMPT_ID=<fresh-owned-attempt> node scripts/ci/run-guest-file-write-gate.mjs --run
```

The underlying required native command remains go test -json -race -count=1
./..., with the existing pinned Go 1.27.1 and explicit disposable unprivileged
fixture provisioning. Scoped ESLint covers only the changed TS paths listed
in the freeze. No dependency link is fresh-install evidence.

Outside ownership: scripts/ci/gate-manifest.mjs,
tests/ci/guest-file-write-gate.test.ts and
scripts/ci/guest-file-write-fixtures.sh canonical registration/fourth-root
custody; root-generated upload authentic golden; live unprivileged Linux and browser/agent approvals,
remaining guest lifecycle operations, and stale upload rows in the capability
matrix. None is completed by this packet. No destructive retention or wider
authority is proposed.
