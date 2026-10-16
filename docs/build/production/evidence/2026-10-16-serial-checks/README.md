# Bounded serial verification — 2026-10-16

Candidate: e70820e2576dcef0eb3a462d1c9ec25917cf82a8. Product source and test assertions unchanged. Evidence/doc additions only. No ledger promotion, production status changes, pushes, new CI, paid resources, account use or owner signoff.

The owner authorized proceeding to the next selected item after exhausting feasible checks while preserving unresolved verification gaps. A partial green result is not full requirement acceptance.

## PKG-01

See ../PROD-PKG-01/2026-10-16-review/README.md. Fresh contract checks 556 passed, zero failed/skipped; existing exact-source remote native AMD64/ARM64 receipts validated. Required local-native evidence absent. The VM is x86-64, approximately 9.7GiB total RAM, no Docker executable/socket observed; canonical native harness requires 12GiB host/Docker RAM. Requirement remains in progress.

## PKG-03

Additional targeted local tests: 53 passed, zero failed, one skipped; 164.57 seconds. Files: tests/workers/plan-janitor.test.ts, tests/workers/plan-artifact-startup.test.ts, tests/platform/plan-custody-crypto.test.ts, tests/security/plan-artifact-secrecy.test.ts. The last file's one PostgreSQL/OpenTofu gated test was skipped and does not count as verified.

These checks cover real temporary filesystem/PGlite retention behavior, symlink/ownership safety, custody startup contracts and encryption binding/rotation. PGlite and synthetic plan fixtures are not actual PostgreSQL or executable-plan evidence. Current code deliberately retains legacy physical plan bytes until separately authorized pruning and uses logical expiry; absence of physical deletion is intentional safety behavior, not a defect to remove.

Existing native CI receipts additionally check UID10001, private plan directory, packaged SSM/policy/dependencies, encrypted logical expiry/retained sentinels and owned-resource cleanup. Actual image runs use read-only root filesystem with constrained writable volumes. These remain remote CI. This requirement requires actual local engine/image acceptance, and no current local Docker run was performed. No product defect demonstrated by this pass. State remains in progress.

## Test environment

Node22.23.3, locked npm dependencies installed with lifecycle scripts disabled, Vitest single worker with file parallelism disabled. Only the injected UNDICI-EHPA experimental runtime warning is suppressed to preserve exact application-stderr assertions without changing proxy configuration or assertions. Raw JSON reports are retained. These reports are not yet canonical release-evidence envelopes and must not be silently relabeled as live/native execution.

## REL-03

45 passed, zero failed, three explicitly gated acceptance tests skipped; 1.74 seconds. Files: tests/release/status.test.ts (32) and dossier.test.ts (13) passed; candidate.live.test.ts (3) skipped for missing actual coherent all-requirement candidate evidence and real accountable production signoff/external identity keys.

Local checks exercise separate release flags, fail-closed evidence selection, wrong/missing signatures, stale/tampered source, incomplete scope, and dossier consistency. They use synthetic fixtures/ephemeral keys and cannot confer real approval. The current all-false ledger check passes. No signoff prepared or performed, no approval flags enabled. Full row remains pending its required actual candidate/live/operational evidence and owner approval.

## REL-04

144 passed, zero failed/skipped across five selected files; 2.56 seconds. Scope permission contracts (32), checkpoint/resume contracts (10), source coverage of live scope gates (54), managed live-runner contracts (37), and managed transport contracts (11).

These tests exercise unapproved/expired/wrong-digest scopes, bounded budgets/resource naming, prohibited actions, incomplete/failed checkpoints and resumable state, CLI transport contracts and cleanup recording using test fixtures. They do not execute an approved cloud or operated product rehearsal. Shipped permissions stay unapproved. The full row still requires local-engine/live/operational evidence; no source tag scan is represented as global resource inventory proof.

## MAN-07

Billing suite and billing schedule: 123 passed, zero failed/skipped, 48.64 seconds. Pricing-entitlement/autonomy and managed catalog join checks: 46 passed, zero failed/skipped, 12.60 seconds. These are disjoint files, totaling169 selected passes. Billing engine coverage used PGlite and fake invoice-provider transport, not PostgreSQL or real Stripe. PostgreSQL lanes are added conditionally when configured, so zero reported skips does NOT imply PostgreSQL execution.

Checks cover billing plan assignment, usage/invoice/idempotency logic, simulated signed webhook reconciliation, nonpayment suspension, continued exports/destruction rights, schedule registration and plan entitlement changes. Source inspection confirms live Stripe keys refused and suspension restricts new provisioning without silently deleting data. Existing policies remain enforced after downgrade.

The runbook still requires real PostgreSQL/Stripe TEST-mode/operator acceptance. Payment account, terms/tax and destructive retention decisions are pending in this candidate's documentation; historical pricing decisions are not permission to create accounts, accept terms, configure credentials, charge or delete data. No Stripe account was accessed, and no live call was made. Required PKG-05/LIFE-07 dependency acceptance and live/operational evidence remain pending. MAN-07 stays planned/incomplete in the ledger.

## Overall checkpoint

Across the selected fresh local suites: 967 passed, zero failed, four explicit skips. Do not add the prior CI contract counts to this total; they overlap. These numbers do not count 22 native CI controls as unit tests, and do not include unconfigured conditional PostgreSQL lanes.

All five selected requirements have feasible local checks and evidence review completed for this bounded pass, but **zero new fully verified requirements**. No known code defect emerged from these selected checks. The original low-confidence hour budgets were not measured test runtimes; measured selected test durations total about4m17s, excluding installation, inspection, evidence validation and waits. Full acceptance remains governed by the missing native/runtime/service evidence and human decisions above.

No gates were weakened, no evidence was relabeled, no release status was promoted. GitHub publishing/new CI remains deferred to the owner's later authorization/access. The local evidence additions are uncommitted.

## Publication authorization — 2026-10-16

After this local checkpoint, Arnav authorized publishing these five requirements in one PR to GODOSTROYER/zenith through the connected saivedant169 account, scoped to Zenith only. Earlier statements about deferred publishing describe the checkpoint time. This publication does not promote acceptance or provide production signoff.

Signed: Arnav’s OpenAI dot
