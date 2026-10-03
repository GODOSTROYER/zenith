# Required native Linux guest gate

This source prerequisite is shared by local operators and the existing Go CI job. It adds `linux-guest` to `manifestFor` and the manifest CLI as a native Go contract. Existing Vitest lanes remain separate. The new worktree intentionally starts without the frozen writer; integrate the independently reviewed writer and actual Linux-generated goldens before expecting this gate to pass. This document records requirements, not an executed Linux acceptance result.

The native runner retains the complete `go test -race -count=1 ./...`, authentic regeneration through exact `^TestResultGoldens$`, byte comparison and untracked-fixture rejection. CI retains gofmt, vet, TypeScript golden interoperability and both cgo-free Linux cross-builds. It moves the existing pinned Node setup before guest execution and explicitly sets up and cleans disposable fixtures. No application, daemon or production service starts.

## Exact runtime prerequisites

Use Linux with Node **22.23.3**, Go **1.27.1**, `GOTOOLCHAIN=local`, an unprivileged nonzero UID and nonzero GID, and a working cgo C compiler. Python 3 and util-linux `mount`, `umount`, `flock` must be installed beforehand. Setup/cleanup require explicitly authorized root on a disposable host and actual bind-mount authority. The test runner itself refuses root.

The process must see a persistent ext2/ext3/ext4, XFS or Btrfs **root filesystem**. `/opt` must be a real root-owned nonwritable directory on that root mount; root and `/opt` cannot have access/default ACLs or special permission bits. Overlay, tmpfs, FUSE and network roots fail. A typical Docker overlay root is insufficient. A prepared volume-backed supported filesystem used as the actual guest root/chroot, with real `/proc` fdinfo and required binaries, may satisfy this prerequisite; mounting only `/opt` changes an ancestor mount and remains invalid. No such runtime has been provisioned or executed by this source-only workstream.

POSIX access and default ACL xattrs must really work. Setup writes and reads an actual version-2 extended access/default ACL on disposable inert probes, then removes the probes. The Go tests independently set actual ACLs and demand refusal. `/proc/self/fdinfo` must return mount identities. No production filesystem guard is weakened for CI.

The three exact namespaces must be absent before setup:

- `/opt/zenith-file-write-tests`: test UID/GID-owned0700 root on the supported root mount. Ordinary writer fixtures use unique private children here.
- `/opt/zenith-file-write-golden`: fixed test UID/GID-owned0700 root, initially empty. The actual golden helper creates and removes only its `app`, `templates`, `backups` children.
- `/opt/zenith-file-write-mounts`: root-owned0755 namespace containing root-owned receipts/lease, protected source namespace and four real bind mounts.

Mounted `anchor` and `backup-anchor` are separate exact final parent directories, UID-owned0700. Mounted `nested` contains `parent`, which must exercise refusal of an unexpected ancestor transition. `file-anchor/target.txt` is an actual regular-file bind mount and must exercise refusal below an otherwise trusted parent. Every mount source is inside the disposable mount namespace. Only inert bytes are created. No profile templates, customer contents, credentials or production retained backups enter this fixture tree.

## Shared local commands

Run from a reviewed integrated checkout as the unprivileged test account. Inspect the canonical contract before execution:

```sh
node scripts/ci/gate-manifest.mjs linux-guest
```

On an explicitly disposable authorized host, with all prerequisites already installed:

```sh
set -euo pipefail
export GOTOOLCHAIN=local
unset ZENITH_GUEST_ATTEMPT_ID
export ZENITH_GUEST_FIXTURE_RUN_ID="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(16).toString("hex"))')"
fixture_uid="$(id -u)"
fixture_gid="$(id -g)"
test "$fixture_uid" -ne 0
test "$fixture_gid" -ne 0
sudo -- bash scripts/ci/guest-file-write-fixtures.sh setup "$fixture_uid" "$fixture_gid" "$ZENITH_GUEST_FIXTURE_RUN_ID"
bash scripts/ci/guest-file-write-fixtures.sh check "$fixture_uid" "$fixture_gid" "$ZENITH_GUEST_FIXTURE_RUN_ID"
node scripts/ci/run-guest-file-write-gate.mjs --run
```

After the native command's children have exited, run the same cleanup command on success or failure:

```sh
sudo -- bash scripts/ci/guest-file-write-fixtures.sh cleanup "$fixture_uid" "$fixture_gid" "$ZENITH_GUEST_FIXTURE_RUN_ID"
```

A runner failure does not authorize deleting a fixture tree manually. Cleanup checks the run ID, UID/GID, root inode/device/mount identities, receipt ownership, exact observed mount IDs, a nonblocking exclusive lease, live marker PID, and live process cwd/root/fds/maps before normal unmount and removal. Unexpected mounts or objects refuse cleanup. It never uses lazy/recursive unmount or removes a preexisting root. Cancellation cleanup remains conditional on actually drained users; GitHub `always()` attempts the same guarded action and cannot guarantee execution after abrupt VM termination. A stranded group keeps the runner marker. Permission failures while inspecting `/proc` also refuse cleanup.

A partial setup leaves root-owned receipts and its exact owned namespace for operator inspection. If it interrupted before a complete receipt/lease or between a physical identity change and receipt persistence, automated cleanup refuses. Recover that disposable runtime through reviewed host recovery; do not broaden the helper into global deletion. The root operator and same test account must have exclusive authority over these disposable fixtures. This does not protect against hostile host root or deliberate concurrent same-UID namespace edits.

## Admission and evidence

The manifest commits exact package IDs and explicit required test IDs. Required observations cover create/replace/noop, prior/version/source/capacity/hardlink/ownership refusal, symlink/FIFO/device guards, every fault/cancellation phase, independent postconditions, target/directory/source swaps, concurrent writes, real subprocess crash/restart boundaries, fixed mode and bounded retention, immutable version changes, actual ACLs, actual mounts and `TestResultGoldens/file.write-filesystem`. The crash-child helper passing by itself supplies no crash proof. Every required crash parent/subcase must pass.

The parser requires package starts/terminals, case runs/terminals, valid parent/child and pause/continue lifecycles, every required package, every declared no-test package, and every required case. Empty, malformed, truncated, duplicated, unfinished, failed, skipped-required and missing reports fail. A successful JSON report alone cannot supply process authority: the runner observes close/exit and rejects failed, signal, failed-launch, interrupted or undrained executions. There is no CLI that imports arbitrary reports and claims execution.

Only `TestRealSystemctlAndJournalctl`, `TestRealOpenTofuPlanShowApply` and `TestRealOpenTofuWithProviderAndLockfile` can skip as existing explicit non-required opt-ins. Their separate deployment/OpenTofu acceptance remains required wherever already required. Every other skip refuses this gate. Packages with no tests are explicit manifest entries; they are counted as packages, never leaf cases. Counts distinguish test events, parent cases, leaf cases and package totals. Unit report fixtures are synthetic parser regressions and provide no filesystem/deployment proof.

Raw JSON event streams, stderr and tool/helper output live in exclusively created0600 files under UID-owned0700 `.data-ci-guest/attempt-<32 lowercase hex>`. A fresh cryptographic attempt ID identifies each invocation. Only that invocation's exact `.data-ci-guest/attempt-<ID>/sanitized.json` is eligible for upload. The old fixed `.data-ci-guest/evidence.json` is never read, replaced, unlinked or uploaded. Existing attempt directories are refused, including a previous attempt whose publication failed.

CI's `native_guest` wrapper generates and emits `expected_attempt_id` before running the gate, then sets `ZENITH_GUEST_ATTEMPT_ID` for that child only. The runner records `attempt.id` and `attempt.runnerExitCode` in sanitized evidence. It releases `attempt_id`, `evidence_path`, `evidence_sha256` and `runner_exit_code` step outputs only after exclusive0600 temporary write, atomic rename into the fresh directory and ownership/mode/link/digest/JSON readback. It never emits raw directory/log paths as artifact outputs.

An `always()` selector step uses `--select-current` with the fresh wrapper ID, those four outputs and the independently observed `steps.native_guest.outcome`. It verifies all identities, the closed exact path, file digest,0700 parent and0600 single-link no-follow file, and recorded verdict/exit code against the observed outcome. `success` admits current pass/0; `failure` admits current failure/1 as diagnostic evidence and leaves the job failed. Missing output, a skipped/cancelled/unobserved outcome or a mismatch makes selection fail. Upload runs only after selector success with its exact single-file path; explicit hidden-file inclusion applies to that selected sanitized file. No raw directory/glob is uploaded. A partial output publication of a pass followed by runner failure is refused because the observed outcome disagrees. Directory creation, write, rename/readback or output-publication failure cannot select an earlier passed artifact. The current-attempt sanitized file includes fixed step names/commands, counts, committed required case IDs, process outcome, exact commit and aggregate source hash, package-lock hash, canonical manifest hash, fixture receipt hash, exact Node/Go versions and GOOS/GOARCH. Arbitrary Go names, output, exception strings and environment inventories are never exported. The subprocess environment admits only necessary local tool/cache paths plus fixed manifest flags, excluding ambient GOFLAGS, platform overrides and crash-child configuration. Hashes bind observations to source; they are not a signature against a hostile host/account.

Locally, leave `ZENITH_GUEST_ATTEMPT_ID` unset for a fresh runner-generated ID on every invocation. The final bounded summary names only the exact published sanitized path, or `evidence=unavailable` on early/private/publication failure. That path belongs to this process's attempt; never substitute a historical file when unavailable. `GITHUB_OUTPUT` may be absent locally. A local wrapper that needs automated artifact selection should mint its own fresh32hex expected ID before launch, set it only for the current child, capture the runner outputs in a fresh private file, independently wait for the child exit, and apply the same selector contract. `--select-current` selects metadata for an already observed invocation; it never reruns or imports Go reports as execution proof.

The selector environment contract is exactly `ZENITH_EXPECTED_GUEST_ATTEMPT`, `ZENITH_GUEST_EVIDENCE_ATTEMPT`, `ZENITH_GUEST_EVIDENCE_PATH`, `ZENITH_GUEST_EVIDENCE_SHA256`, `ZENITH_GUEST_RUNNER_EXIT_CODE`, `ZENITH_GUEST_RUNNER_OUTCOME`. Values must come from the fresh wrapper/current runner and its independently observed outcome. No inventory or raw environment values are exported. The artifact-selection regressions use synthetic metadata and disposable temporary files; they provide no native filesystem acceptance.


## Required follow-up verification

Independent helper adversarial checks must cover unrelated/preexisting roots, symlinked roots, unsafe `/opt` mode/ACLs, wrong UID/GID/run ID, altered receipt/node inode/device/mount, unexpected nested/file mounts, a live marker PID, a held shared lease, surviving child fds/cwd/maps after wrapper cancellation, unavailable ACLs/mount authority, and interruption at partial setup boundaries. Run each destructive fixture experiment only in a fresh disposable supported-root guest; never against production `/opt`.

The source author executed none of these checks. Root must independently review GUEST-LINUX-STALE-01 current-attempt binding and run regressions for historical pass plus early directory refusal, write/rename/readback/output-publication failures, current pass/current failure mismatch and missing outputs. Root must run full Node typecheck, affected ESLint and both CI test files with one Vitest worker; Bash syntax plus independent adversarial ownership/receipt/cancellation/cleanup checks in the disposable Linux runtime; workflow validation; full actual unprivileged Linux race including real mount/ACL/version/crash cases; exact authentic Go golden regeneration and byte comparison; TypeScript golden interoperability; existing canonical lanes; before/after source hashes and independent review.

The actual Linux result generator must produce and commit these five files from real measured filesystem execution before the byte comparison can pass: `go/internal/machine/testdata/results/file.write.json`, `file.write-noop.json`, `file.write-replace.json`, `file.write-prior-refused.json`, `file.write-uncertain.json`. No JSON is supplied or simulated by this workstream. Initial fixture bootstrap must precede the native gate: ordinary race includes golden comparison and correctly fails when these files are absent. After exact setup/check above, root may run the following as the unprivileged test account, with a newly created private output directory outside tracked source:

```sh
umask 077
bootstrap_output="$(mktemp -d /opt/zenith-file-write-tests/golden-report-XXXXXXXX)"
ZENITH_FILE_WRITE_TEST_ROOT=/opt/zenith-file-write-tests \
ZENITH_FILE_WRITE_MOUNT_FIXTURES=/opt/zenith-file-write-mounts \
ZENITH_UPDATE_MACHINE_GOLDENS=1 GOTOOLCHAIN=local \
go -C go test -json -count=1 ./internal/machine/ops -run '^TestResultGoldens$' \
  > "$bootstrap_output/events.jsonl" 2> "$bootstrap_output/stderr"
```

Bootstrap output stays private and is removed only through the validated disposable cleanup. Independently inspect those actual Go observations and filesystem assertions, review the generated five JSON files, then commit them as Saivedant before the required native gate. Bootstrap alone is not the full native gate. A fixture failure, missing required case or unsupported hosted runner filesystem blocks the Go CI job and must be resolved through actual prerequisite setup.

The first hosted CI execution, local prepared guest execution, authentic new goldens and all validation remain unverified. Systemd sandbox/deployed service, production startup/retention, worker image execution, cloud access and release acceptance remain separate follow-ups outside this module. No release ledger or production limitations claim is changed.
