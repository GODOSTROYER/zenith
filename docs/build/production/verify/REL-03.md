# PROD-REL-03: separate release status and accountable sign-off

J12 builds `scripts/release/status.mjs` (+ TypeScript declarations), `signoff-cli.mjs` and `evidence-cli.mjs`; integrates the validator into `scripts/build/production-ledger.mjs` and the existing dossier and release-governance scenario. OPS-09's Ed25519 seed/public-key format is reused with a distinct sign-off signing domain. Production signing decisions and keys remain owner-only.

## Acceptance mapping and policy

| Clause | Enforcement | Tests |
| --- | --- | --- |
| Implementation complete remains separate | Completion checks implementation statuses; it never fabricates evidence flags | `tests/release/status.test.ts` |
| Sandbox verified | Requires implementation flag, a full `releaseCandidate.commit`, and every requirement's required execution level except operational rehearsal/production sign-off | `tests/release/status.test.ts` |
| Pilot ready | Requires sandbox flag and additionally all required operational rehearsal evidence | `tests/release/status.test.ts` |
| Production approved | Requires pilot flag, all applicable required levels and an accountable signature over the exact entire requirement scope, candidate, ledger snapshot and selected evidence references/hashes | `tests/release/status.test.ts`; gated `tests/release/candidate.live.test.ts` |
| Refuse missing/invalid sign-off or live evidence in the ledger tool | Validation runs before `--check` or rendering; keys are external verifier input, never ledger/record self-declared keys | Actual ledger CLI negative test in `tests/release/status.test.ts` |

All required evidence levels are retained. Skips, failures, zero-test receipts, nonzero exits, missing/unreadable/unsafe files, unbound hashes, wrong source mode and incoherent commits fail. `contract`/local results cannot be relabelled live. Ordinary control-plane operational rehearsals may be local (PLAN-100 T4); MIX-05/06/07 and MAN-02/03 cloud-specific rehearsals require live mode. MAN-01's split local/managed-cloud claims still require the recorder/reviewer to map actual coverage correctly.

Implementation flag recognition is conservative: `complete`, `implementation_complete*`, `verified*`, or `local_verified*`. The assembler must normalize any completed legacy implementation statuses rather than weakening this guard. The dossier reports copied flags plus validation errors; it does not approve or alter them.

The dossier CLI also exits 1 for invalid release status. After owner approval, supply its `--signoff-keys "$ZENITH_RELEASE_SIGNOFF_KEYS_FILE"` option when generating the dossier to validate the approved status under the same independent trust input.

## Record and trust contract

`SignoffSchema` is strict `zenith.release-signoff.v1`: `who`, ISO `when`, full `commit`, `scope: {status: "productionApproved", requirements: [...]}`, `ledgerSha256`, evidence `{requirementId, level, path, sha256}[]`, and `signature: {algorithm: "Ed25519", kid, value}`. Signature bytes use canonical sorted-key JSON with a distinct domain prefix. Scope must equal the complete ledger inventory without duplicates; evidence must equal the passing selection. Ledger digest excludes only status flags and sign-off file references so setting approved flags/attaching the record does not invalidate it; contract, source inventory, decisions or evidence edits do invalidate it.

Pinned keys are an external JSON array of `{kid, publicKey, identity}`. Identity must exactly match `who`; key IDs are unique. Public keys are raw 32-byte Ed25519 base64url, matching OPS-09. Trust is supplied by the accountable owner outside the ledger; a signature alone does not prove human authority. Real key material is never created/read in tests, and ephemeral test keys are generated at runtime.

## Exact Mac verification commands

Node 22, repository root; no Docker/services for file/contract checks, one process and `--maxWorkers=1` on the 8 GB Mac:

```sh
npx vitest run tests/release/status.test.ts tests/release/dossier.test.ts tests/release/candidate.live.test.ts --no-file-parallelism --maxWorkers=1
node scripts/build/production-ledger.mjs --check
```

Expected with the current all-false ledger: contract cases pass, three gated real acceptance cases skip with reasons, ledger check exits 0. These results do not establish any production approval.

After RC engine/cloud/rehearsal evidence is actually collected, follow REL-02's recording commands. The owner reviews the dossier and other human decisions before preparing a draft. This command refuses incomplete evidence and does not sign:

```sh
node scripts/release/signoff-cli.mjs prepare --who 'Arnav Bule <arnav.bule05@gmail.com>' --out /tmp/zenith-signoff-review.json
```

Expected: exit 0 only with complete passing RC evidence; an unsigned review draft is created. The owner alone then signs in a real interactive terminal using the protected seed file, reviews the exact body and types its displayed digest:

```sh
node scripts/release/signoff-cli.mjs sign --draft /tmp/zenith-signoff-review.json --seed-file "$ZENITH_RELEASE_SIGNOFF_SEED_FILE" --kid "$ZENITH_RELEASE_SIGNOFF_KID" --out docs/build/production/evidence/PROD-REL-03/production-signoff.json
```

Seed file: exactly one base64url 32-byte Ed25519 seed, protected by the owner; no secret value in the command, ledger or record. Noninteractive calls refuse. Existing output files are never overwritten. This job does not execute signing or create an owner seed.

Attach the signed repository-relative file to `ledger.releaseSignoffs`; set all four flags only when their respective gates are met, then verify with the owner's independent public identity/key registry:

```sh
node scripts/build/production-ledger.mjs --signoff-keys "$ZENITH_RELEASE_SIGNOFF_KEYS_FILE"
node scripts/build/production-ledger.mjs --check --signoff-keys "$ZENITH_RELEASE_SIGNOFF_KEYS_FILE"
ZENITH_VERIFY_RELEASE_CANDIDATE=1 ZENITH_VERIFY_PRODUCTION_SIGNOFF=1 npx vitest run tests/release/candidate.live.test.ts --no-file-parallelism --maxWorkers=1
```

Expected only after accountable approval and actual evidence: ledger render/check exits 0; 3 real acceptance cases pass, zero skips. Missing external key file/real sign-off or any required live/rehearsal evidence fails. No API call or paid resource is made by these commands; provider evidence must already exist from the separately authorized harnesses.

## Remaining and joins

Candidate verification, original recorder metadata, live evidence, DEC-CLOUD/DEC-BUSINESS and production sign-off are pending; no release flag was enabled. Owner trust/identity registry must be independently reviewed and supplied by the verifier, and MFA/browser approval integration belongs to J3 (this job adds no product route or privilege fallback). Sign-off is an offline owner terminal action. No schema, migration, SQL aggregate, new dependency or real cloud access. Gate manifest inventory can pick up `tests/release/status.test.ts` and the explicitly external file-acceptance `tests/release/candidate.live.test.ts`; the release-governance scenario already names the new contract test.

Suggested ledger status: `implementation_complete_verification_pending`.
