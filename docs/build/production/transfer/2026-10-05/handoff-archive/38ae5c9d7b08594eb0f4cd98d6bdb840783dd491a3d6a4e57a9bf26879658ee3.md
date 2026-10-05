# Default approved-source runtime composition

This source packet adds the missing default runtime wiring for the preserved APPROVED-SOURCE R2 dependency. It binds one canonical `ApprovedSourceSnapshotStore` and immutable GitHub reads to the same SQL handle captured by execution composition. The owning source-bundle constructor now creates and returns that store itself, together with its guarded ports, so the default factory cannot pass a different production store. It also fixes its standalone connector closure to that handle; standalone `read()` retains its existing anonymous, unscoped behavior. It never opens or chooses a global database.

`composeExecutionActivities` supplies the captured source store and port after the general port spread. That spread cannot substitute source authority. The existing plan-artifact custody, credential broker, drivers, release journal, machine port and reconciliation composition remain in place. This does not issue an approval, change source/plan digests, rewrite workflow arguments or upgrade a historical source-free approval.

Default build-source support requires the owning PostgreSQL handle's existing structural shape. No unforgeable executor brand exists in the current SQL API, so this check is an internal runtime prerequisite of trusted worker composition, not a cryptographic proof of a live PostgreSQL connection. The retained source store has the R2 module's genuine WeakSet provenance. Its persistence, current recipe, operation/fence and source-binding checks are unchanged.

Source-free PGlite/contract composition still constructs. Its source capture, verification, preparation and stored-source reading ports refuse before HTTP, credentials, global database opening or cloud SDK calls. Canonical source selection with no built service remains empty and adds no executable-source digest. A non-PostgreSQL build cannot silently use another database.

Snapshot, source-port and transport overrides require test mode and an already recognized source store. Raw/copied stores are refused. Conflicting recognized stores are refused. Test store and source methods are captured once, wrapped, and check admission on every invocation; changing test mode stops them before the captured model runs. A caller-provided GitHub connector callback is refused in every mode. Production uses its internally constructed store and fixed owning connector. Direct calls to the exported owning constructor have the same creation and invocation admission checks; they cannot inject a production store or transport. Its real capture, verification, preparation and Azure source reads require the captured PostgreSQL structural prerequisite and recognized store even in test mode. Anonymous standalone `read()` remains available on a non-PostgreSQL handle with default transport. Explicit fake source-port composition remains an isolated test model, including source-free PGlite fixtures; it does not enable real non-PostgreSQL source acquisition. There is no per-request proof, store or database selector.

The five owned paths are:

- `src/lib/platform/execution.ts`
- `src/lib/platform/approved-source-runtime.ts`
- `src/lib/platform/source-bundle.ts`, only the additional owning constructor and its required connector/store/type imports
- `tests/platform/approved-source-runtime.test.ts`
- this handoff

All other 31 APPROVED-SOURCE R2 paths remain exact. Existing source capture, verification, archive, upload, provenance and isolated fixture bodies in `source-bundle.ts` remain byte-identical; the new constructor delegates to them. The patch is against the prepared dependency tree, not its older Git base. The original 32-path candidate is read-only and is not independently accepted by this packet.

## Prepared verification and limits

The new suite exercises real factory, public constructor, SQL adapter, immutable archive and store-brand modules. The original R1 packet and independent constructor rejection are preserved separately; R2 adds direct public constructor production/development override refusals, copied-store and store-free transport refusal, non-PostgreSQL refusal before I/O, structural prerequisite loss, captured test dependencies, environment admission flips and runtime connector callback refusal. Its scripted physical driver and GitHub responses are explicitly models. A composition recorder observes supplied dependencies without running workflows. PGlite provides source-free composition; local execution-world contracts use existing explicit fixtures. These do not establish live GitHub installations, current human authority, PostgreSQL persistence or cloud builds.

The separate `[postgres]` case requires canonical registered schema 13 and an owned PostgreSQL URL, opens two independent pools with `max: 1`, captures through the default source port, retains through the default store, verifies an independently read row, and refuses after a scoped negative revocation fixture while preserving the retained row. It uses modeled public GitHub HTTP responses, existing scoped operation/resource/lease fixtures, and no raw migration DDL. It does not call Temporal, OpenTofu, a credential exchange or a cloud provider. `ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1` fails immediately when the owned PG URL is absent.

Root verification must include:

- `npm run typecheck` and ESLint of the owned TypeScript.
- `vitest run --maxWorkers=1 tests/platform/approved-source-runtime.test.ts`, existing default composition/machine suites, and revised source composition fixtures.
- Canonical actual PostgreSQL/source authority, original OpenTofu plan custody and Temporal workflow/replay gates after schema 13 wiring.

No author test, compiler, lint, installation, database, Docker, API, cloud or commit ran. Requirements PROD-DUR-03, PROD-LIFE-08 and PROD-PKG-02 remain open.

## Outside-owned follow-ups

Root owns migration 13 registry/emitted SQL, repository exports/PURE_HELPERS, strict gate declarations and actual PostgreSQL/Temporal/OpenTofu acceptance. Existing source-bundle composition fixtures that expect built-source preparation without a retained reviewed snapshot already conflict with R2. Source authority overrides in existing default composition fixtures must now supply the recognized isolated store together with their source port. Those tests must be corrected narrowly without relaxing their intended behavior; they are outside this packet.

Broader source-store locking, hosted GitHub/current-human acceptance, caller host integrity, network revocation after observation, provider bootstrap/build behavior and source-free historical operation compatibility remain subject to their existing contracts and independent acceptance. The factory introduces no acceptance waiver or release-completion claim.
