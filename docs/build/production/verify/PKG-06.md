# PKG-06 durable database acceptance

Implementation status: `implementation_complete_verification_pending`. J1 local installation mechanisms and gated checks are built; hosted production acceptance, clean-host recovery and cross-worker execution are not verified.

Contract: “Complete Supabase/hosted migrations, production TLS/pooler/authorization/concurrency/recovery acceptance is distinct from local PostgreSQL contracts.”

| Acceptance part | Code and evidence boundary |
| --- | --- |
| Complete immutable Supabase/hosted migration sequence | `up.mjs` applies every committed SQL snapshot in numeric order to the genuine CLI Supabase PostgreSQL with its actual Auth/Data API roles. `verify-database.mjs` reapplies the same bytes and records each SHA-256. Existing snapshots and platform migrations are unchanged. Failures refuse startup or acceptance. |
| Verified pooler TLS | Native Supavisor TLS on 6543; `pooler-probe.mjs` uses the real installed postgres.js client, verify-full, private CA, positive queries and wrong-CA/wrong-hostname negative controls. Disposable platform PostgreSQL is intentionally the existing separate non-TLS fixture. No claim of production platform TLS or Temporal authentication/HA. |
| Real authorization and protected schemas | HTTPS calls to real PostgREST verify `agent`/`platform` produce `PGRST106` and are not exposed; a runtime-created owned workspace is invisible to anon but readable with the genuine service key. Native privilege inspection uses actual roles, not stand-ins. The row is removed in `finally`. |
| Concurrency | Eight independent native clients commit serialized increments through the transaction pooler, with exact final readback. Default composition also provides two APIs and two workers, whose actual health is checked. This is pooler transaction concurrency, not a fabricated worker-effect/recovery proof. DUR-02/05 execution joins remain separate. |
| Recovery | Real `pg_dump` from both stores, private backups, restore into newly owned empty databases, marker readback, exact migration-ledger comparison, table ACL/RLS comparison, and bounded database cleanup. This same-engine logical rehearsal is explicitly labelled `cleanHost=false`. Wave-5 OPS-04 owns the broader clean-host controller and key-custody restore. |
| Honest evidence separation | Receipts use `kind=local_engine`, actual source/architecture/profile and explicit pass/fail counts. `hostedProductionAcceptance`, `crossWorkerExecution`, `cleanHostRecovery`, and `productionReady` remain false. Pure contracts are `tests/deploy/default-stack.test.ts`; real suite is the opt-in `tests/deploy/default-stack.engine.test.ts`. |

## Exact Mac commands

Use [PKG-04 prerequisites and native lean profile](./PKG-04.md). Do not run two engine workloads concurrently. A fresh gated engine suite builds, verifies both stores and cleans all owned resources:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
export ZENITH_DEFAULT_STACK_PROFILE=lean
# ZENITH_DEFAULT_STACK_REGISTRY_IMAGE must be the inspected real registry digest.
# ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR must be a new outside-source private path.
npx vitest run tests/deploy/default-stack.engine.test.ts --no-file-parallelism --maxWorkers=2
```

Expected **3 passed / 0 failed / 0 skipped**, sanitized readiness/database receipts, backup ledger and ACL/RLS preservation, zero owned Docker resources after cleanup. A gated-off run is **0 passed / 0 failed / 3 skipped**, not acceptance. A default 2+2 successor requires a fresh directory and adequate measured Docker capacity; do not infer it from lean success.

For an already running J1 installation:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
node scripts/acceptance/default-stack/readiness.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/verify-database.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/cleanup.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
```

Retain failed attempt receipts. Dumps contain credentials and rows and stay only in the private directory; cleanup deletes them after owned-resource absence. Never publish dumps, effective env files, keyrings, status output or certificates' private keys.

## Unrun and integration boundaries

Docker/Supabase/real PostgreSQL/Temporal checks were **not run on this Windows builder**. Hosted Supabase, live clouds, production Temporal and customer systems remain deferred. No migration inventory, SQL emission, sensitive-data inventory, package or gate changes are needed. The orchestrator should join OPS-04's clean-host harness, DUR's cross-worker execution campaign, J2's authenticated browser journey, and the cross-database MCP admission seam described in PKG-04 before promoting acceptance. No existing assertion was weakened. The sole changed expectation in `installation.test.ts` is `additionalWorkerPreparationSupported: false -> true`, because `prepare --join` is now implemented and tested.
