# Paused ECS replica repair checkpoint

Paused on 2026-10-02 at the user's explicit request. No ECS implementation, verification, parameterization, installation, service or cloud activity may resume until the user resumes this work and root assigns the required resource slot. This checkpoint is documentation only. No candidate file changed and no commit was created.

Worktree: `/Users/saivedanthava/.codex/zenith-production/worktrees/ecs-replica-repair`. Branch: `ws/prod-ecs-replica-repair`. HEAD: `cb4f9decab10faa2cddf3f1113d36c40b904e7a3`. The 24-file dirty candidate is frozen and uncommitted. Freeze receipt: `/Users/saivedanthava/.codex/zenith-production/logs/ecs-replica-repair-source-freeze.json`, SHA256 `aa62f8151b55caef823f98553a2452e6441c130f7e060493fd032ca2d192b671`. Every candidate file hash was checked against that receipt while writing this checkpoint. All 24 matched. The neutral recipe module is SHA256 `ba0e2b5c3dadc866f0b77f54dee781b6f5d32dbd6e97d701a917e1121e106afe`; its resource barrel is `4b1b3c47f4f9040720ef1f97dbe510a5087fab5875e44db6a93d3c5b5adf4071`. The resource purity self import correction changed only the type import to `./types`. Boundary checkers and predicates were preserved.

## Frozen owned files

- `docs/platform/operations/ECS-REPLICA-REPAIR.md` SHA256 `431fec3d1e63123adab7a616a597c9b438f7e85de80e0b6e5ecf2b61b186868b`
- `package-lock.json` SHA256 `b6c8d26a1c57a70d031ad8b72d1a391d554e53121a8b58e590763902c674816d`
- `package.json` SHA256 `d6526ae80835df230c035c707460595259b071a3573d175def2a578637e0771d`
- `src/lib/capabilities/evaluate.ts` SHA256 `722da0ce5d2912163edf0f554f2044bc92ab7fcd6babbcac95874e35edeb4177`
- `src/lib/capabilities/execution.ts` SHA256 `526743c6af98e8e91e2c010dd4e5ca8b67e32b2c44dc4aa5decca0a378ac7745`
- `src/lib/execution/apply.ts` SHA256 `57bbbb299ebfe7bcbb1255f930fa01c3f8fb1e9a9437df7230f1ecddd534ce0e`
- `src/lib/execution/context.ts` SHA256 `f604d62a52d872a3d25069851d95dbacda96142fa286027eb4d8e664f9168045`
- `src/lib/execution/ecs-replica-repair-binding.ts` SHA256 `3ecac9d4ac8cc09c6d142a77eeb31fe746adb861aa04a52186ecc22a1ae7d4cd`
- `src/lib/execution/ecs-replica-repair.ts` SHA256 `cde3d03fe4b60e85ceb4373576467d824f69b57a04a1b9530774371eb9e8aadb`
- `src/lib/execution/plan-evidence.ts` SHA256 `f73e63ee15a381327bf0e585d9da0dbc2f4111937d154b0789b8bd07113e42d0`
- `src/lib/execution/plan.ts` SHA256 `29e5265fab1661399b0dd573ce76c3635b8974dc56ac783e2c7c0a3d1c3451b9`
- `src/lib/platform/broker.ts` SHA256 `d08857293e0b0f818c13c29171bd5f5a73ad299776a524035e670098e485aa21`
- `src/lib/providers/aws/drivers/compute/ecs-replica-repair-read.ts` SHA256 `4cacd25f5413342aae71cfc8e31470aaf59e9ef14ce0408a0eda763847088768`
- `src/lib/resources/index.ts` SHA256 `4b1b3c47f4f9040720ef1f97dbe510a5087fab5875e44db6a93d3c5b5adf4071`
- `src/lib/resources/repair-recipes.ts` SHA256 `ba0e2b5c3dadc866f0b77f54dee781b6f5d32dbd6e97d701a917e1121e106afe`
- `src/lib/workflows/definitions/dayTwo.ts` SHA256 `bbc9b74b512b15c1cf4efb28f8c216cab026bae5369eeec4907482daba9a60f5`
- `src/lib/workflows/definitions/ecsReplicaRepair.ts` SHA256 `4873ddf650d7932068243734b3c1e93c8d5169629c1a6e35867d7bb2ac1dff4a`
- `src/lib/workflows/definitions/runtime.ts` SHA256 `b5ab7e8164cc960727a799713275df68a8c0b8b7c93e1967804c3357ce80af9a`
- `tests/execution/ecs-replica-repair.test.ts` SHA256 `2a24eb9517aad2694c143aaa485b5b5f16865be9d88ad34007d33e23f882a0dc`
- `tests/platform/ecs-replica-repair-grants.test.ts` SHA256 `45f49b4475d65486d21458e7d8586ee6754ba3dfe2c1549b7afbf02fd9a2c783`
- `tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts` SHA256 `bae99878747f4aff10d6af83fffa7a23f5bc4f265fc0712e470da5367fbc7eb4`
- `tests/workflows/ecs-replica-repair.test.ts` SHA256 `901afd58c12294ed00fa7e4620e17d0d8a4f4704df4faf6de26f32e8ceacc5ee`
- `tests/workflows/fixtures/ecs-replica-cancellation.ts` SHA256 `060da87e045d2dbefe9010c6e7affbd7d41e18e6f10515060ccba59685ea75a2`
- `tests/workflows/fixtures/legacy-day-two.ts` SHA256 `67b16d0f51a0389f61767c2dc05fcd915c72b3c8d3df493ab99f77a908d2d9e0`

## Completed dependency proof

Node `22.23.3`, npm `10.9.9`, Darwin ARM64. Metadata lock update exited 0 in 1.81 seconds; fresh private `npm ci --ignore-scripts --no-audit --no-fund` exited 0 in 8.99 seconds; the existing mandatory complete locked security audit exited 0 in 1.32 seconds. There were zero known findings and no exceptions. The sanitized environment allowed only the Node/system paths, existing HOME, language, bounded Node heap and two empty private npm configurations. Cloud, Supabase and Zenith environment credentials were excluded. No install scripts ran.

The only lock changes add the exact `@aws-sdk/client-application-auto-scaling` version `3.1121.0` and its root declaration. Existing package versions and transitive nodes did not change. The client matches installed ECS and Resource Groups Tagging API siblings at `3.1121.0`. There are 927 locked package nodes and 783 installed package nodes on Darwin ARM64. Worktree `node_modules` was absent before installation and is now a fresh private directory, not a symlink. The shared root installation was not mutated. Lock SHA256: `b6c8d26a1c57a70d031ad8b72d1a391d554e53121a8b58e590763902c674816d`. This does not prove Linux installation or runtime behavior.

Private command logs and result receipts have mode 0600:

- `/Users/saivedanthava/.codex/zenith-production/logs/prod-ecs-sdk-lock-metadata.log` and `prod-ecs-sdk-lock-metadata-results.json`
- `/Users/saivedanthava/.codex/zenith-production/logs/prod-ecs-sdk-lock-diff.json` and `prod-ecs-before-sdk-package-lock.json`
- `/Users/saivedanthava/.codex/zenith-production/logs/prod-ecs-sdk-npm-ci.log` and `prod-ecs-sdk-npm-ci-results.json`
- `/Users/saivedanthava/.codex/zenith-production/logs/prod-ecs-sdk-security-audit.log` and `prod-ecs-sdk-security-audit-results.json`

The audit log SHA256 is `dad5ff63a0e8e4c84e5dfbcbe56268054b7de50ef68fe181629a3f07b3e93a42`. The freeze receipt embeds raw command log hashes and results. Prior freeze receipts were preserved separately before each approved source correction. No raw credentials or arbitrary private error output were published.

## Prepared tests, none executed

There are 100 prepared cases: 57 execution cases, 26 AWS SDK response/command contract cases, 6 grant cases and 11 real isolated Temporal scenarios using scripted activities. NONE of these new candidate cases has run. Compiler, lint, full compatibility, OpenTofu, Temporal, PostgreSQL and live AWS checks have not run against this ECS candidate.

The six grant cases are exactly five PGlite cases and one MemoryBrokerStore initial-planning-denial case. There are ZERO ECS grant cases using real PostgreSQL. The prior prepared-count label `realLedgerBrowser: 6` was imprecise and must not be read as six PGlite or PostgreSQL results. Both stores use scripted policy facts and synthetic reviewed plans; no grant test proves a cloud mutation. The helper hardcodes PGlite for five cases and separately hardcodes memory for the denial case. A future report must retain this correction even if broader root PostgreSQL checks passed elsewhere.

The 57 execution cases use scripted cloud/Tofu ports, including the actual registered compiler regression that now invokes `buildDeployWorkspace` and passes its generated workspace into preparation. They do not prove AWS writes or real OpenTofu applies. The 26 SDK cases use real command types with mocked responses. The 11 Temporal cases require an actual isolated Temporal server, but their activities remain scripted contract scope.

## Existing gates and future followups

`GATE_LANES.workflows.files` includes `tests/workflows`, `tests/platform` and `tests/security/workflow-history.test.ts`. Its dynamic requirements therefore discover `tests/workflows/ecs-replica-repair.test.ts` and `tests/platform/ecs-replica-repair-grants.test.ts` automatically. The required Temporal flag is already enabled. The current file requirements reject zero, failed or skipped assertions in these files. They do not independently pin a deleted file or an individually removed test case.

The 57 execution cases run in the normal node project through core unit discovery, whose canonical core gate currently relies on command exit and has no required JSON group set. The 26 SDK cases also run in the broad OpenTofu lane command because it includes `tests/providers/aws/drivers`, but they are not in the fixed `TOFU_SUITES` requirement list. Their inclusion is not evidence that a real AWS API was exercised.

Minimal proposed followup, not implemented: keep the existing workflows lane and append the two explicit files `tests/execution/ecs-replica-repair.test.ts` and `tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts` to its command. Add fixed required groups for `immutable ECS replica materialization` (33 prepared cases), `raw full-environment repair plan` (11), `existing plan/apply activity integration` (13), and `ECS replica ownership reads` (26). Pin the existing new workflow and grant files as fixed required files while deduplicating dynamic entries, so file deletion cannot silently erase their requirement. Preserve the existing strict checker and its skip/error behavior. Exact case-count enforcement, if wanted after the first observed run, requires a reviewed trusted manifest contract rather than treating a report as its own requirements.

Real PostgreSQL followup, not implemented: parameterize the five SQL fixture cases over PGlite and PostgreSQL using the existing support harness, require a `[postgres]` ancestor suite and add this exact file to the `platform-postgres` command plus its trusted requirements. That lane currently executes controlplane/capabilities/runners/reconcile paths and does not scan platform files for backend suites. Running the workflows lane with a PostgreSQL URL cannot fix a hardcoded PGlite fixture. To cover all six behaviors on both SQL engines, move the planning-denial behavior into the SQL matrix and retain its existing memory assertion separately. This changes prepared counts and must happen only after the frozen 100 cases are first verified, with root authorization. Shared harness cleanup already closes both database handles. Missing PG configuration must fail the required PostgreSQL group rather than promote PGlite evidence.

Root owns manifest, canonical OBS integration, release ledger and all commits. The OBS owner consumes `supportsDeclarativeRepair` through the allowed neutral resource barrel. Existing boundary and purity checks must not be weakened. No speculative PG test expansion or manifest change was made.

## Suggested two-paragraph OBS limitation text

Repair availability is determined from the exact resource and drift finding. A genuine registered native `drift.repair` handler may provide a native repair path; the shared pure declarative contract also recognizes the bounded AWS managed ECS replica recipe without inventing such a handler. Declarative admission requires the matching container service address and native type, a low or medium changed finding affecting only replicas, a desired integer count from 1 through 20 and a digest-pinned image. This predicate grants no authority and performs no provider reads or writes. Unknown, missing, external, other-field and unsupported targets remain ineligible.

The ECS adapter candidate is not yet integrated or verified for production repair. Shared recipe availability or a repair proposal therefore does not establish that a cloud repair ran. Integration must retain separately authorized read-only planning, complete live ownership and autoscaler proof, an immutable target binding, strict full-environment saved-plan checks, the exact current-round browser digest, a fenced mutation grant, and matching durable readback evidence. The prepared contracts and isolated Temporal scenarios are pending; live AWS acceptance is neither authorized nor proven. Lost responses, failed receipts, lost fences and cancellation after an apply attempt must remain uncertain and block a blind retry. Durable outbox and operator recovery remain separate followups.

## Scope and security limits

Subset OBS01/LIFE03/DUR03+DUR07 only; the user's full production scope remains root's responsibility. One existing managed Fargate replica service and one desired_count update from 1 through 20 are supported. No new resources, replacements, targeting, graph pruning, unrelated fields, task/image changes, native UpdateService fallback, rebuild, compensation or blind retries are allowed. Initial and resumed execution claims issue independently authorized planning authority, not an early repair bearer. Exact current-round browser review and immutable binding are required before mutation, even where workspace policy would otherwise allow automation.

An absent stored ARN resolves only through successful complete unique scoped tag lookup, then exact service identity/tags/account/region and autoscaler absence reads. Denied, partial, missing, ambiguous or foreign reads refuse. Retry materialization compares the original evidence row and cannot retarget. Successful readback is not clearance without the exact durable non-simulated verification receipt. Cancellation uncertainty is opted in only for the patched recipe; legacy replay behavior is preserved. External cloud operators can still race the final read; the Zenith fence coordinates Zenith writers. Full durable outbox, recovery epoch and operator continuation remain outside this bounded candidate.

## Resume prerequisites and next root checks

First obtain explicit user resume and root coordination. The prior exclusive dependency grant has ended. It authorized only metadata/install/audit and was fully released. It does not authorize compiler/tests/services now. No live AWS permission was granted, and no commit or push is authorized for this worker.

After resume, root should verify the candidate and freeze receipt hashes, then assign its serial resource slot for full TypeScript and owned lint, the three local focal suites (89 prepared cases, one worker), and the real isolated Temporal focal suite (11 prepared cases with required Temporal flag and pinned CLI). Review real recorded counts and failures before changing the PG matrix. Then repeat affected existing capability execution, plan/apply, ledger-approval, plan-approval, registered ECS compiler/read/operation, workflow operations/cancellation/sandbox/replay suites; real pinned OpenTofu validation and Go checks; independent security review; and the mandatory complete locked audit. Actual Linux compatibility and authorized live SMTP/TLS/cloud proof remain distinct release checks.

No commands listed here were executed as part of this pause checkpoint. Root owns integration, reviewed human commits and any later gate/ledger publication. The worktree, private install and immutable logs are preserved for inspection.
