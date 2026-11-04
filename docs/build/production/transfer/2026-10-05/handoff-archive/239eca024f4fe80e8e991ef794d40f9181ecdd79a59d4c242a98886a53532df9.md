# Durable original plan handoff

Requirements: PROD-DUR-05 and the artifact lifecycle portion of PROD-DUR-06.
Worker: existing gpt-6.1-sol HIGH thread, resumed without model changes.
Worktree: `/Users/saivedanthava/.codex/zenith-production/worktrees/durable-plan-handoff`.
Branch: `ws/prod-durable-plan-handoff`, based on `cb33a6176e74b218276eb1230ecaa898bccc8366`.

## Current state

Original54-path handoff remains preserved at the worktree above. Root matched source into isolated `ws/prod-durable-plan-verify` off exact greena14. Final56-path inventory `73326794f4135d5e00eb3cb185c0af603455a0cd3045780429906ebe729718b0` includes runtime fixture corrections and source-reviewed pendingm7 RLS/grant parity. Root compiler/lint passed; initial396P/39F/25S and latest435P/3F/26S failures retained. Remaining replacement-fence fixture, predispatch wording and provenance classification regressions under narrow correction. Mandatory actualPG+OpenTofu, packaged architectures, kind and combined full gates remain pending. Worker source-only; root owns checks, commits, integration and evidence. One heavy local process on8GB host.

The existing engine regenerates a semantic-digest-matching plan and applies that newly generated saved file. Retained approval-time bytes are not consumed. Digest-named local writes, final-plan cleanup and apply cleanup race with other writers and the janitor. Existing browser approval, policy, leases, ownership, destructive gates and the newly integrated ECS binding remain mandatory.

## Implementation contract

- Freeze and authenticate producer scope, source/revision/graph, configuration, backend, address map, lock, executable and original binary identity inside the trusted engine. Do not attest arbitrary caller bytes.
- Add migration 7 with immutable ciphertext content and separate lifecycle/use state. Preserve tenant and operation ownership, atomic publication with the reviewed plan binding, deterministic original-preserving retries and consistent fence, operation and artifact locking.
- Use a dedicated artifact keyring and artifact-domain authenticated data. Reuse the existing VaultCipher implementation; never silently share vault keys or duplicate encryption code. Previous keys are decrypt-only. Plaintext is worker callback data, never evidence, operation JSON, Temporal results, logs or URLs.
- Another worker retrieves the scoped original, authenticates its provenance and bytes, performs separate fresh semantic, ownership, policy, human approval and fence checks, then applies the original private exclusive file with state locking. Refuse stale originals and incompatible context without a fresh-file fallback.
- Record a durable use attempt and dispatch boundary. Lost responses or crashes after dispatch preserve uncertainty and block automatic replay. A fence cannot undo an accepted provider call.
- Preserve the original teardown review artifact through a separate immutable association with the later destroy proposal. The planning source operation already has a live execution claim; no unclaimed approval-wait exception is allowed. Bind the destination's exact immutable broker source reference, digests and scope without copying or reattesting binary bytes. Destination dispatch requires its own live claim plus successful source completion and authenticated association. An approval that wins the association window blocks execution; never cancel an already-approved proposal.
- Remove canonical shared digest-file overwrite/unlink paths. Maintenance is logical expiry only. No ciphertext purge, legacy-file deletion or new retention policy is authorized.
- Production composition requires PostgreSQL, the canonical schema, usable artifact keys and executable identity before polling. Explicit isolated test adapters are distinct from production and from cross-worker evidence. Missing old-plan provenance requires new review; local files cannot be retroactively attested.
- Cover deploy and IaC destroy, default worker/installation custody, safe migration/drain and recovery limitations. The matching executable hash is distinct from independent distribution attestation. Existing packaged archives have verified checksums; preserve that build boundary.

Primary references checked by the lead: [OpenTofu 1.12 plan](https://opentofu.org/docs/v1.12/cli/commands/plan/), [apply](https://opentofu.org/docs/v1.12/cli/commands/apply/) and [JSON format](https://opentofu.org/docs/v1.12/internals/json-format/).

## Owned files

```text
src/lib/controlplane/db/migrations/0007_plan_artifacts.ts
src/lib/controlplane/db/migrations/index.ts
src/lib/controlplane/db/migrations/emit.ts (header comment only)
src/lib/controlplane/db/repos/plan-artifacts.ts
src/lib/controlplane/db/repos/operations.ts (fence-before-operation claim ordering only)
src/lib/controlplane/db/repos/index.ts
src/lib/controlplane/types.ts
src/lib/controlplane/operations/index.ts (atomic undecided-round supersession guard only)
src/lib/capabilities/destroy-review.ts (immutable source-original association only)
src/lib/capabilities/ports.ts (BrokerStore undecided-round cancellation flag only)
src/lib/capabilities/memory-store.ts (matching isolated cancellation guard only)
supabase/migrations/0014_platform_core.sql (generated only)
src/lib/platform/plan-artifacts.ts
src/lib/platform/execution.ts
src/lib/platform/broker.ts (initial immutable destroy-plan approval round only)
src/lib/execution/ports.ts
src/lib/execution/runtime.ts
src/lib/execution/plan.ts
src/lib/execution/apply.ts
src/lib/execution/destroy.ts
src/lib/execution/plan-janitor.ts
src/lib/tofu/engine.ts
src/lib/tofu/runner.ts
src/lib/tofu/types.ts
src/lib/tofu/binary.ts
workers/execution/startup.ts
workers/execution/worker.ts
workers/execution/packaged-client.ts (real PostgreSQL logical-expiry and retained-ciphertext acceptance only)
scripts/ci/gate-manifest.mjs
.github/workflows/ci.yml (platform-postgres pinned OpenTofu and mandatory combined handoff lane only)
scripts/acceptance/packaged-worker.mjs
scripts/deploy/installation.mjs
docker/worker.Dockerfile
deploy/self-hosted/compose.yml
tests/controlplane/plan-artifacts.test.ts
tests/controlplane/operations.test.ts (real PostgreSQL claim/fence ordering regression)
tests/controlplane/migrations.test.ts
tests/tofu/plan-artifact-handoff.test.ts
tests/execution/plan.test.ts
tests/execution/apply.test.ts
tests/execution/destroy.test.ts
tests/execution/destroy-review.test.ts (original association and approval race regressions)
tests/execution/deletion-guards-real.test.ts (explicit isolated real-engine custody fixture only)
tests/execution/journey.test.ts (explicit isolated paired custody fixture only)
tests/execution/fakes/tofu.ts
tests/execution/fakes/world.ts
tests/workers/plan-janitor.test.ts
tests/workers/plan-artifact-startup.test.ts
tests/security/plan-artifact-secrecy.test.ts
tests/docs/operator-docs.test.ts
tests/acceptance/packaged-worker.test.ts
tests/workflows/worker.test.ts
tests/deploy/installation.test.ts
tests/platform/composition.test.ts (explicit isolated test admission only)
tests/platform/plan-approval.test.ts (initial destroy concrete-plan approval distinction only)
docs/adr/0005-opentofu-hybrid.md
docs/platform/operations/DEPLOYING.md
docs/platform/EXECUTION-WORKER.md
docs/platform/INSTALLATION.md
```

List anything outside these files as a follow-up; do not edit it. Root owns ledger, generated requirement status, resume notes, limitations and published evidence. No package changes are needed. Never write full provider-format fake keys; construct test values at runtime.

## Required remaining verification

Prepare real PostgreSQL tests using independent handles/processes, publication/use/expiry barriers, stale fences and crash windows. Test tenant/operation/provenance/cipher corruption and key failures. A real pinned OpenTofu journey must lose worker A's local directory and prove worker B applies A's original bytes after fresh checks. Include create, destroy, fresh drift refusal and stale-state refusal without fallback. Sensitive read-only plans must persist only ciphertext and produce secret-free surfaces. Test restoring into fresh PostgreSQL with matching keys and refusing missing/incompatible context.

Pin mandatory PostgreSQL and real OpenTofu scenarios in the canonical gate; missing, failed, skipped or zero tests must fail. Preserve prior requirement IDs and groups. Root will run full typecheck, affected lint, touched suites with `--maxWorkers=1`, real OpenTofu, Go, canonical real PostgreSQL and fresh kind where required before merge. Packaged startup and full release gates follow on the exact integrated source.

Live backend lock/encryption/versioning/restore proof, recovery epochs, key retirement/immutable re-encryption, physical retention/pruning and cross-platform portability remain follow-ups. No live cloud, API/server startup, production action or retention policy is implied.

## Latest actual PostgreSQL correction checkpoint

Recorded 2026-10-03. Original snapshots remain preserved. Frozen57-path candidate on ws/prod-durable-plan-verify offa14 has inventory `76e0d54820a0aa5915f62cecacf37e93574745cf4ceb8db8dac24653efd9ce6d`. Schema SQL remains `fbae1476d6e646018416c8de872c7f1ee5c9b09f32526d768fb854df61e88af8`. Root matched all bytes; independent review receipt SHA342a2c4cfa7d154a67452af39b3f7d8d973a68a966a2fe2c6b3a5aa66e66b949 records source-clear, no runtime claim.

Actual PostgreSQL run prod-durable-artifact-postgres-root failed1517P/11F/5S. Genuine postgres.js JSON proof parameter transport caused unconditional dispatch refusal missed by PGlite. All six proof references now use text::jsonb with unchanged policy/approval/count/round/ID/expiry predicates. Added real positive0/2-human proofs, verified SQL connections, actual six-export foreign-tenant sweep, disposable migration-owner database CREATE and matching dump/restore prerequisites. Five independent-PG-only scenarios retain exact mandatory case titles and register only with genuine PostgreSQL handles; no blanket skip waiver. Owned database/new image were removed.

New tenancy fixture first failed compiler because internal broker metadata was put in public OperationProposal. Correction uses existing typed BrokerProposal and persistence path, without casts or production widening. Corrected root gate prod-durable-real-pg-tenancy-corrected-root passed compiler/lint/Go and444P/0F/21S. Those diagnostic skips require real PostgreSQL and are not acceptance proof. Fresh mandatory prod-durable-real-pg-final-root passed1532P/0F/0S with70requiredgroups,all12bindings and separate execution revalidation. Post-gate57source hashes unchanged. Owned container/new image removed;27.88GiB free. PostgreSQL16.15 clients installed separately without server/service/initdb; existing18.1 clients preserved. Package, kind and source commit checks completed below; source integration remains blocked by full regression.

Source committed as Saivedant at15e4453cdcf8dfd5ac83aa71b6d3c20e6ecf7b5a; all frozen hashes preserved. Fresh kindprovider6P0F0S/release1P0F0S passed with cluster/kubeconfig/newimages deleted. Actual packaged AMD64 under emulation passed335.76s; native ARM64 passed300.27s. Each removed14ownedresources/privatefiles plus own builder/cache/newdependencies; Docker0B. Both prove local PostgreSQL/devTemporal entrypoint readiness/outage recovery and idle shutdown, not cloud mutations or in-flight shutdown. Clean-source prod-durable-full-root failed:16,588passed,70failed,212skipped,946.98s. Compiler/lint/generated/OPA213/Go race passed; canonical workflow/policy/OpenTofu phases not executed after failure. Two disjoint regression workers active; mandatory dependency audit remains red. Current source is not integrated. Public combined receipt: evidence/durable-plan/root-verification.json.

Latest continuation contracts and pending commands: [REGRESSION-CHECKPOINT.md](REGRESSION-CHECKPOINT.md). Frozen15e4453 evidence remains bound to original57paths, not later corrections.
