# Data portability: backup, export, import, adoption and safe decommissioning

PROD-LIFE-11. What Zenith can copy out of a data service into storage the tenant owns, how a restore is
proven, how an existing resource is brought under management, and why Zenith refuses to delete anything it
cannot show it owns. Everything here goes through the capability broker, policy and a human approval; a model
can propose, never decide.

## The four capabilities

| Capability | What it does | Autonomy | Scope |
|---|---|---|---|
| `data.export` | Reads a data service (managed or referenced) and writes a verified artifact into tenant-owned object storage. The source is only read. | 5 | the service (resource) |
| `data.import` | Restores an export into a NEW, EMPTY, managed target, then reads the target back through a fresh connection and compares it to the export. | 5 | the target (resource) |
| `resource.adopt` | Takes an existing `referenced` resource under management after a human ownership claim and a live read proving the claimed object exists. | 6 (never unattended) | the resource |
| `resource.release` | Hands an adopted resource back (`managed` to `referenced`). It never touches the object. This is the safe "decommission" of something Zenith did not create. | 6 (never unattended) | the resource |

Propose through `POST /api/platform/v1/capabilities/propose`. Inputs are strict and hold references only:

```jsonc
// data.export
{ "destination": { "resourceAddress": "object_store/backups", "credentialsRef": "vault:<projectId>/backups/credentials" },
  "connectionRef": "vault:<projectId>/db/connection-uri" }   // optional for services Zenith manages
// data.import (scope = the NEW target resource)
{ "exportId": "pex_...", "destination": { ... }, "connectionRef": "vault:...", "readbackConnectionRef": "vault:..." }
// resource.adopt
{ "claim": { "externalId": "<exact provider id>", "acknowledge": true, "lifecycle": "manage" | "manage_and_destroy", "fields": [ { "path": "zone", "owner": "provider-managed" } ] } }
// resource.release
{ "adoptionId": "ado_..." }
```

A person approves the exact proposal digest in the web app, then the person it was proposed for starts it
(`POST /api/platform/v1/operations/:id/start-portability`, browser only; an integration starts its own approved
operations through MCP `zenith_execute_approved_operation`). Read state with
`GET /api/platform/v1/environments/:id/portability`: verified exports, restores with their readback verdicts, and
adoption claims with live drift from their adoption baseline.

Credentials never travel in a proposal. `connectionRef` defaults to the generated reference the managed platform
keeps (`vault:generated/<environment>/<address>/connection-uri`). Storage credentials are one vault secret:
`{"region","bucket","accessKeyId","secretAccessKey","sessionToken"?,"endpoint"?}`.

## What is supported

| Kind | Export and import | Notes |
|---|---|---|
| Postgres (aws, gcp, azure, oci, zenith, kubernetes) | `postgres-logical-v1`: SQL over the system catalogs | tables, enums, sequences (definition and value, identity), column defaults and generated columns, primary key, unique, check and exclusion constraints, foreign keys, indexes, every row, exact for numeric, timestamptz, bytea, arrays, json. Views, materialized views, functions, triggers, extensions, row level security, partitioned or inherited tables and custom types other than enums are REFUSED, never dropped. |
| MySQL (aws, gcp, azure, oci, kubernetes) | `mysql-cli-v1`: stock `mysqldump` and `mysql` on the worker | tables, views, triggers. Routines and events are refused. A source that changes while it is dumped is refused. Evidence level `contract`: not run against a real server in this build. |
| Object storage (aws S3, gcp via S3 interoperability, oci via S3 compatibility, localstack) | `s3-objects-v1`: object for object through the S3 API | bodies and content type. User metadata, tags, versions, ACLs and lifecycle rules are not carried. Azure Blob has no S3 API: unsupported. The Zenith-managed object store is not provisioned yet: unsupported. |
| Volumes and PVCs | unsupported | A volume cannot be read without a workload that mounts it and Zenith has no data mover. Use the provider's snapshot (`database.snapshot` exists for managed databases) or a workload-level backup. Ownership, adoption and drift baseline still work. |
| Adoption and release | every real provider except `zenith` | The Zenith-managed platform creates its own resources; there is nothing to adopt. |

The full matrix, with the exact refusal sentence for each unsupported pair, is `src/lib/portability/matrix.ts`
(`supportTable()`); the broker refuses an unsupported or wrongly owned request before an operation exists.

## How a restore is proven

1. The export artifact (files plus `manifest.json`, written last) is read back from the tenant's storage and every
   file is re-hashed before the export is recorded. An export that was never read back does not exist.
2. The export's logical digest comes from the engine's readback function run against the SOURCE: structure and
   every row, order independent.
3. Import verifies the artifact against the manifest digest Zenith recorded (a rewritten artifact fails), refuses a
   target that holds anything, restores in one transaction (Postgres) and then recomputes the same logical digest
   from the TARGET through a fresh connection, optionally with a separate read-only credential.
4. A restore row is `verified` only when both digests are equal; the database derives the status itself and the
   row cannot be edited. A mismatch fails the operation and says to discard the target.

The artifact is plain files (SQL, one JSON array per row, or the object bodies) with a `RESTORE.md`: it is readable
and restorable without Zenith. It is not encrypted by Zenith: confidentiality is the destination bucket's.

## Ownership

- Adoption needs a human claim naming the exact provider object, a live, non-simulated read that finds that
  object, and the LIFE-12 field ownership registry: a claim may only confirm who owns each field (an autoscaled
  replica count stays the autoscaler's, a provider-chosen zone stays the provider's); contradictions are refused and
  a move needs an approved ownership transfer. The drift baseline records the IaC-owned fields at adoption.
- `lifecycle: manage` (the default) means Zenith will never delete the object. `manage_and_destroy` lets a later
  approved destroy delete it. A released or mismatched claim never does.
- Every path that can delete managed data (a deploy plan that deletes or replaces, teardown review, replan and
  apply) calls the decommission gate after the existing guards (`managed` node, explicit `deletionPolicy`, a
  digest-bound human approval) and refuses an adopted object whose claim does not allow destruction.

## Operating it

- Run the worker where it can reach the services. Connections to loopback, link-local, metadata and (by default)
  private addresses are refused; set `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1` only on a worker placed inside the
  tenant's network.
- MySQL needs `mysqldump` and `mysql` on the worker (`ZENITH_MYSQLDUMP_BIN`, `ZENITH_MYSQL_BIN` pin them).
- Limits: 128 MiB and 2,000,000 rows for a database, 5,000 objects, 64 MiB per object, held in memory. Over the
  limit is a refusal, never a partial export.
- The destination must be an `object_store` resource of the environment (managed or referenced, never external)
  whose bucket is the bucket in the credentials secret; exports are written only under
  `zenith-portability/<workspace>/<environment>/<operation>/`.
