# Production-hardening architecture gate

Status: approved for bounded implementation from `45d065833ba57e947ed7f30285877efa9208f3f8`.

This gate records the source-verified disposition of the prior review and the
contracts that implementation work must preserve. It is intentionally scoped
to the existing Node application, PostgreSQL durable state, durable artifact
storage, and the already-supported execution backends. It does not authorize
production migration, infrastructure application, package publishing, or
secret changes.

## Repository baseline

| Repository | Default branch | Current head | Prior review baseline | Intervening default-branch changes |
|---|---|---|---|---|
| `GODOSTROYER/zenith` | `master` | `45d065833ba57e947ed7f30285877efa9208f3f8` | `45d065833ba57e947ed7f30285877efa9208f3f8` | None |
| `GODOSTROYER/Zenith-plugins` | `main` | `5730b3a68bd49124d52c7406e75c57a586087f02` | `5730b3a68bd49124d52c7406e75c57a586087f02` | None |

The application has a separate `main` ref, but GitHub reports `master` as its
default branch. The plugin default is `main`.

## Finding and evidence matrix

| Finding | Disposition | Evidence | Owner | Regression / live gate |
|---|---|---|---|---|
| Alert webhook blind SSRF | **Reproduced; release blocker** | `src/lib/actions/defs/alerts-channels.ts` accepts URL syntax while `src/lib/alerts/deliver.ts` POSTs to the stored target and follows redirects. | C | DNS/IP/redirect fixtures, bounded response and timeout tests; no live metadata probing |
| Alert credentials/plaintext webhook secrets | **Reproduced; release blocker** | Alert channel settings retain signing credentials and credential-bearing targets; `src/lib/secrets/index.ts` encrypts application secret records but is not the alert-channel authority. | C with A | Dual-read migration, ciphertext/tamper/tenant-binding/rotation/redaction tests; staging migration rehearsal |
| Plugin provenance | **Partially addressed; hold** | `zenith-plugins` generates inventories/checksums, but its own docs state hashes are not publisher authentication. | D | Signed release verification before install/execute, trust/revocation tests, application compatibility check |
| E2B dependency supply chain and egress | **Partially addressed; hold** | `src/lib/hosted/build/runner-e2b.ts` leaves egress enabled and installs packages at job time; lifecycle isolation exists but production parity is unverified. | D with F | Frozen lockfile/install-policy tests, egress/teardown evidence, disposable live lane |
| Synchronous PostgREST bridge | **Reproduced; rework** | `src/lib/db/pg/sync-rest.ts` uses a worker and `Atomics.wait` for up to 15 seconds; used by history/audit/secrets paths. | A | Async API contract, injected failure/restart tests, event-loop measurement |
| Agent-control PostgreSQL write refusal | **Reproduced; correct limit** | `docs/AGENT-CONTROL.md` explicitly keeps reviewed writes on a long-lived single-writer file-store host until application transactions and the journal are coordinated. | B | Preserve fail-closed guard; add topology tests; no guard removal in this change |
| `ZENITH_STORE` vs `ZENITH_HOSTED_STORE` split | **Reproduced; guard/document** | Product storage and hosted authority/data/artifact selection are independent; mixed modes can otherwise appear healthy while using different authorities. | A/F | Boot matrix rejects unsupported combinations; documentation and readiness checks |
| Full test instability | **Unverified as product failure** | Baseline typecheck passed; plugin verification passed. Broad application tests require the repository-supported Node/runtime and isolated fixtures before classifying failures. | F | Reproduce on supported Node; report environment vs product failures without weakening assertions |
| UI routing/polling/accessibility items | **Unverified pending source/test reproduction** | Prior report findings require current-path confirmation before edits. | E | Browser/keyboard/narrow viewport/reconnect tests and request-volume measurement |

## Architecture decision record

### ADR-001: supported production topology

1. Hosted application state, alerts, audit/history, encrypted secret records,
   hosted authority state, and durable artifacts use their existing PostgreSQL
   and artifact-storage adapters. No Redis, ORM, microservice, or framework
   replacement is introduced.
2. Agent-control reviewed writes remain a separate, long-lived, single-writer
   file-store control node until a coordinated application transaction and
   operation-journal adapter is proven. The existing PostgreSQL refusal remains
   fail-closed.
3. Local `ZENITH_STORE=file` is explicitly local/single-writer. It is not
   advertised as hosted durability. Unsupported mixed product/hosted store
   combinations fail at boot/readiness rather than silently forming hybrids.
4. Business state, audit/operation records, idempotency state, and outbox
   intent that share an authority commit in one transaction. Separate
   authorities use durable intent plus reconciliation; the system never claims
   cross-system exactly-once execution.
5. External effects retain uncertain outcomes after ambiguous dispatch, use
   provider idempotency where available, bounded retry/backoff, and operator
   reconciliation. A unique outbox row alone is not proof of one send.
6. Secret values are never copied into settings, manifests, audit, exports, or
   logs. Alert secrets migrate to encrypted secret references using the existing
   crypto seam, with versioned dual-read/backfill/cutover and missing-key
   fail-closed behavior.
7. Network storage APIs are widened to async at explicit boundaries. No new
   blocking substitute or unawaited required write is permitted.
8. Every mutation and worker rechecks current tenant/principal authorization,
   approval digest, target state, expiry, and lease/fence before returning a
   protected result or finalizing work.

### Migration and rollback

Use new versioned migrations only. Rehearse validation, resumable backfill,
restart/resume, reconciliation counts, cutover by feature flag, and forward
recovery on representative state. Retain dual-read compatibility until counts
and decryptability agree. Do not edit shipped migrations, delete plaintext
copies without a retention decision, or perform production cutover in this
task.

## Dependency-ordered work graph and ownership

Shared contracts and migrations have one owner at a time. Workers use isolated
branches/worktrees and return commits; only the integrator applies them.

1. **A0 / integrator:** freeze contracts, store-topology matrix, migration
   naming, and test fixtures. Own `src/lib/db/types.ts`, shared schemas,
   `supabase/migrations/**`, and generated contracts.
2. **C1:** own `src/lib/alerts/**`, alert action definitions, and secret
   reference adapter/tests. It may propose changes to A0-owned schemas, but
   does not edit migrations concurrently.
3. **A1:** own async repository interfaces and call sites under
   `src/lib/db/**`, `src/lib/secrets/**`, server actions/routes/workers that
   consume them, plus async/event-loop tests. Preserve existing PG delegates.
4. **B1:** own agent-control coordinator/journal/leases/idempotency and its
   tests. It must not remove the PostgreSQL write refusal. Coordinate journal
   schema changes through A0.
5. **D1:** own `Zenith-plugins` release/build scripts/docs and application
   E2B dependency-install policy. Plugin generated outputs come from canonical
   build scripts; no hand edits.
6. **E1:** own notification/integrations/responsive/polling UI paths and
   browser tests. It consumes A/B contracts and does not edit storage schemas.
7. **F1:** own CI/test harness, operations docs, health/readiness, retention,
   dead-letter and backup/restore tooling. It integrates after domain contracts
   exist and owns the final evidence matrix.
8. **Integrator/review:** re-run affected gates, have a fresh Luna reviewer
   inspect changes it did not author, then have Sol review transaction,
   authorization, migration, and unresolved-tradeoff evidence.

## Deployment and acceptance matrix

| Mode | State authority | Allowed scope | Required evidence |
|---|---|---|---|
| Local development | File store; single writer | Product/local features; agent control only with explicit local flags | typecheck/lint/targeted tests; filesystem-loss and restart behavior documented |
| Supported hosted production | PostgreSQL for hosted/product state, existing durable artifact storage, encrypted secret references; separate agent-control node until B is proven | Only features whose adapters and authorization gates are verified | migration rehearsal, async/event-loop checks, tenant isolation, failure injection, backups/restore, readiness and observability |
| Experimental PostgreSQL agent-control writes | **Unavailable** | Fail closed; no enablement by removing a guard | Requires coordinated transaction/journal, multi-instance leases/fences, revocation races, restart and uncertainty tests |
| E2B build backend | **Hold** | Not production-supported until provenance, frozen dependency resolution, egress, teardown, and live evidence pass | Docker/E2B parity evidence on disposable targets |
| Plugin installation | Signed/trusted release only for production | Unsigned/hash-only artifacts are rejected or explicitly local-only | signature/trust/rotation/revocation and application contract checks |

## Baseline evidence

- OpenClaw 2026.9.4 exposes configured aliases `sol` and `luna`.
- Application `npm run typecheck`: exit 0.
- Plugin `npm run verify`: exit 0; 130 tests passed, 2 skipped, contracts and
  integrity checks passed.
- No production migration, infrastructure change, secret change, package
  publish, or default-branch mutation has been performed.
