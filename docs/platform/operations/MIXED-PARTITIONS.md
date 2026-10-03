# Mixed-provider logical partition contracts

Written against branch `ws/prod-default-accepted-20261003`, based on reviewed partition guide source at `3755d4d8eae0b3f6b681dfd5a33c6eeac4694d31` (2026-10-03). This metadata refresh is source-only; mixed-provider execution and live acceptance remain unverified. The [logical planner](../../../src/lib/execution/mixed-partitions.ts) retains the execution refusal described below.

`src/lib/execution/mixed-partitions.ts` prepares bounded logical planning data
for PROD-MIX-01 through PROD-MIX-04. It does not replace the current
`findGraphProblems()` multi-provider execution refusal. Every result has
`executionEnabled: false`. There is no SDK call, credential acquisition, child
workflow dispatch, state migration, receipt verification or destructive
compensation in this module. The production ledger's mixed-provider acceptance
requires separate runtime, live sandbox and operational evidence.

## Inputs and explicit bindings

`planMixedPartitions()` accepts the existing `ResourceGraph`, a workspace id,
explicit `PartitionBinding` records, one assignment for every address, and an
explicit cross-partition reference inventory. A binding carries an existing
`ProviderConnection` snapshot, account/project/subscription/tenancy identity,
region, existing `BackendConfig` and an explicit state key. There are no
caller-approved flags. A snapshot's `verified` status is an input consistency
check; it proves neither current authorization nor current cloud ownership.
The production caller must eventually obtain these bindings from the current
canonical authority path and recheck them when each child acts.

The bounded cloud profiles are AWS, GCP, Azure and OCI. Other `ProviderKey`
values refuse rather than selecting a fallback connection or state store.
Workspace, connection provider, account and region must agree. AWS observe and
deploy role selectors must name the same account and AWS partition. GCP's
user-managed observe/deploy service accounts must be in the selected project;
cross-project delegation needs a future explicit authority contract. Azure
pins tenant/client identity as well as the subscription. OCI pins tenancy,
compartment and runner identity. Project-number-to-project-id correspondence,
Azure tenant-to-subscription ownership, OCI namespace-to-tenancy ownership and
actual IAM grants still require trusted provider verification.
AWS selector digests also pin optional build/secret-writer roles, boundary,
bootstrap naming, session duration and an opaque ExternalId digest. They cannot
be changed silently while retaining the same desired candidate. Source/build
transport bindings such as Azure `sourceStorage` must be independently pinned
by the future child artifact contract; they are not copied into this identity.
Contradictory account/region-bearing AWS ARNs, GCP project resource paths and
Azure subscription resource ids also refuse. Unqualified names and resource
OCIDs do not prove account ownership; their actual provider evidence is still
required before execution.

Backend arguments pass the existing `backendFile()` non-secret allowlist.
AWS/GCP state buckets, Azure storage account/container and OCI namespace/bucket
must match the connection snapshot. Configured AWS/GCP state encryption cannot
be silently removed. Region overrides that disagree with the binding refuse.
State keys must be explicit and remain under `zenith/<workspace>/<environment>`.
The existing `backendForConnection()` profile, including GCS's exact environment
prefix and `default.tfstate` object, is accepted without inventing a new key.
The effective GCS prefix, including a `stateKey` fallback, must have canonical
path segments: standalone `.` segments refuse alongside the existing traversal
and empty-segment guards. The pinned
[OpenTofu 1.12.5 GCS backend](https://github.com/opentofu/opentofu/blob/v1.12.5/internal/backend/remote-state/gcs/backend_state.go#L145-L150)
uses `path.Join` for state and lock objects, so accepting raw dot-segment
spellings would let distinct location digests describe the same objects.
OCI's saved `stateNamespace` must itself be a nonempty string matching
`^[a-z0-9]{1,63}$` before endpoint assembly; missing or nonstring selectors
cannot become routing namespaces through string interpolation. This matches
the canonical connection backend helper's namespace boundary and does not
establish namespace-to-tenancy ownership.
An intentional partition key change is a reviewed migration candidate.
Local/file and HTTP state profiles are outside these cloud ownership contracts.

Distinct partitions cannot overlap any effective state or lock object, even
when connection ids, account selectors, encryption settings or an ignored GCS
state key differ. Backend digests pin complete validated non-secret settings;
`stateLocationDigest` pins the effective state object, and sorted, deduplicated
`backendObjectDigests` pins the union of state and lock objects. These digests
enter the immutable partition identity and its parent/subplan inputs. Every
binding contributes at most two physical objects. A shared state/lease object
within one binding is deduplicated before comparing distinct bindings.

The effective object set follows the committed backend profile and the exact
pinned OpenTofu 1.12.5 implementation:

| Backend | Effective state | Effective lock |
| --- | --- | --- |
| AWS/OCI S3 profile | Literal `stateKey` | Literal `stateKey` followed by `.tflock` |
| GCS | Canonical prefix followed by `/default.tfstate` | Canonical prefix followed by `/default.tflock` |
| Azure | Literal key in the selected account/container | Lease and lock metadata on that same state blob |

The canonical S3 backend always emits `use_lockfile: true`. Its pinned
[lock object implementation](https://github.com/opentofu/opentofu/blob/v1.12.5/internal/backend/remote-state/s3/client.go#L568-L570)
appends the suffix without path normalization, so a second partition's
`child.tfstate.tflock` state would overwrite the first partition's lock. The
planner refuses that overlap in either binding order. A single binding may use
a literal state name already ending in `.tflock`; its own derived lock then has
a second suffix. Literal S3 dot segments remain distinct object spellings.
The pinned
[GCS object names](https://github.com/opentofu/opentofu/blob/v1.12.5/internal/backend/remote-state/gcs/backend_state.go#L145-L150)
use separate state/lock suffixes on the default workspace name. The pinned
[Azure lock implementation](https://github.com/opentofu/opentofu/blob/v1.12.5/internal/backend/remote-state/azure/client.go#L114-L182)
leases the state blob; it does not manufacture an S3-style sibling lock.
Both derived object names must also pass the existing canonical key bound of
1024 safe ASCII bytes. This includes the suffix: the S3 state key has at most
1017 bytes, and a GCS prefix has at most 1008 bytes for its default state name.

Physical namespaces include the backend family, bucket or storage
account/container, and OCI's exact canonical endpoint. AWS also pins the
supported role partition (`aws`, `aws-cn`, `aws-us-gov`):
[AWS bucket namespaces](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html)
are distinct across partitions. Account and connection ids are not substitutes
for a physical namespace: two inconsistent snapshots that claim the same bucket
under different accounts must still refuse an overlap. Role selectors and
account consistency remain separately checked; no bucket ownership is inferred
from a caller snapshot. The existing role/parser profile does not add support
for other AWS partitions. Identical key spellings in different backend families
or distinct canonical OCI endpoints remain distinct logical locations.

Connection identity digests select only non-secret authority selectors. They
omit credential bytes, credential references, local paths, verification detail
and arbitrary connection configuration. Backend arguments, object keys and role
strings are not returned. The new footprint is planning metadata, not proof of
live IAM, locking, object ownership or authenticated child execution.

## Addresses, dependencies and immutable candidates

The planner validates every node's existing `specDigest` and the canonical
sorted graph's `graphDigest`. Duplicate addresses/assignments, absent or unused
bindings, missing dependency nodes and provider/native-type mismatches refuse.
All original addresses and ownership modes remain intact. `sourceNodeDigest`
pins the original spec, origin, labels and external identity, including any
existing field ownership metadata. The planner does not rewrite those fields,
rename resources, flatten provider-native configuration or generate OpenTofu
addresses. Resumption needs the original immutable graph artifact, not a graph
recreated from the reduced metadata output.

Dependencies are the union of `ResourceNode.dependsOn` and explicit
`depends_on` edges, directed from consumer to producer. Incident/traffic edges
retain their meaning and do not manufacture ordering. Both the resource DAG
and the partition DAG must be acyclic: an acyclic resource graph can still
induce a cycle when multiple resources share partitions. Ties use UTF-16 lexical
order; teardown metadata is the reverse dependency order. That order does not
authorize deletion of managed, referenced or external resources.

The existing compiler can discover `ctx.ref()` calls absent from `dependsOn`.
Before execution integration, its complete discovered reference inventory must
be reconciled with these declarations; an undeclared cross-partition reference
must refuse. This helper checks declarations and cross-partition graph relations
but cannot discover a reference hidden in a driver's executable code. Existing
single-workspace reciprocal compiler references remain outside this cross-child
ordering contract.

All identities use the control plane's canonical JSON SHA-256 rule:

| Identity | Immutable inputs |
| --- | --- |
| Partition id | Binding id, exact workspace/environment/connection/provider/account/region, selected connection identity and backend/state/lock object digests |
| Child `subplanDigest` | Binding identity, original node identities, partition dependencies, declared incoming/outgoing typed contracts and internal edge digests |
| Child `effectDigest` | Child subplan and exact incoming materialization/custody digests |
| Parent `desiredDigest` | Workspace/environment, manifest/graph digests, child subplans, typed contract digests and dependency order |
| Parent `parentDigest` | Desired digest, exact child effects and materialization/custody metadata |

Materialization does not change the desired child or parent identities. It does
change the candidate effects and parent digest. Outputs are detached snapshots
and deeply frozen. `classifyMixedPlanChange()` accepts only candidates returned
by this module instance, preventing a caller from supplying invented digest
metadata. Reconstruct serialized historical candidates from their exact trusted
input artifacts with `planMixedPartitions()` before comparing them; a future
durable codec must independently verify those artifacts.

## Typed outputs, custody and secrets

Each declaration names a producer address/output and a managed consumer
address/input, with matching `string`, `number`, `boolean`, `resource_id`,
`endpoint` or `secret_ref` types and exact workspace/environment scope. Input
names identify compiler contract fields and do not direct a spec overwrite.
Consumers must declare a direct ordering dependency on producers. One consumer
field has one producer. A producer field has one type and one consistent
materialization across all consumers. External documentation nodes cannot
produce outputs. Cross-partition incident/data relations require a declaration;
`reads_secret` additionally requires a correctly directed secret contract.

An unavailable output records a closed reason: not produced, partial failure,
timeout, expiry, cancellation, outage or unverified custody. It remains unknown;
the consumer and downstream dependent partitions list the blocking reference.
An available output supplies a value digest and exact producer workspace,
environment, connection, provider, account, region, address, spec digest,
subplan digest, **current effect digest**, completed-receipt digest and artifact
digest. A stale producer effect or unresolved producer dependency refuses.
Matching strings establish metadata consistency only. The future trusted custody
loader must verify independently observed terminal completion, artifact bytes,
typed values, expiry and authorization before constructing these inputs.

There is no raw output value field. A secret carries only a bounded three-part
vault reference, immutable version digest and exact consumer connection scope.
Its `valueDigest` must hash `{ref, versionDigest}`, never the secret value.
Neither the reference path nor any secret value is returned by the planner.
Actual vault project/service ownership and delivery grants must be checked by
the secret custody/broker integration. Unknown materialization keys and raw
output payloads refuse. Desired-spec tripwires additionally reject credential
field values, secret environment values, credentials embedded in URLs and
private key blocks. These tripwires cannot prove that an arbitrary unlabeled
string is non-secret; the existing validated manifest/graph and trusted custody
boundaries remain necessary. Errors use fixed codes/messages and echo no input.

## Reapproval and distributed failure

`classifyMixedPlanChange()` returns `unchanged` or `review_required`, exact new
parent digest, affected partition ids and blocked partitions. Changed scope,
desired inputs, newly materialized effects, output replacement, receipt/artifact
custody, binding, backend, ownership or topology require review. Affected
partitions include downstream dependants even before they can materialize.
There is no wildcard preapproval or caller boolean exemption. A future precise
preauthorization mechanism must be a canonical consumed approval bound to exact
parent/child/effect constraints and current policy, never an option on this API.
Even `unchanged` does not replace fresh broker authorization.

Partial child success does not roll back another cloud. The module only keeps
unknown dependencies blocked and supplies teardown order. Cancellation,
uncertainty, outage, TTL expiry, drift and state migration require separate
durable child receipts, current fencing and explicit human recovery/teardown
authorization. No automatic destructive compensation exists here.

## Bounds and remaining integration

Fixed limits are 256 nodes/assignments/notes, 1024 edges, 32 bindings/partitions,
512 references, JSON depth 20 (root depth zero), 65536 JSON values (including
containers), 1 MiB of UTF-8 string/key content and 16 KiB per string. Plain finite
JSON is required; proxies, getters, custom prototypes, sparse/decorated arrays, symbols,
undefined, non-finite numbers and cycles refuse. Limits apply before planning
or canonical hashing. The focused tests include each exact limit and overflow.

Required work outside this module's three owned paths remains:

1. Integrate complete compiler reference discovery, immutable graph/subplan
   custody and canonical current parent/child broker authorization.
2. Add durable dependency-ordered child workflows, receipt recovery, cancellation,
   expiry and partial-success handling with safe explicit teardown.
3. Verify output artifacts and terminal completion independently; retain secret
   scope/versions while delivering values solely inside authorized workers.
4. Implement typed networking, CIDR overlap refusal, protected cross-cloud
   connectivity, residency/cost policy and real traffic. An `endpoint` type
   here proves no reachability and never authorizes a public database.
5. Extend strict required gates and collect local-engine, live-sandbox and
   operational rehearsal evidence before changing `graph.ts` or ledger status.

The GCP compute / Azure Postgres / AWS functions test is a logical application
fixture, with provider-native vocabulary from the existing graph builder. It
does not establish deployed resources, protected networking, traffic, cloud
permissions or PROD-MIX acceptance. Source and tests require independent review
and runtime verification before integration.

Identity formats were checked against primary documentation on 2026-10-03:
[AWS IAM identifiers](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html),
[Google service accounts](https://docs.cloud.google.com/iam/docs/service-accounts-create),
[Google federation provider resource names](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes),
[Microsoft workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity),
and [OCI S3 compatibility](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm).
Those references describe provider identity formats; they are not runtime
verification of Zenith's connection or backend ownership.

## Revision 3 source boundary

Revision 3 corrects cross-binding state/lock-object overlap and keeps revisions
1/2 source receipts intact. Prepared regressions cover AWS and OCI suffix
collisions in both orders, each binding's own lock group, metadata/account/region
changes that cannot hide a collision, supported AWS partition and OCI endpoint
separation, cross-family object spellings, GCS's exact default lock name, Azure's
same-blob lease, literal S3 dot segments, scoped keys and derived-name bounds.
The refusal helper uses a function declaration for TypeScript control-flow
narrowing; no runtime verification is claimed from that source correction.

Compiler, tests, lint, database/cloud and live locking checks are unrun in this
author lane. Independent source review and root-owned fresh targeted/full gate
receipts remain required. Existing graph/compiler refusal and the production
ledger remain unchanged. Current broker authorization, complete driver reference
reconciliation, child workflow dispatch, typed networking, artifact custody and
independently verified completion remain future execution prerequisites.
