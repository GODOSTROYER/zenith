# WAVE3-GAPS: PROD-OBS-02 composition and PROD-LIFE-11 MySQL by DNS hostname

Branch `prod/gaps-w3`, based on c9a942d6. Build-only: nothing below was executed by the worker (only `tsc --noEmit` and `eslint` on the changed files).

## 1. Summary

### Gap 1: PROD-OBS-02 composition (default telemetry endpoints, machine health caller)
- `src/lib/env.ts`: five new validated variables (section 3). URLs and tokens are redacted in the boot error.
- `src/lib/observability/sources/configured-endpoints.ts` (new): reads the validated env, normalizes each URL with the existing `normalizeBaseUrl` (http/https only, no credentials, no query, cloud metadata hosts refused), builds a per-request token provider (token read at call time, never in output) and an optional `X-Scope-OrgID`. A malformed value becomes an explicit `unavailable` source (id `prometheus` / `loki`) naming the variable, never a throw and never a silent drop.
- `src/lib/observability/sources/factory.ts`: `sourcesForEnvironment` falls back to the configured endpoints when the caller passes no `endpoints`. Every default caller therefore gets them: `platform/agent-ports.ts` (MCP observe fabric and incident investigator), `agent-access/v3/adapters.ts`, `execution/verify.ts`. Explicit `endpoints` still win (tests, embedders).
- `src/lib/execution/capability.ts` (`executeMachineCapability`): read-only health operations (`MACHINE_HEALTH_OPERATIONS`: `machine.inspect`, `service.status`, `container.inspect`, `system.metrics`, `process.list`) now run through `readMachineHealth` over the same `executeMachineOperation` authority path (grant, constraints, evidence sink unchanged). The `TelemetryEnvelope` (signal `health`, scope incl. address, source `machines.<transport>`, freshness, fresh/stale/unknown/inaccessible) is stored as a non-critical `observation` evidence row (`summary.kind = "machine_health"`, key `machine-health:<operationId>`). A refusal is stored as an `inaccessible` envelope and then still raises the same `StepFailedError` as before; `uncertain` / `evidence_failed` / `aborted` propagate exactly as before. The activity return value and summary text are unchanged. A failure to store the envelope is logged and never changes the health answer.
- The machine capability activity is the execution path behind the MCP/API machine status capabilities, so `readMachineHealth` now has a production caller.

### Gap 2: PROD-LIFE-11 MySQL by DNS hostname
- `src/lib/portability/engines/mysql-inprocess.ts` (new): in-process transport on `mysql2/promise`.
  - Connects via a `stream` factory that dials ONLY an address returned by `resolveConnectableHost` for THAT connection (all answers must pass, private opt-in honoured, loopback/link-local/metadata refused). The factory refuses to run twice per validation. Up to 3 attempts for transient pre-handshake failures (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `PROTOCOL_CONNECTION_LOST`, ...), each with a FRESH resolve and validation, rotating through the validated answers. TLS and authentication failures are final.
  - TLS: `host` = original hostname (mysql2 sets `servername` and runs `tls.checkServerIdentity(hostname)`), `ssl: { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2" }`, never configurable. After connect a defense-in-depth check asserts the live stream is `encrypted`, `authorized` and that the peer certificate names the hostname. CA is the operator's `ZENITH_MYSQL_CA_FILE` (same trusted-file loader as before) or the system roots.
  - `LOCAL_FILES` disabled, `multipleStatements` off. Errors never carry addresses, ports, server text or credentials: a connect failure is `unavailable`; a server-side statement error is exit status 1 with empty stderr, as the CLI wrapper does.
  - Same closed `mysql` / `mysqldump` argument contract as the CLI wrapper: query (`-e`), restore script (stdin) and dump are implemented in-process. Rows are rendered as `mysql --batch --skip-column-names --binary-as-hex` prints them (NULL, `\t \n \\ \0` escapes, `0x` upper-case hex for binary-charset string/blob/bit columns) so logical digests agree with the stock client path.
  - Dump: one `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` session at UTC; tables (`SHOW CREATE TABLE` plus batched `INSERT`, generated columns excluded, binary as hex, BIT as number), views in dependency order, triggers inside `DELIMITER ;;`. DEFINER clauses are stripped from views and triggers (the restoring user becomes definer; a stock dump keeps them). The engine still wraps it in its before/after logical-digest consistency check and still refuses routines and events.
  - Restore: a DELIMITER-, quote- and comment-aware statement splitter (`splitStatements`) runs statements one by one on a single connection, stopping at the first failure. It also reads dumps made by stock `mysqldump`.
- `src/lib/portability/engines/mysql.ts`: `spawnMysqlCli().run` delegates to the in-process transport ONLY for TLS (`--ssl-mode=REQUIRED`) to a DNS hostname. Literal-IP TLS and the private-network opt-in no-TLS mode keep the stock client exactly as before (same pinned `--host=<validated IP>`, same refusals). The previous DNS-TLS refusal (`unsupported_objects`) is removed because it is now served. `parseClientArgs` additionally returns port, user, database and the `-e` statement.
- Verified behaviour changed on purpose: the former "DNS-host TLS is refused" contract now succeeds with verified identity. Two existing tests were edited accordingly: the first refusal case in `tests/portability/mysql-engine.test.ts` (now: a private answer without opt-in is refused with `invalid_input` before any connection) and the last case in `tests/portability/mysql-cli-tls.test.ts` (now a positive and a negative DNS identity case). In the gated real-server lane of `mysql-engine.test.ts` the retry sub-case that depended on the old refusal was removed (it would have dialed a public address); its coverage moved to `mysql-inprocess.test.ts`.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Default telemetry composes Prometheus/Loki from supported config | `configured-endpoints.ts`, `factory.ts`, `env.ts` | `tests/observability/configured-endpoints.test.ts` (default factory, explicit wins, bearer and tenant header with envelope naming `loki`, invalid or metadata endpoint becomes explicit unavailable) |
| Machine health has a production caller producing scoped envelopes | `execution/capability.ts` calling `readMachineHealth` | `tests/execution/machines.test.ts` ("a machine health read stores a scoped telemetry envelope...", "a refused machine health read is stored as an inaccessible envelope...") |
| MySQL by DNS hostname with full certificate and identity verification | `mysql-inprocess.ts` | `tests/portability/mysql-inprocess.test.ts` "in-process MySQL over verified TLS": SNI is the hostname, dials only the validated literal, wrong-identity / untrusted-CA / no-TLS server all refused before any credential, no address, port or password in errors |
| Re-validate on every new connection and retry; all-answer rejection; private-host opt-in | `connect()` loop in `mysql-inprocess.ts` | same file, "rebinding, all-answer rejection and private-host opt-in" (rebind on 2nd connection, mixed answers, private/loopback without opt-in, retry re-validates, rebind between retries) |
| Literal-IP CLI behaviour unchanged | `mysql.ts` branches only for hostname TLS | "literal-IP TLS is not routed in-process"; unchanged wrapper tests in `mysql-engine.test.ts`; IP cases in `mysql-cli-tls.test.ts` |
| Export / import / readback over the new path | `runQuery`, `runScript`, `runDump` | splitting, script, dump, render and limit tests in `mysql-inprocess.test.ts`; real-engine lane below |
| Real-engine tests gated like existing MySQL ones | `ZENITH_TEST_MYSQL_DNS_TLS_URL` lane | last describe of `mysql-inprocess.test.ts`; DNS positive and negative in `mysql-cli-tls.test.ts` (gated `ZENITH_TEST_MYSQL_CLI_TLS=1`) |

New helper: `tests/portability/mysql-wire-fixture.ts` (owned MySQL wire peer with a real TLS upgrade; not a MySQL engine).

## 3. Verification commands (other machine)

New env (document in DEPLOYING.md; the worker did not edit it):
- `ZENITH_OBSERVE_PROMETHEUS_URL` (optional http/https base URL), `ZENITH_OBSERVE_PROMETHEUS_TOKEN` (optional bearer)
- `ZENITH_OBSERVE_LOKI_URL`, `ZENITH_OBSERVE_LOKI_TOKEN`, `ZENITH_OBSERVE_LOKI_TENANT` (optional `X-Scope-OrgID`)
- Existing and now relevant for MySQL hostnames: `ZENITH_MYSQL_CA_FILE` (absolute path to the CA bundle that signs the database certificate; system roots if unset) and `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1` for private databases.

```
npx vitest run tests/observability tests/execution/machines.test.ts tests/execution/capability-clouds.test.ts tests/machines tests/agent-v3
npx vitest run tests/portability

# real engine, DNS hostname over TLS: EMPTY scratch database; the hostname must resolve to the server and be named by its
# certificate; ZENITH_MYSQL_CA_FILE must trust its issuer; allow private if it resolves to a private address
ZENITH_TEST_MYSQL_DNS_TLS_URL='mysql://user:pass@db.example.test:3306/scratch' ZENITH_MYSQL_CA_FILE=/abs/ca.pem \
  ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1 npx vitest run tests/portability/mysql-inprocess.test.ts
# optional digest parity with the stock client: also set ZENITH_TEST_MYSQL_IP_URL to the SAME database by literal IP
# (needs mysql on PATH and a certificate with an IP SAN)

# existing lanes
ZENITH_TEST_MYSQL_URL=... npx vitest run tests/portability/mysql-engine.test.ts
ZENITH_TEST_MYSQL_CLI_TLS=1 npx vitest run tests/portability/mysql-cli-tls.test.ts   # needs mysql client and openssl

npx tsc --noEmit -p .
npx eslint src/lib/portability src/lib/observability/sources src/lib/execution/capability.ts src/lib/env.ts
```
Expected: all pass; gated lanes skip without their env. No Postgres or Temporal needed for the new tests.

## 4. Known gaps and what may break first
- Nothing was run. The wire fixture speaks a hand-built subset of the MySQL protocol; if mysql2 3.24.5 expects a packet that was not modelled, the contract tests in `mysql-inprocess.test.ts` fail first (greeting, OK and result-set framing, and the "server closed before greeting" retry case which relies on mysql2 reporting `PROTOCOL_CONNECTION_LOST`). The fixture is the first suspect, not the connection logic.
- Digest parity between the in-process renderer and the stock client is by construction (text protocol plus mysql batch escaping plus `--binary-as-hex` rules). Exotic types (GEOMETRY, JSON, spatial) are the likeliest mismatch; the optional parity check covers one table of common types.
- The in-process dump is not byte-identical to `mysqldump` (no DROP statements, DEFINER stripped, no routines or events which the engine refuses anyway). It restores with the stock `mysql` client and with the in-process restore.
- MariaDB specifics were not considered; MySQL 8 semantics were assumed.
- One connection per `run()` (one process per call before), so fingerprinting a many-table database opens many verified connections.
- Machine health envelopes are stored as evidence, not appended to the activity result, to keep workflow history free of machine data and the existing activity result contract intact. An operator surface that must show them inline reads the `machine_health` observation evidence by operation id.
- Prometheus/Loki endpoints are platform-wide operator configuration (same backends for every workspace; tenant isolation is the existing label-matcher scoping inside the sources). There is no per-workspace endpoint configuration.
- Shared-file updates for the orchestrator: DEPLOYING.md (the five `ZENITH_OBSERVE_*` variables and the MySQL hostname path and CA note), LIMITATIONS.md (remove "MySQL DNS-host TLS refused", add the dump differences above), ledger. No migration, SQL, tenancy classification or gate manifest change is needed.

## 5. Suggested ledger implementationStatus
- PROD-OBS-02: `implemented_contract_tested: default stack composes Prometheus/Loki from ZENITH_OBSERVE_* and machine health reads (service.status, machine.inspect and peers) store scoped telemetry envelopes through the execution activity; contract and fake-engine tests only, no live provider run`
- PROD-LIFE-11 addendum: `mysql_dns_hostname_tls_in_process_contract_tested_real_engine_lane_gated_unrun: mysql2 transport dials only the validated address per connection and retry, verifies chain and hostname, export/import/readback over it; literal-IP stock client path unchanged`
