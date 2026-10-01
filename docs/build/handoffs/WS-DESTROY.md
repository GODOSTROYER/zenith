# WS-DESTROY — environment teardown: OpenTofu destroy through the same safety rails

Workstream: WS-DESTROY (new; orchestrator brief) — Branch ws/destroy — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-destroy
Base: platform/integration (platform composed end to end; tsc clean)

## Situation
- Capability `infrastructure.destroy` exists in the catalog (critical, destructive, defaultAutonomy 6),
  and the runner protocol's `tofu.run` plan accepts `destroy: true` (RUNNER-PROTOCOL.md), but the
  TypeScript OpenTofu engine (src/lib/tofu/engine.ts, runner.ts) has NO destroy path, no workflow tears
  an environment down, and the live acceptance harness ships its own destroy runner
  (scripts/acceptance/tofu-destroy.ts) because of that.
- Stateful protection: src/lib/tofu/plan.ts `DEFAULT_STATEFUL_TYPES` lists AWS stateful types only;
  GCP (google_sql_database_instance, google_sql_user, google_redis_instance, google_storage_bucket,
  google_secret_manager_secret(_version), google_artifact_registry_repository, google_dns_managed_zone,
  google_pubsub_topic/subscription), Azure (postgresql/mysql flexible server, redis, storage account/
  container, key vault/secret, service bus, dns zone) and OCI (db systems, buckets, vault secrets,
  queues, volumes) are missing. AWS-NET's `assessRecordDeletion` (dangling-DNS guard) must run before
  any plan that deletes a dns_record. Resources carry `deletionPolicy`.
- WS-LIVE also needs a creation-time run tag: execution's `baseTags` (src/lib/execution/session.ts:45)
  has no hook for an allowlisted extra tag such as `zenith:live-run`.

## Objective
A human can destroy an environment (or the resources removed from a manifest) through
propose → policy → digest-bound plan review → human approval → fenced apply, with stateful data
protected unless the resource's deletionPolicy explicitly allows deletion and policy approves.

## Owned paths
src/lib/tofu/engine.ts, runner.ts, plan.ts (destroy plan + stateful types; keep existing exports) ;
NEW src/lib/execution/destroy.ts (+ registering its activities in src/lib/execution/activities.ts and
index.ts) ; src/lib/execution/session.ts (allowlisted extra-tag hook only) ; NEW
src/lib/workflows/definitions/destroy.ts + its registration in src/lib/workflows/definitions/index.ts and
the client (`startDestroy`) in src/lib/workflows/client.ts (additive; replay tests must stay green) ;
scripts/acceptance/** (switch the harness to the engine destroy and the run-tag hook) ;
tests/tofu/destroy*.test.ts, tests/execution/destroy*.test.ts, tests/workflows/destroy*.test.ts,
tests/acceptance/** (new or updated).
Do NOT edit src/lib/execution/{plan,steps,platform}.ts, src/lib/platform/broker.ts,
src/lib/capabilities/** (WS-APPROVAL-FLOW) or src/lib/providers/aws/drivers/** (WS-DRIVER-FIX).
If the broker or the product needs a hook (e.g. a `environment.destroy` product action calling
propose with `infrastructure.destroy`), describe it exactly in your report.

## Build
1. Engine: `planDestroy(ws, session, {lock})` (tofu plan -destroy, digest-bound like plan, normalized,
   sensitive masked) and apply of a verified destroy plan via the existing `applyVerifiedPlan`
   (approval digest must match; plan_changed otherwise).
2. Stateful guard: destroying any stateful type requires the node's deletionPolicy to allow it; the
   plan facts expose `statefulDeletes` so policy (already requires approval for destructive ops) sees
   them; DNS record deletes run `assessRecordDeletion` first and refuse a dangling target.
3. Destroy workflow: lease → plan destroy → evaluatePolicy → approval gate (reuse the deploy
   workflow's gate helpers from runtime.ts) → final destroy plan == approved digest → apply → verify
   absence via drivers' observe (missing = success; inaccessible/unknown = uncertain, never "done").
4. Run-tag hook; harness uses the engine destroy (keep its tag-based sweeper as the last resort).
5. Tests: engine destroy plan/apply with the fake tofu port and the real tofu binary (gated; say if it
   cannot run), stateful refusal per provider family, dangling-DNS refusal, workflow happy path +
   plan_changed + lease lost (uncertain) + approval reject, replay compatibility.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/tofu src/lib/execution/destroy.ts src/lib/execution/session.ts src/lib/workflows scripts/acceptance tests/tofu tests/execution tests/workflows tests/acceptance
- npx vitest run --maxWorkers=2 tests/tofu tests/execution tests/workflows tests/acceptance
- ZENITH_TEST_TOFU_NETWORK=1 npx vitest run --maxWorkers=2 tests/tofu/destroy
