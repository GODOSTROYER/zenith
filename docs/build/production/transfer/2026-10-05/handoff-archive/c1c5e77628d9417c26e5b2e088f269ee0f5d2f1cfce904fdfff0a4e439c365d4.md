# WS-MANIFEST-V2 — the product store accepts Manifest V2

Workstream: WS-MANIFEST-V2 (new; orchestrator brief) — Branch ws/manifest-v2 — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-manifest-v2
Base: platform/integration (all execution, placement, bridge, UI work merged; tsc clean)

## Situation
- Manifest V2 (`src/lib/resources/manifest-v2.ts`) is a strict superset of V1 with `placement`
  (incl. `provider: "auto"`, regions, zones, constraints), `providerConfig` tuning, `release.migrate`
  and more; `upgradeManifest`, `v1View`, `downgradeToV1` and `v2OnlySections` live in
  `src/lib/resources/upgrade.ts`. Execution already upgrades whatever it reads
  (src/lib/execution/graph.ts).
- But the PRODUCT can only store V1: `src/lib/actions/defs/project-manifest.ts` (~75) parses V1 only,
  and `src/lib/domain/types.ts` types Project/Revision manifests as V1 (~268, ~304). So every V2-only
  feature is unreachable from the product, and `placement.apply` (src/lib/actions/defs/placement.ts)
  explicitly refuses to save V2 fields.
- WS-ACT noted: `v2OnlySections` should list `release` (today `downgradeToV1` silently drops it), and
  `src/lib/resources/index.ts` should export `Release` / `MigrateHook`.

## Objective
Projects and revisions can hold a V2 manifest end to end, without breaking any V1 consumer.

## Owned paths
src/lib/domain/types.ts (manifest type broadening: `AnyManifest` where a manifest is stored; additive) ;
src/lib/actions/defs/project-manifest.ts and the other manifest-editing actions under
src/lib/actions/defs/** that parse or validate a manifest ; src/lib/actions/defs/placement.ts (remove
the V2 refusal in `placement.apply` once saving works; keep its reviewed-change semantics) ;
src/lib/resources/upgrade.ts and src/lib/resources/index.ts (the WS-ACT items) ; the product store
read/write paths for manifests under src/lib/db/** ; src/lib/engine/** and src/lib/domain/graph.ts only
to consume `v1View(...)` where they need V1 shapes ; the project payload route
src/app/api/projects/[id]/payload.ts ; any product UI that edits/displays the manifest as a whole only
where it must accept V2 (do not redesign editors) ; tests under tests/actions, tests/resources,
tests/engine, tests/db (new files + necessary updates).
Do NOT edit src/lib/platform/**, src/lib/capabilities/**, src/lib/bridge/**, src/lib/execution/**,
src/app/(product)/platform/** or src/app/api/platform/** (WS-APPROVAL-FLOW is editing some of them).

## Rules
- Storing: a V1 manifest stays V1 byte-for-byte (no silent upgrade on read or write); a V2 manifest is
  stored as V2. Revisions snapshot exactly what was saved.
- Every consumer that needs V1 shapes uses `v1View(manifest)`; anything that would DROP V2 data
  (export to V1, downgrade) must say so (v2OnlySections) instead of silently losing it.
- Validation errors are field-precise and never echo secret values.
- The sandbox engine, diffs (`diffManifests`), cost estimates, Terraform export and the analyze/
  compose-import paths keep working for V1 and handle V2 via v1View or explicit V2 support.
- `placement.apply` writes `placement.provider/regions/zones` as a normal reviewed manifest change.

## Tests
- round-trip V1 unchanged; V2 saved/loaded/revisioned; diff between V1 and V2 revisions; engine deploy
  of a V2 project in sandbox; placement.apply saves a V2 manifest and the next plan shows it;
  downgrade/export reports `release` among v2-only sections; malformed V2 refused precisely.

## Verification
- npx tsc --noEmit ; npx eslint <owned paths> <your tests>
- npx vitest run --maxWorkers=2 tests/actions tests/resources tests/engine tests/placement tests/db tests/domain (whichever exist)
