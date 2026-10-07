# Sensitive persistence: inventory, protection, minimization, leak tests

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

1. The sealed result body in `platform.runner_jobs.result` and `platform.machine_requests.result` once the
   job settled and `ZENITH_RESULT_RETENTION_HOURS` passed (default 72, 1 to 720). The row, status, signed
   assignment, exit code and timestamps stay; a `minimized` marker replaces the body. The result was only a
   rendezvous between the reporting agent and the awaiting activity.
2. Expired source uploads in `agent.agent_uploads`, swept on every tick instead of only when another upload
   arrives.
3. Log fields: `src/lib/log.ts` now passes every string field and error stack through the credential and
   observability redactors before writing.

Deliberately not touched: `agent_effect_receipts` (immutable by trigger; they keep a sealed copy of the
outcome, so the sealed body still exists once, under the result key), plan custody tables, job and request
log lines, evidence, events and the operation ledger. Their retention is PROD-OPS-07, and deletion there
awaits an approved policy.

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
