# Mac mini verification handoff, 10 October 2026

## Read this first

This is the current migration entry point for the **verifying agent**, not a new product-build program. It supersedes stale machine, identity, CI and permission summaries in older chronological notes. Keep the verifier scope and acceptance rules in [HANDOFF-VERIFIER.md](HANDOFF-VERIFIER.md), [VERIFY-QUEUE.md](VERIFY-QUEUE.md), and each `verify/<ID>.md`. Preserve all 78 production requirements, acceptance criteria and required evidence levels. Do not restart completed wave-8 work or replay historical patches.

The user requests continuation on a new Mac mini with 24 GB RAM and a faster CPU described as M6. Detect actual CPU, RAM and architecture; that description is not hardware evidence. This request transfers owned disposable local verification to the new Mac and supersedes the earlier instruction to use only the old Mac. It does **not** authorize live cloud calls, spend, real DNS, private GitHub App acceptance, security exceptions, retention decisions or production approval.

Old-machine verification remains paused. This publication transfers state; it runs no product acceptance and starts no background work. The receiving agent may resume the existing verification program after integrity, source, permissions and resource checks.

## Exact starting state

- Repository: `https://github.com/GODOSTROYER/zenith`; branch: `codex/production-2026-10-02`.
- Latest code/evidence baseline inspected: **`28ea0b75c4c25047cf3e5221a9eb456cbb47d1f7`**. This handoff is published in a descendant. Preserve all newer builder commits; never reset to this baseline.
- Ledger recomputed on 10 October: **9 verified / 67 in progress / 2 planned**, across 78 requirements. These are acceptance states, not a completion percentage. All four release states remain false.
- Root had no tracked modifications. The older pause note was untracked and is included in this publication. User `.DS_Store` files and `docs/product-discovery/` were not included or removed.
- The two unfinished source candidates and two runtime templates are now in the [transfer bundle](transfer/2026-10-10-mac-mini/README.md). They were outside the published checkout before this handoff. No candidate has been silently integrated.
- Existing agents were interrupted or completed at pause. Their old names do not prove a live harness on the new machine. Inspect actual available agents and processes; launch only relevant independent work.

Read, in order: this guide; HANDOFF-VERIFIER; RESUME; PROGRESS; REQUIREMENTS and ledger; VERIFY-QUEUE; `verification/RESULTS-2026-10.md`; current `docs/LIMITATIONS.md`; relevant verify runbooks. [PAUSE-2026-10-08.md](verification/PAUSE-2026-10-08.md) preserves the earlier exact local state, including private old-host locations. Its at-pause running-job status is historical and superseded below.

## Source retrieval and integrity

For a new checkout:

```sh
git clone --branch codex/production-2026-10-02 https://github.com/GODOSTROYER/zenith.git
cd zenith
git fetch origin codex/production-2026-10-02
git status --short
git rev-parse HEAD
git merge-base --is-ancestor 28ea0b75c4c25047cf3e5221a9eb456cbb47d1f7 HEAD
python3 docs/build/production/transfer/2026-10-10-mac-mini/verify.py
```

For an existing checkout, inspect status and worktrees first. Preserve uncommitted files, then use `git pull --no-rebase` and merge newer source. Stop and report conflicts or integrity failures rather than resetting or rewriting history. Later explicit user instructions supersede the old handoff's `--ff-only` wording. Before **every push**, pull with `--no-rebase` again and inspect what changed.

New commits must have author **and committer** `Arnav Bule <arnav.bule05@gmail.com>`. Old Saivedant commits stay unchanged. Example:

```sh
GIT_AUTHOR_NAME='Arnav Bule' GIT_AUTHOR_EMAIL='arnav.bule05@gmail.com' \
GIT_COMMITTER_NAME='Arnav Bule' GIT_COMMITTER_EMAIL='arnav.bule05@gmail.com' \
git -c user.name='Arnav Bule' -c user.email='arnav.bule05@gmail.com' commit -m 'PROD-CI-08: describe the specific verified fix'
```

No trailer, em dash, force-push, history rewrite or secret-scanning bypass. Use requirement-prefixed, descriptive commits. Push only the authorized branch.

## Freshly inspected CI baseline

All runs below target exactly `28ea0b75`, inspected again on 10 October. [Machine-readable complete job inventory](transfer/2026-10-10-mac-mini/evidence/ci-28ea0b75.json).

| Run | Terminal result | Scope |
|---|---|---|
| [37798520911](https://github.com/GODOSTROYER/zenith/actions/runs/37798520911) | 12 success / 7 failure / 1 cancelled | Main CI, all 20 jobs terminal |
| [37798520926](https://github.com/GODOSTROYER/zenith/actions/runs/37798520926) | 2 success | Native packaged workers: AMD64 and ARM64 separately, each 22 passed / 0 failed / 0 skipped |
| [37798520928](https://github.com/GODOSTROYER/zenith/actions/runs/37798520928) | 2 success | Native Windows ACL and Linux systemd jobs |

Main successes: policy; workflow-history-replay; operation-gates (workflow-intents); generated; operation-gates (reconciliation); platform-postgres; adversarial; postgres; tofu; workflows; wave5-contract; ledger.

Main failures: **hosted, build, supply-chain, docker, go, recovery, agent**. `verify` was **cancelled**, not passed. Across all three runs: 16 successful jobs, 7 failed, 1 cancelled. Job successes do not mean every project test ran or zero tests were skipped. Windows evidence includes one actual ACL case with 15 excluded cases in its scoped historical report. Do not sum overlapping lane test counts.

Fetch current branch runs and failed-job logs before fixing anything. This handoff's own publication CI and later builder CI are separate from this baseline. If CI cannot be awaited in the session, record exact SHA/run IDs as pending, never green.

## Immediate repair queue and packet status

| Priority | Finding / remaining work | Existing state | Next concrete action |
|---|---|---|---|
| 1 | Supply-chain MCP advisory `GHSA-6qxp-vccf-f47h` | Client 2.0.0 finding; 2.2.0 client/core replacement was identified but not authorized or implemented | Refresh primary advisory, lockfile and reachability; propose exact minimum dependency scope to the user. No self-approved exception or unrelated upgrade. Earlier sharp/26-companion approval does not authorize this chain. |
| 2 | Go ordinary lane rejects unexpected `TestSystemdSignedUpdateAndRollback` skip | 154 ordinary required cases passed; strict gate correctly failed | Finish and independently review SYS1 draft; execute the real owned PID1 case and preserve mandatory ordinary execution and strict aggregate identity checks. |
| 3 | Hosted gateway login nonce binding | Independently reviewed sole-file candidate, not committed or runtime accepted | Reconcile the packet against current source, review any changes, then run actual local hosted protocol journey including refusal/replay controls. |
| 4 | Agent journey double approval 403/403 | Synthetic IdP lacks AAL2/live verified TOTP metadata; exact cause not uniquely proved | Inspect exact response and deterministic authority composition; narrow fixture repair with independent security review. Never bypass MFA or requester separation. |
| 5 | Recovery CI remains failed | Private shared TMPDIR repair `1d99b5e2` is already in `28ea0b75`; its targeted 120 checks and compiler passed | Read latest failed recovery log. Do not repeat the old diagnosis as if it proves the successor cause. Execute actual recovery lane after minimal repair. |
| 6 | Build and Docker Next heap OOM | Typecheck-only 5120 MiB setting is already fixed; Next/image memory is separate | Measure failing phase and runner/host budget, then apply a bounded build/runtime allocation fix and execute both complete lanes. Do not disable compiler/lint or gate steps. |
| 7 | Cancelled whole verification job | No complete combined successor verdict | After coherent fixes, run complete gates and inspect every exact-SHA remote job. |

### SYS1 draft: incomplete, not approved

Bundle: `candidates/sys1/`, four owned paths: `scripts/ci/gate-manifest.mjs`, `scripts/ci/run-guest-file-write-gate.mjs`, `scripts/ci/guest-pid1-fixtures.py`, `scripts/ci/guest-pid1-owned-guard.py`. The tracked patch includes only the first two; the new Python files are separate. No actual engine execution or independent final review exists.

Required design: route only the exact SYS1 case out of the ordinary race invocation **together with** mandatory owned systemd/PID1 execution in the same strict aggregate result. Retain 154 ordinary required identities, three finite allowed-skip rules, six update controls and native100 unchanged. Add one unique actual SYS1 identity: 159 total versus the existing 158. Do not add a fourth skip waiver or use tags alone. The inert/unprivileged Linux systemd lane is not this root/PID1/cgroup update case. Capture source/environment, actual test exit, bounded Go JSON, cleanup and ownership evidence. Review the draft before running it.

### Hosted candidate: source reviewed, actual journey pending

Bundle: `candidates/hosted/`; full source SHA-256 `d69fcd37d9b3fbe8de8245bc931cd24f943d8a1bcfbf83da46c0a6a0e068cfcc`. Sole owned path: `scripts/hosted-acceptance.ts`.

It obtains actual gateway sign-in state and the `__Host-zenith_login` nonce, enforces origin/host/path and Secure/HttpOnly/SameSite/no-Domain attributes, binds the supported exchange to that state, proves missing/wrong-browser nonce refusal before valid consumption, clears the nonce and refuses replay. Original journey checks remain. Lint/syntax and independent source review passed; the actual journey has not run. This is a **synthetic-identity local hosted protocol fixture**, not genuine Supabase MFA, real browser Secure-cookie behavior or default-stack product acceptance.

### Supervisor142: scoped historical pass

Native Linux ARM64, Node 22.23.3, UID 10001, no capabilities: **142 passed / 0 failed / 0 skipped**, consisting of six actual process-group cases and 136 source/report models. Source/custody review accepted; 67 phase exits zero, 44 host process groups independently absent, baseline Docker parity restored. Minimum observed disk 18,617,212,928 bytes. Receipt SHA-256 `debb725611bbfb094b4d77a63e3285c6d6ebde2272c50e08be8e961b02d81375`.

Full raw case JSON was deleted with the owned volume. Strict checker hash/stdout and summary remain, but all 142 raw case identities cannot be reconstructed. Preserve this limitation. The bundle supplies the historical runner/runtime/dependency projection/contract, not a new-source acceptance. Capture bounded raw reports before cleanup in future runs.

### PID1 runner-update R2: reviewed, actual run not started

R2 runner SHA-256 `45d373690ac3f6822d39b7e587f5bb90bccce993fcceec282796624f60a74e9d`; FREEZE SHA-256 `46ee0d8545c5e4e134bf03fbb11c468a666e2f3f3c76b3e30e315dce1e7fd400`. Source review and zero-build/container preflight passed. Actual R2 execution remains pending.

Original attempt failed at setup image metadata assertion, **zero tests**, before creating a PID1 test container. Its cleanup flag excluded a retained image; separate exact-owned image removal later completed. Preserve both facts. R2 admits only empty RepoDigests or the exact unique owned repository at the exact loaded image ID, retaining owner/tag/architecture checks and exact-ID nonforced deletion plus ID/tag absence verification.

The fixture uses native ARM64 systemd PID1, a 512 MiB privileged private-cgroup, network-none disposable container and a separately owned bounded apt builder. This privilege is fixture-specific, not packaged-worker least-privilege evidence or host systemd installation. It exercises register/revoke/rotate/signed update/rollback against a synthetic control-plane protocol, not the entire default MACH-04 journey.

### Rebind runtime templates safely

Historical runtime templates deliberately contain old absolute paths, Docker socket endpoints, tool hashes and the exact old source inventory. New checkout path, added handoff files, tools or merged builder source invalidate them. Do not execute unchanged, disable guards or edit only expected hashes to make them pass. Create a new owned packet outside the repository, regenerate complete source/tool contracts from the intended coherent checkout, inspect its mounts/environment/secrets/resource ownership, independently review it, then execute. Preserve old contracts and failed attempts as history. Avoid recursive inventory of the transfer's archived contract itself when designing the new contract; bind the actual executable source and explicit inputs, with an auditable exclusion list.

## New Mac setup and resource plan

Record actual model/chip, `uname -m`, physical RAM, free disk, macOS version, CPU count, Docker engine/context/server architecture and existing resources before changing anything. Inspect repository AGENTS instructions. Read current pins from package/lockfile, workflows and installer/doctor scripts before installing tools. Historical accepted versions: Node 22.23.3/npm 10.9.9, Go 1.27.1 with `GOTOOLCHAIN=local`, OpenTofu 1.12.5, OPA 1.19.1, PostgreSQL 16.15, Temporal CLI 1.9.1, Python 3.14.5 for the old frozen helpers, Docker 29.1.3, Compose 2.40.3, actionlint 1.7.12. Verify kind/kubectl compatibility and browser version. System Node 24 is not the supported Node 22 lane. Never blindly install newest tools or force dependency upgrades.

Start Docker around **12 GiB RAM / 4 GiB swap**, VirtioFS, Resource Saver off during runs. These are proposed new-host tuning values, not shipped requirements or applied settings. Preserve host headroom for API, worker, browser and compiler. Increase toward 16 GiB only if measured memory pressure and swap/disk headroom permit. Do not assign all 24 GB to Docker.

Retain continuous user-approved **12,000,000,000-byte free-disk floor**. Full packaged-worker gate independently requires **18 GiB (19,327,352,832 bytes)** free, plus pull/build/swap headroom. Do not lower that gate floor. Check before/after each heavy run and monitor during it. Starting with 40–60 GiB free is useful if available. Stop an item before crossing its applicable floor, capture observed requirements and continue independent lighter work. Remove only positively identified owned disposable resources; no global prune, Docker reset, unrelated deletion or stopping unrelated services. Do not migrate Docker.raw, caches, node_modules or .next; fresh installation is required.

Use bounded isolated source/review lanes and targeted tests in parallel. Start with one heavy Docker/database/full-suite workload at a time; increase heavy concurrency only with measured RAM/CPU/swap/disk capacity. Give workers exact owned paths, dependencies, commands and out-of-scope follow-ups. One worker must not approve its own high-risk changes. Root owns serial heavy verification, integration and release verdict. Stale old agents/processes are not a reason to stop unrelated current services.

On Apple Silicon, native host and matching Linux containers are ARM64. `--platform linux/amd64` emulation is **not native AMD64**. Use exact-source native AMD64 CI separately; report both architectures explicitly.

## Default local-stack acceptance after CI repair

DEC-STARTUP authorizes owned disposable local API/server startup, not only worker startup. Use documented installer and supported default composition. A reduced-resource local profile is allowed but must be labeled: host-native Next standalone API and worker, API heap about 768 MiB and worker about 1024 MiB unless measured OOM warrants a recorded change; Supabase db/auth/PostgREST/kong/supavisor only; reuse supported Supabase Postgres for product/platform stores; light supported Temporal mode. On 24 GB, try shipped composition where practical, but local profile success does not close PKG-04 Linux container acceptance.

Preserve TLS verification. If local pooler needs a terminator, generate an owned throwaway CA, trust it only in this test environment and delete it afterwards. Create two independent local Auth users through its admin API; credentials stay in a private file outside Git, never printed. Use non-requester approvals. Do not substitute injected ports or fake identity for default composition evidence.

Run in order, cleaning each owned attempt fully:

1. Installation, migrations, supported schema access, readiness/health.
2. UX-01 signed-in operator journey in real Chrome: plan, second-identity approval, progress, cancel, replan/reapprove, uncertain state; axe WCAG 2.1 AA at 1280 px and 375 px.
3. OBS-04 real default scheduling: seven critical jobs, health route, cron fallback deferral, restart catch-up and no overlap. Independently review any maintenance harness before use; old draft is NOT_READY.
4. MACH-03 registered signed runbook through the default stack where supported.
5. OBS-02 only actual current wiring. Earlier agent-ports/factory/machine-health builder gaps may have changed; inspect source and builder receipts, do not reopen or patch builder-owned architecture without coordination.
6. MACH-04 actual agent systemd installation/register/revoke/rotate/signed update/rollback with health deadline in an owned Linux PID1 fixture. Separate fixture protocol proof from default-stack delivery proof.
7. Remaining LIFE-01, LIFE-08, LIFE-10, LIFE-12, MACH-05 and COST-03 acceptance serially with `--no-file-parallelism --maxWorkers=1`, plus all other still-missing levels in the fixed verifier queue.

Retain LIFE-08 contextDigest and LIFE-09/10 single-provenance join controls. LIFE-09 must cover default open-egress refusal and explicit allow-open-egress override. LIFE-10 must cover tag-only image refusal, non-requester migration approval and rollback refusal after contract migration. UX-03 trusted publisher keys must be generated at runtime. No full fake provider key literals in tests. Local fixture proof cannot close private-source/cloud/DNS acceptance.

## Integration, final gates and publication

Minimal verifier fixes and missing tests only. Builder owns DUR-*, OBS-01, PKG-04/05, MACH-02/06, UX-02, LIFE-03..07, COST-01/02 and MIX/MAN/OPS/REL product implementation. Do not build wave-3 features or duplicate its systems. Gate/harness changes needed for mandatory in-scope verification remain minimal and independently reviewed. Never edit published migrations; compatible schema changes are additive and must follow current registry, not obsolete migration counts in older notes.

Use the current canonical gate manifest and runbooks, not the historical count labels alone. Combined candidate must prove clean npm installation, compiler/lint/format, generated SQL/policy/capability/ledger artifacts, dependency security, real PostgreSQL and Supabase migrations, Temporal/history replay, OPA, real OpenTofu, Go race/interoperability, kind provider/release/guest, packaged workers, authorized browser/API/MCP and recovery gates. Keep native100 exactly 100. Preserve required identities, unexpected-skip, zero-test and strict exit detection. Do not treat excluded fixtures or overlapping totals as universal zero-skips.

Kind may use only owned disposable clusters and exact owned kubeconfig. Delete every created cluster. Record local-cluster evidence, never live-cloud evidence. Customer workloads/production/cloud accounts remain untouched.

Before promoting a requirement, every required evidence level must pass on a coherent source with inspected outcomes. Otherwise keep it in progress and list the missing level. Append sanitized exact-SHA/tool/architecture/command/count evidence under `evidence/<ID>/`; update RESULTS, VERIFY-QUEUE Results, PROGRESS (recompute counts), and WAVE3-BUILD-AGENT-BLOCKERS for builder code needs. Run `node scripts/build/production-ledger.mjs --check`. No acceptance promotion for this handoff itself.

Push after coherent requirement groups, pulling/merging beforehand. Inspect **every job** of all exact-pushed-SHA workflows, including native worker/platform workflows; record pending, failed and cancelled literally. Preserve original failed attempts and cleanup evidence. No green claim based only on targeted checks, previous green commits or source review.

## Outstanding permissions and completion boundary

Continue all authorized local work. Ask once for unresolved scoped decisions, without requesting secrets in chat:

- Exact minimum MCP advisory dependency remediation, after refreshed primary-source review. Existing dependency approvals are scoped, not general permission.
- Configured live cloud accounts/regions, allowed resources, budget and cleanup; real DNS/private GitHub App and private-source acceptance. DEC-CLOUD remains unapproved: no calls or spend.
- Retention/archive/deletion policy, billing/legal/business decisions and accountable production sign-off.

An Astra/security reviewer may challenge technical fixes but cannot grant human-only spend, security exceptions or business authority. Secrets remain secure local configuration. Models propose; deterministic code owns identity, credentials, policy, approvals, state and execution across every interface.

Completion means the verifier's complete required evidence and exact-SHA CI are reconciled, not the full product being production approved. Keep the existing four release flags false unless their separate authorized criteria and sign-off are satisfied by the owning program. If external prerequisites remain, hand back exact requirement IDs, missing levels and safe next actions; do not manufacture green or start new features.

## Copyable receiving-agent prompt

[NEW-MAC-AGENT-PROMPT-2026-10-10.md](NEW-MAC-AGENT-PROMPT-2026-10-10.md) contains the standalone receiving-agent instruction. It points back here and does not replace the full scope/acceptance contract.
