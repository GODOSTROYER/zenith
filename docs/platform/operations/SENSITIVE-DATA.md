# Sensitive persistence: inventory, protection, minimization, leak tests

Written against branch `codex/production-2026-10-02`, guide input at `e34c4673daf20f167311a3b9c9b148de1c027f4c`. Source documentation only; deployment and recovery acceptance remain separately recorded.

PROD-OPS-06. Where sensitive data can persist, how each place is protected, how long it lives, what
was removed, and how leaks are tested. Nothing here claims that redaction catches every secret.

## What the protections mean

| Protection | Holds for | Meaning |
| --- | --- | --- |
| `sealed` | a secret of any shape | The stored value is AES-GCM ciphertext under a registered key purpose (vault, results, plan custody, Temporal payloads, backups). The only protection that does not depend on recognising the secret. |
| `write-guarded` | recognised shapes only | The repository refuses known credential shapes (`assertNoSecretValues` / `assertNoSecretKeys`) or the writer withholds or masks them. A secret with no recognisable shape or key name is stored as given. |
| `digest-only` | all | A hash or digest is stored, never the value (token hashes, plan digests). |
| `tenant-content` | n/a | Customer data by nature (hosted app records, manifests). Protected by tenancy and access control, not encrypted by Zenith. |
| `host-protected` | n/a | Plaintext on a worker's private volume (mode 0700, short-lived), for example binary plan files while an attempt runs. Encrypt the volume. |
| `none-needed` | n/a | Cannot hold sensitive data by construction (ids, statuses, counts). |

The primary control is unchanged: credentials never reach the control plane, and secret values are
referenced (`vault:...`, ARNs), not stored. The protections above are the backstop for what strays.

## The inventory

`src/lib/sensitivedata/inventory.ts` lists every table (platform, product, hosted and agent schemas),
every sensitive-looking column, and every other sink: files, artifacts, logs, telemetry, workflow
history, model-visible results and env files. Each entry has a data class, a protection, a retention
policy, an owner and an `assurance`:

- `tested`: a named test backs the claim;
- `design`: a named code control, no dedicated test;
- `unreviewed`: classified from its migration only. These are open follow-ups, counted by a ratchet in
  the inventory test so the number can only fall.

`npx tsx scripts/sensitive-inventory.ts [--json] [--only sealed|guarded|unreviewed]` prints it.

`tests/security/sensitive-inventory.test.ts` keeps it honest in both directions. A table or
sensitive-looking column in the migrations that is missing from the inventory fails the suite, and so
does an inventory entry for something that no longer exists. Anything classified `secret` or raw plan
must be `sealed` (or a host-protected artifact), never merely write-guarded. **Adding a table or a
content column means adding its inventory entry in the same change.**

## Encryption-at-rest checks

`scripts/sensitive-data-census.ts [--db platform|product]` samples every sealed column in a real
database and checks that what is stored has the shape of ciphertext written by its sealer (a result box
with iv, ciphertext and tag; vault columns with a 12-byte nonce and 16-byte tag; opaque bytes that are
neither JSON nor readable text). It prints column names, counts and fixed reasons only. It proves that
nothing plain-looking sits in a column that must be ciphertext; it is a sample and not a certification.

## Minimization

The `data-minimize` critical job (Temporal critical-maintenance schedule, cron fallback with the same lease
and run record) removes three things that outlived their need:

**DEC-RETENTION is approved (2026-10-13): sealed results go 72 hours after the job or request settles. The job is still a dry run until the operator switches it on.** It reports candidate counts and deletes nothing unless ALL of these hold: `ZENITH_DATA_MINIMIZE_APPLY=1`; the retention policy in force carries a DEC-RETENTION approval (the built-in default does; an operator policy loaded from `ZENITH_RETENTION_POLICY_FILE` or `ZENITH_RETENTION_POLICY` needs its own `approval`, otherwise removal stays off); and the window is valid. The window is `ZENITH_RESULT_RETENTION_HOURS` when set (a whole number from 1 to 720; an invalid value turns removal off) and otherwise the approved 72. Only the sealed result body may go; receipts, the effect ledger, approvals and audit evidence are never touched.

**Legal holds apply here too.** A job or request is skipped while an active hold covers it: a workspace-wide hold, a hold on the matching log class (`runner_job_logs` for runner jobs, `machine_request_logs` for zenithd requests), a hold whose resource reference is the job or request id or its operation id, and a hold whose time range contains the settle time. Holds are checked under the same lock as hold changes. Held rows are reported separately (`held`) and are scrubbed on a later tick once the hold is released.

**Honest gaps.** Zenith does not expire archive objects; the lifecycle rules of the destination bucket decide how long archive copies live. Backups taken before a deletion still contain the deleted rows until the backup itself expires, and Zenith does not track backup expiry yet.

1. The sealed result body in `platform.runner_jobs.result` and `platform.machine_requests.result` once the
   job settled and the configured window passed (apply mode only). The row, status, signed
   assignment, exit code and timestamps stay; a `minimized` marker replaces the body. The result was only a
   rendezvous between the reporting agent and the awaiting activity.
2. Expired source uploads in `agent.agent_uploads`, swept on every tick instead of only when another upload
   arrives.
3. Log fields: `src/lib/log.ts` now passes every string field and error stack through the credential and
   observability redactors before writing.

Deliberately not touched: `agent_effect_receipts` (immutable by trigger; they keep a sealed copy of the
outcome, so the sealed body still exists once, under the result key), plan custody tables, job and request
log lines, evidence, events and the operation ledger. Their retention is PROD-OPS-07, and deletion there
runs under the approved policy (30 days for logs) once the operator turns deletion on.

## Leak tests

`tests/security/persistence-leaks.test.ts` generates canary secrets from random bytes on every run (a
password-in-URL, an AWS key id, GitHub and Slack token shapes, a JWT, a PEM key and one secret with no
shape) and pushes them through the vault, the actions API, the agent proposal path through the capability
broker, structured logs, telemetry envelopes, model-visible results, Temporal payloads, events, evidence,
connection configuration and job logs and results. Afterwards it scans every row of every `platform`
table, the whole data directory, captured log output and each returned value, in raw, JSON-escaped, URL
encoded, hex and base64 forms.

What it proves: secrets of any shape sent into a sealed path are never in plaintext outside the sealed
value (and the sealed value opens again); recognised shapes are refused, withheld or masked by every
guarded path and are in no row afterwards.

What it pins as limits on purpose: an unknown secret with no recognisable shape that is written to a
write-guarded free-text store (events, evidence, log lines), a log field or a model result is stored or
returned. The characterization tests fail if that ever changes without the inventory changing with it.
The same applies to the hosted app records and the legacy product tables, whose protection is access
control.

The suite runs on PGlite (always) and on Postgres when `ZENITH_TEST_PLATFORM_PG_URL` is set. It does not
exercise live cloud, a live Temporal server or an MCP network client; contract-level only.
