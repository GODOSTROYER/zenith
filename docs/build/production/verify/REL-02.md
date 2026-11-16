# PROD-REL-02: requirement-to-evidence dossier

J12 extends `scripts/release/dossier.ts` and the existing release-governance scenario, sharing validation with REL-03 in `scripts/release/status.mjs`. No migrations, SQL snapshots, dependencies, cloud calls or approval records are created by this job.

## Acceptance mapping

| Acceptance clause | Implementation and test |
| --- | --- |
| Every requirement maps implementation, tests, environment, commit and evidence | Existing dossier row and document discovery; file/hash/source validation in `status.mjs`; `tests/release/dossier.test.ts` and filesystem cases in `tests/release/status.test.ts` |
| Deployment, upgrade and recovery instructions | Existing operating-document inventory, real file existence and missing-document labels; `tests/release/dossier.test.ts`; gated real-candidate check in `tests/release/candidate.live.test.ts` |
| Skipped/unperformed items remain visible | Pending, unperformed, failed, skipped and invalid level states; historical claims remain listed with validation errors; `tests/release/dossier.test.ts`, `tests/release/status.test.ts` |
| Real evidence, no placeholders presented as evidence | Referenced repository files must exist, hash-match and parse; original source must have passing nonzero counts, zero failures/skips, exit 0 and the same candidate/mode. Unsigned drafts and prose summaries cannot satisfy evidence gates. `tests/release/status.test.ts` |

A `verified` dossier row now requires passing file-bound evidence for every level on one coherent commit as well as the ledger's `verified` state. It does not rewrite historical ledger states. Older evidence without the new bindings remains visible but cannot approve an RC. This intentionally tightens the old dossier behavior which treated any ledger entry, including cross-commit and skipped entries, as sufficient.

## Local and Mac commands

Node 22, repository root. No service is needed for the tooling contracts. Mac lean profile: one command at a time, `--maxWorkers=1`, no Docker allocation for these commands.

```sh
npx vitest run tests/release --no-file-parallelism --maxWorkers=1
node scripts/build/production-ledger.mjs --check
npx tsx scripts/release/acceptance-orchestrator.ts check
npx tsx scripts/release/dossier.ts --out /tmp/zenith-dossier.md --json /tmp/zenith-dossier.json
```

Expected: contract tests pass; three real-candidate/sign-off acceptance cases explicitly skip unless their gates are set. Ledger check exits 0 with all four release flags still false. The dossier includes all requirements and missing/skipped/unperformed/historical results. Generating the dossier is tooling proof, not live or operational proof.

After the integrated RC is frozen, run the actual applicable engine/live/rehearsal commands from each requirement's verify document. Start only that requirement's services, sequentially within Docker's 4 GiB; a blocked startup is recorded as not run. J12 adds no service topology. Candidate acceptance reads those recorded results; it does not start services or call providers:

```sh
ZENITH_VERIFY_RELEASE_CANDIDATE=1 npx vitest run tests/release/candidate.live.test.ts --no-file-parallelism --maxWorkers=1
```

Expected after all RC execution evidence is recorded: 2 candidate cases pass, 1 production sign-off case skips. Missing source files, changed hashes, older commits, skipped/failed runs, missing test/docs mappings or missing operating instructions fail. Do not set the gate just to turn missing prerequisites into a pass.

## Evidence recording join

`scripts/release/evidence-cli.mjs` binds a real sanitized verifier count report into a `zenith.release-evidence.v1` receipt. Its original JSON needs full `commit` (or `sourceCommit`/`provenance.commit`), actual covered requirement IDs in `requirements`, `command`, `environment`, `mode`, observed `exitCode` (or `rootExecutionExitCode`/`execution.exitCode`), and `counts: {passed, failed, skipped}`. Optional `status`/`verdict` is preserved conservatively. Mode is the recorder's actual run class: `contract`, `local`, `live`, or `remote_ci`; the CLI refuses to upgrade it or map unrelated requirements. The verifier recorder must emit this metadata with the actual run; do not retrofit claims into historical reports.

With a real report stored at `docs/build/production/evidence/PROD-REL-02/rc-source.json`:

```sh
node scripts/release/evidence-cli.mjs --source docs/build/production/evidence/PROD-REL-02/rc-source.json --requirement PROD-REL-02 --level contract --mode contract --out docs/build/production/evidence/PROD-REL-02/rc-contract.json
```

Expected: exit 0 and the actual status/hash printed. Failed/skipped results can be recorded and stay failed/skipped; they cannot satisfy verification. Add the emitted path/hash/full commit as ledger evidence (`artifact`, `sha256`, `commit`, `level`) through the single verifier recorder. The CLI never edits the ledger. Repeat for the real applicable level and mode; no fixture/example report is supplied as real evidence.

## Remaining work and integration

- Freeze `ledger.releaseCandidate.commit` at the integrated RC; historical `baseline.commit` is not the RC.
- The verifier recorder needs to emit the source metadata above and attach bound receipts. Missing or legacy evidence is refused rather than inferred. One source can be referenced by multiple requirement receipts when its actual coverage warrants it.
- Preserve the existing harness-rel/OPS-09 scenario runner and signing workflows. Additive release-governance wiring includes REL-03 and its contract tests; no independent runner was added.
- No schema/table/store/inventory/migration changes. Do not change migration numbering or aggregates for this job.
- Full integrated local-engine, live-sandbox and operational results are not run here; they require the Mac's operated installation and, for cloud-specific claims, owner-authorized accounts. Ledger state is never marked verified by this job.
- Suggested ledger status: `implementation_complete_verification_pending`.
