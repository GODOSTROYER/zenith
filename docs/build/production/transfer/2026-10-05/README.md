# Zenith machine-transfer checkpoint, 5 October 2026

Continue all 78 production requirements. This is an explicit as-is checkpoint requested by the user, not a green integration or production release. Preserve architecture, completed wave 8, newer commits and user files. Do not reset, rewrite history, replay historical paused patches or treat review fingerprints as commits.

## Source and status

- Publication branch: `codex/production-2026-10-02`. The final handoff commit is its fetched HEAD.
- Exact current product checkpoint: `19be80b3ea905ee51da89f27e3258184611952f0`, tree `7da4306a4b3aab859b55978030702881eb6fdc08`, 3,854 source paths. Its parent is `f699656`, which preserves all 71 previously unpublished commits after `414d52b`.
- Historical remote green: `414d52b`, run `37128274569`, 14 passed. That result does not cover this checkpoint. Inspect the new exact-commit CI run; pending and failed remain separate from passed.
- Ledger: 6 verified, 32 in progress, 40 planned. COST-01/02 now reflect integrated partial code. No new requirement is verified. All four release states remain false.
- Primary user `.DS_Store` and `docs/product-discovery/` files stay local and untouched. Credentials, local databases, raw plan/state, environment inventories, Docker data, dependency trees and binaries are not in the handoff.

## Checklist and next actions

- [x] Preserve and publish existing 71-commit ancestry and exact 93-path root candidate, with Saivedant author and committer.
- [x] Include cleanup barriers/settlement, guest package/helper, canonical package gate source and their existing handoffs in the product checkpoint.
- [x] Preserve pending digest3 and partial schema/gates11 as separate replayable patches, before/after source, freezes, case contracts and inventories in `pending/`. Static source copies use `.snapshot` suffixes and a path map in `PACKETS.json` so archives cannot enter compiler/test discovery.
- [x] Preserve all available local handoff document versions in `handoff-archive/`, indexed by original path and SHA256. Historical versions are provenance; this README controls current continuation. Two historical prose versions contain credential-URL redactions with separately bound original and stored digests; see `SANITIZATION.md`.
- [x] Include exact source reviews, failure interpretation and sanitized evidence summaries. Raw logs are not transferable evidence merely because their hashes are listed.
- [ ] Apply independently accepted manifest-digest3 in an owned worktree and run actual native100. The correction changes only two canonical manifest digest uses, preserving cipher and approval domains. Last attempt remains 60 passed / 40 failed / 0 skipped; all original46 passed, new54 had14 passed/40 failed. Do not infer that all40 are fixed.
- [ ] Finish independent review and actual execution of partial schema/gates11. Preserve immutable migration history, schema49 tenant ownership, private-origin API guards and closed SQL AST allowlists. Retain old1059 plus exactly54 new platform requirements, PG80, guest127, worker22 and workflow58. Derive discovery, do not substitute stale hard-coded counts.
- [ ] Rebind any gate source hashes after accepted digest3. Its final native test SHA is `87813c36bd0face890cc8e47e8aede5fc3d6fae058c13cd07f5812b449339f71`. Package native SHA is `b7b2d7cbb6d21baef5b39ce8f2eab14f80fff245cc03e633cfb53f5bf3ce6331`.
- [ ] Run clean installation and the complete compiler/lint/generated SQL/policy/capability/ledger/security, actual PG/Supabase/Temporal, OPA, real OpenTofu, Go race/interoperability, kind provider/release/guest, canonical Linux127 and packaged worker22 gates on one coherent candidate. Prior full platform run remains 2,755 passed / 27 failed / 8 skipped until a complete successor.
- [ ] Inspect every main and native-architecture CI job on the exact pushed commit. Native AMD64 remains distinct from emulation. Do not call pending CI passed.
- [ ] Continue G2 operated default application, G3 failure/upgrade/recovery and G4 provider/mixed-cloud/managed-hosting/client/economics requirements. Typed convergent service configuration is a concrete remaining MACH gap; reuse existing durable scheduling and authority paths.

## Other-machine commands

```sh
git clone --branch codex/production-2026-10-02 https://github.com/GODOSTROYER/zenith.git
cd zenith
git log -1 --format='%H%n%an <%ae>%n%cn <%ce>%n%s'
python3 docs/build/production/transfer/2026-10-05/verify.py
```

Read `docs/build/production/{RESUME.md,PROGRESS.md,REQUIREMENTS.md,ledger.json}`, `docs/LIMITATIONS.md`, this directory's `PACKETS.json`, `EVIDENCE-SUMMARY.json` and relevant original reviews. Hash verification establishes transfer integrity only, not test acceptance.

Create owned implementation worktrees from the exact product checkpoint before replay. Keep the published handoff branch intact:

```sh
git worktree add -b codex/continue-digest-2026-10-05 ../zenith-digest 19be80b3ea905ee51da89f27e3258184611952f0
cd ../zenith-digest
git apply --check ../zenith/docs/build/production/transfer/2026-10-05/pending/manifest-digest-r3/manifest-digest-correction.patch
git apply ../zenith/docs/build/production/transfer/2026-10-05/pending/manifest-digest-r3/manifest-digest-correction.patch
```

Verify all recorded preimages and source-only review before import; digest3's expected product tree is `a6ae2b5b77edb7d4221b628e12198d342fecda39`. The eleven-path packet has prepared tree7da and candidate `a6788b60ede249b8d97e03a7c2696bd2d4b51664`; review it in a separate worktree with `git apply --check` before applying. These packets have disjoint owned paths, but final composition and hash rebinds require review. Absolute paths inside immutable historical receipts refer to the original machine; use artifact filenames and recorded hashes, without editing originals.

Prerequisites: supported Node22.16-22.x (prior22.23.3), locked npm dependencies, OpenTofu1.12.5, OPA1.19.1, Go1.27.1 with `GOTOOLCHAIN=local`, Docker, kind and compatible kubectl. Run `npm ci` in the implementation worktree. Provision only disposable owned databases/clusters; agent3 roles/schema precede platform16, followed by Supabase18 fresh/upgrade/reapply and canonical name/checksum/role/tenant verification.

For scoped native100, use an actual owned PostgreSQL16.15 URL through secure local environment configuration, not chat. Set `ZENITH_TEST_PLATFORM_PG_URL`, `ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED=1`, `ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED=1`, `ZENITH_TEST_TOFU_NETWORK=1`, and pinned tools on PATH. Then run:

```sh
npm run typecheck
npx eslint src/lib/tofu/engine.ts tests/controlplane/cleanup-writer-barriers.test.ts
npx vitest run tests/controlplane/cleanup-writer-barriers.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=native-settlement-current.json
```

Require exactly100 current identities with no failures/skips/missing cases and genuine saved-byte apply/readback/cleanup. Each attempt needs fresh owned operations and sanitized source/environment/version-bound receipts. Preserve uncertainty and non-replay protection; never retry an old accepted write blindly.

Canonical full lane commands and required environments are in `.github/workflows/ci.yml`, `.github/workflows/packaged-workers.yml`, `scripts/ci/gate-manifest.mjs` and `scripts/ci/run-gate.mjs`. Run serially, retain strict exit and zero-test/skip checks, and inspect each result. `historical-helpers/` contains exact old scripts for reference; DO NOT RUN UNCHANGED because paths, source trees, receipt pins and resources belong to the old machine. Rebind explicitly and review first.

## Evidence and resources

The f699 whole unit lane passed18,682/failed0/skipped1,167, but its overall strict workflow attempt failed. Later native workflows1,192/0/0 and PG322/0/0 passed; full platform2,755/27/8 failed. Targeted predecessor304/0/0 does not supersede the full failure. Package R14 genuinely passed four required native scenarios and five signed negative children, plus31 Linux model leaves on native ARM64. Parent/child and repeated-lane counts overlap; never sum them. This does not prove installed systemd CHOWN-only helper/zero-cap daemon, default composition, full canonical127, nativeAMD64, changed worker shutdown or cloud acceptance. Historical kind provider6/release1/guest48 passed on f699 with scoped fixture authority, not managed CNI/stateful/live clouds.

Original failed R11/R12/R13 package attempts and the native100 failed attempt are preserved on the original disk. Included projections and original hashes preserve chronology; uncopied raw logs must be requested through a secure transfer or regenerated on the new machine. No credentials or protected raw artifacts belong in the public repository.

Original host: Saivedant's 8GiB Mac. One heavy Docker/database/full-suite workload at a time; up to three independent source/review workers. Measure current host capacity rather than inherit limits blindly. Owned disposable containers/images/volumes were removed; unrelated616.3MB image,74.2MB volume and477.1MB cache remain. Approximately13GiB free at handoff; packaged worker gate's18GiB floor remains unmet locally and must not be waived. Never global-prune or touch unrelated LocalStack/services.

Permissions already approved: owned disposable PostgreSQL/Temporal/kind/Linux/execution-worker tests and images, Docker restart, normal same-branch push. Default API/server startup, live private-source/Supabase/cloud account/region/budget configuration, destructive retention, commercial decisions and production sign-off remain pending. Worker permission is not API permission. Consolidate requests once; secrets stay out of chat. Models propose; deterministic code owns credentials, policy, state, approvals and execution. Human browser approvals bind exact immutable effects. No privileged fallback, fake verification, secret-scanning bypass, force push or history rewrite.

Commit author AND committer: `Saivedant Hava <saivedant169@gmail.com>`, on the user's machine. Inspect both fields, no Co-Authored-By trailer or em dash in messages. Preserve user-approved identity and current working files. Workers are checkpointed; no unattended continuation is promised.
