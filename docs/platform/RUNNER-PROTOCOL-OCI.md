# Runner protocol extension — `oci.http` (OCI request-signing proxy)

**Status: IMPLEMENTED AND WIRED; NOT LIVE-VERIFIED.** This extends `zenith.runner/v1`
([RUNNER-PROTOCOL.md](RUNNER-PROTOCOL.md)) with one new job kind. Request validation,
principal loading, RSA signing, HTTP execution, bounded results and local audit
are implemented in `go/internal/oci/` and `go/internal/runner/kinds/ocihttp*.go`.
The TS vocabulary and payload schema include `oci.http`. Executor construction
and dispatch defaults are wired as described in §10. An operator must explicitly
enable and configure the local principal before the runner advertises the kind.
No live OCI tenancy has been exercised. The change is additive to the envelope,
heartbeat and result protocol.

Why a new kind and not `aws.http`: OCI does not use SigV4. Every request is
signed with OCI HTTP Signatures (draft-cavage-http-signatures-12, RSA-SHA256)
using a key that belongs to the caller's *principal*. In the `runner` mode of
ADR-0006 the principal is the runner's own **instance**, **resource** or **OKE
workload** principal, so no OCI key, fingerprint or security token ever exists
outside the customer's tenancy. The control plane serializes an *unsigned* OCI
REST request, exactly as it does for AWS, so the TypeScript resource drivers
are reused unchanged (ADR-0010).

## 1. Advertising

Registration `capabilities` gains `"oci.http"` (and `"tofu.run"` for OCI
workspaces, unchanged). Registration `labels` gain, all non-secret and set
from the runner's local configuration:

| label | example | meaning |
|---|---|---|
| `oci.auth` | `instance_principal` \| `resource_principal` \| `oke_workload_identity` | how the runner authenticates; the control plane passes the matching `auth` to the OCI provider block when it assembles a workspace |
| `oci.region` | `us-ashburn-1` | the region the runner's principal was issued in |
| `oci.tenancy` | `ocid1.tenancy.oc1..…` | the tenancy OCID the principal belongs to (an identifier, not a credential) |

The control plane refuses to bind an OCI connection to a runner whose
`oci.tenancy` differs from the connection's `tenancyOcid`.

The local configuration block is `kinds["oci.http"]`, with explicit
`enabled: true`, `auth`, `region`, `tenancy`, `allowedCompartments`, optional
`allowedRegions` (defaults to the configured region), `resourceCompartments`,
and optional byte limits (hard ceiling 1 MiB). Registration labels are derived
from this block; conflicting manually supplied labels are rejected. `auditPath`
defaults to `<stateDir>/oci-audit.jsonl`. `secretWrite: true` is refused.

`resourceCompartments` is an owner-maintained map from resource OCID to compartment
OCID. Named resources use `service:region:<percent-encoded primary resource path>`
keys, e.g. `objectstorage:us-ashburn-1:/n/my_namespace/b/my_bucket` or
`dns:us-ashburn-1:/20180115/zones/example.com`. Do not copy these bindings from
job assertions. Refresh them when a resource moves. Missing bindings are refused;
the runner never guesses compartment ownership from a resource OCID.

## 2. Job

Envelope as in RUNNER-PROTOCOL.md §4 with `"kind": "oci.http"`. Payload:

```json
{
  "service": "core",
  "region": "us-ashburn-1",
  "method": "GET",
  "path": "/20160918/subnets",
  "query": [["compartmentId", "ocid1.compartment.oc1..aaaa"]],
  "headers": {},
  "bodyB64": "<base64 of the exact body bytes; absent for no body>",
  "endpointHost": "<only for service queue-data>"
}
```

| field | rule |
|---|---|
| `service` | one of the logical ids in §5; **no host is ever sent** |
| `region` | `^[a-z]{2}-[a-z0-9-]{3,30}-\d$`; the runner may further restrict to `oci.allowedRegions` |
| `method` | `GET` `HEAD` `POST` `PUT` `DELETE` (receipt-scoped cleanup only; see §6) |
| `path` | absolute, percent-encoded, at most 2048 bytes; no empty segment, no segment that is `.` or `..` (after decoding), no encoded `/` or backslash, no `?`, `#`, backslash or control character. `..` *inside* a segment is legal: tenancy-scoped OCIDs look like `ocid1.compartment.oc1..aaaa` |
| `query` | ordered `[name, value]` pairs, sorted by name; at most 128 pairs, names 1–128 UTF-8 bytes, values at most 2048 bytes, no controls; order and repeated non-compartment keys are preserved with RFC 3986 escaping (`%20` for spaces) |
| `headers` | only `opc-retry-token`, `if-match`, `if-none-match`, `opc-request-id`; at most 256 UTF-8 bytes per value, no controls or case-insensitive duplicates; `Authorization`, `Host`, `Date`, `x-date`, `x-content-sha256`, `Content-Length`, `Content-Type`, `Signature`, `Cookie` and `Proxy-*` are **refused** (not stripped) |
| `bodyB64` | JSON body bytes, at most 1 MiB; never on `GET`/`HEAD` |
| `endpointHost` | only `queue-data`: the queue's `messagesEndpoint` host; must match `*.oraclecloud.com` |

The runner reports `Content-Type: application/json` and signs all content headers
for every POST/PUT, including an empty body. Bodies must be UTF-8 JSON and standard
canonical padded base64. Unknown fields, duplicate JSON members, null members and
trailing JSON documents are refused. Query and headers may be omitted and default
to empty. Paths must use the encoded ASCII wire form: literal spaces/non-ASCII,
invalid UTF-8 encodings and dot-only segments are refused too. `endpointHost`
must have valid lowercase DNS labels, no port, scheme, empty label or suffix spoof.

## 3. Runner verification, in order

Reject (`status: "rejected"`, with a reason) on the first failure:

1. every v1 check (signature, `typ`, runner id, `iat`/`exp`, `jti` replay, grant);
2. `oci.http` enabled in local configuration (`oci.enabled: true`);
3. payload schema, field rules above;
4. **host resolution**: `service` + `region` → host from the runner's own table (§5, or better the OCI Go SDK's endpoint resolution); the result must be `https://` and end in `.oraclecloud.com` (this covers `*.oci.oraclecloud.com` and `*.ocp.oraclecloud.com`). For `queue-data` the supplied `endpointHost` must match `^[a-z0-9.-]+\.oraclecloud\.com$` (a runner may additionally require `.queue.messaging.` in it; the exact endpoint shape is unverified);
5. **capability allowlist** (§6): `(service, method, path pattern)` must be in the allowlist of the job's `capability`;
6. **compartment binding**: every explicit `compartmentId` in query or nested body
   must be allowed; duplicate/case-variant query compartment selectors and
   `compartmentIdInSubtree` other than `false` are refused. Every resource OCID
   reference in path, query or body must have an allowed local binding. An allowed
   query compartment never proves an unbound path resource belongs to it. Collection
   reads require a compartment selector, resource calls require local bindings,
   and a PostgreSQL snapshot requires a bound `dbSystemId`. Named buckets/zones
   require the path bindings in §1. `/n` is the sole tenancy namespace metadata
   exception and still requires the principal's tenancy to match local config;
7. the HTTP client uses the shared DNS guard and dials the checked address, refusing
   metadata/link-local addresses and loopback even after DNS resolution. It uses
   TLS 1.2 or later, no ambient HTTP proxy, no redirects and a 16 KiB header cap.

All these checks finish in `Prepare` before principal lookup or any network call.
Resource bindings intentionally narrow the proposal: resource OCIDs do not encode
their owning compartment, so comparing resource IDs directly with compartment
OCIDs would either deny all resources or allow callers to forge the binding.

For Monitoring, `compartmentId` must be an allowed, unique URL query parameter;
placing it only in the JSON body cannot authorize `summarizeMetricsData`.
`compartmentIdInSubtree` must be absent or exactly `false`; duplicate selectors,
case variants and other URL parameters are refused. The JSON body has exactly
`namespace`, `query`, `resolution`, `startTime` and `endTime`. Only namespace
`oci_computeagent` and this byte-exact query shape are accepted:

```
<CpuUtilization|MemoryUtilization>[<1m|5m|1h|1d>]{resourceId = "<instanceOCID>"}.mean()
```

`resolution` must equal the query interval. Both timestamps must be RFC 3339,
with `endTime` after `startTime`. The instance OCID must have a trusted local
`resourceCompartments` binding to the **exact URL compartment**, even if several
compartments are allowed. Other namespaces, metrics, aggregations, dimensions,
fields, unbound/foreign instances and query-language injection are refused.
Logging Search instead selects scope inside the JSON `searchQuery`. The runner
accepts the minimal query `search "<compartmentOCID>[/<logGroupOCID>[/<logOCID>]]"`:
one explicit compartment from local `allowedCompartments`, with every optional
log-group/log OCID locally bound to that same compartment. The sole accepted
suffix is exactly ` | sort by datetime desc`, as emitted by the TS log reader.
Whitespace is not normalized: double spaces, altered sorting, another pipe,
trailing text and controls are refused. Names, wildcards, multiple scopes,
other pipelines and comments are refused rather than interpreted.
Only `limit` and `page` URL parameters are accepted for Logging Search. A caller's
URL/body `compartmentId` assertion never authorizes a foreign search scope.
This is a deliberately limited subset of Oracle's
[Logging Query Language](https://docs.oracle.com/en-us/iaas/Content/Logging/Reference/query_language_specification.htm).

## 4. Signing

The runner uses standard-library RSA PKCS#1 v1.5 with SHA-256 and the wire rules
in [Oracle's signing reference](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm).
No OCI SDK dependency was added: the Go module has no dependencies and this
workstream forbids dependency changes. Signed headers: `(request-target) host date`,
plus `x-content-sha256 content-type content-length` for POST/PUT, even without a
body. `keyId` is `ST$<security token>`. A Node-crypto-generated synthetic RSA
vector in `go/internal/oci/testdata/signing-vector.json` independently checks GET,
DELETE signer behavior, non-ASCII JSON byte lengths and empty PUT. General DELETE is still
always refused at the request boundary. Oracle's example does not contain a
complete expected signature, so it is not claimed as a published signature vector.

Principals are available only inside an in-memory provider callback:

- Instance: fixed IMDSv2 `/opc/v2/instance/region` and `/identity/{cert.pem,key.pem,intermediate.pem}`
  with `Bearer Oracle`; tenancy comes from the leaf certificate's `opc-tenant:`
  subject attribute. Region, tenancy, certificate expiry and key pair are checked.
  A fresh 2048-bit session key is federated at
  `https://auth.<region>.oraclecloud.com/v1/x509`, signed by the leaf key using
  `<tenancy>/fed-x509-sha256/<SHA256 certificate fingerprint>`. The session key and
  token refresh atomically in memory before expiry. Federation signs
  `date (request-target) content-length content-type x-content-sha256` as the OCI
  auth endpoint expects, independently of the service signing header set.
- Resource v2.2: reads only `OCI_RESOURCE_PRINCIPAL_VERSION`, `_REGION`, `_RPST`,
  `_PRIVATE_PEM`, `_PRIVATE_PEM_PASSPHRASE`. Token/key must both be inline or both
  absolute file paths. Platform-managed files are re-read for rotation. RSA
  PKCS#1/PKCS#8 and legacy password-encrypted PEM are supported; encrypted PKCS#8
  is refused. No key is written by the runner.
- OKE: local service-account token/string/path and cluster CA; fixed TLS proxymux
  `https://<KUBERNETES_SERVICE_HOST>:12250/resourcePrincipalSessionTokens`, request
  `{ "podKey": "<session public PEM>" }`, Bearer service-account authorization.
  The JSON/base64 response supplies `ST$` plus the token. The configured CA is
  required and TLS verification is never disabled. Versions 1.1/2.2 are accepted
  for this exchange. `OCI_KUBERNETES_SERVICE_ACCOUNT_CERT_PATH`, `_TOKEN_PATH`,
  `_TOKEN_STRING` override the standard in-cluster file paths/material.

Tokens are decoded for tenancy (`tenant` / `opc-tenant` on instance tokens,
`res_tenant` on resource/OKE tokens) and expiry binding; their signatures are
verified by OCI on the signed service request, not by a local JWT verifier.
They must be valid for more than one minute. Provider/network/read errors are
fixed messages and never include source material or external error text. These
handshakes follow the [instance reference](https://github.com/oracle/oci-go-sdk/blob/master/common/auth/instance_principal_key_provider.go),
[federation reference](https://github.com/oracle/oci-go-sdk/blob/master/common/auth/federation_client.go),
[resource reference](https://github.com/oracle/oci-go-sdk/blob/master/common/auth/resource_principal_key_provider.go)
and [OKE reference](https://github.com/oracle/oci-go-sdk/blob/master/common/auth/federation_client_oke_workload_identity.go).
Tests use synthetic credentials, fake handshakes and a local `httptest` OCI endpoint;
these are not live OCI verification.

`tofu.run` on OCI additionally requires, in the runner (not in this extension):
(a) the OCI provider block `auth` is taken from `oci.auth` (the control plane
passes `providerConfig: { oci: { auth } }` when assembling — `auth` is not
credential-shaped, so the assembler accepts it); (b) with resource or OKE
workload principals the platform injects `OCI_RESOURCE_PRINCIPAL_*` /
workload-identity variables into the runner process, and the runner must
allowlist exactly those names into the OpenTofu child environment and nothing
else.

## 5. Service table

The runner owns this table; the TypeScript mirror is `OCI_SERVICE_HOSTS` in
`src/lib/providers/oci/services.ts`. **It follows the OCI SDK endpoint
conventions and has NOT been exercised against a tenancy**; prefer the SDK's own
endpoint resolution over copying it.

| service id | host | API version |
|---|---|---|
| `core` | `iaas.{region}.oraclecloud.com` | `20160918` |
| `loadbalancer` | `iaas.{region}.oraclecloud.com` | `20170115` |
| `certificates` | `certificates.{region}.oci.oraclecloud.com` | `20210224` |
| `dns` | `dns.{region}.oraclecloud.com` | `20180115` |
| `containerinstances` | `compute-containers.{region}.oci.oraclecloud.com` | `20210415` |
| `artifacts` | `artifacts.{region}.oci.oraclecloud.com` | `20160918` |
| `postgresql` | `postgresql.{region}.oci.oraclecloud.com` | `20220915` |
| `objectstorage` | `objectstorage.{region}.oraclecloud.com` | (none) |
| `queue` | `messaging.{region}.oci.oraclecloud.com` | `20210201` |
| `queue-data` | the queue's `messagesEndpoint` | `20210201` |
| `vault` | `vaults.{region}.oci.oraclecloud.com` | `20180608` |
| `identity` | `identity.{region}.oci.oraclecloud.com` | `20160918` |
| `logging` | `logging.{region}.oci.oraclecloud.com` | `20200531` |
| `loggingsearch` | `logging.{region}.oci.oraclecloud.com` | `20190909` |
| `monitoring` | `telemetry.{region}.oraclecloud.com` | `20180401` |
| `redis` | `redis.{region}.oci.oraclecloud.com` | `20220315` |
| `containerengine` | `containerengine.{region}.oraclecloud.com` | `20180222` |

## 6. Per-capability method + path allowlist

`{}` matches exactly one non-empty segment; there is no other wildcard. This is
`OCI_ALLOWLIST` in `src/lib/providers/oci/allowlist.ts`, generated from what the
drivers call and checked by a test that replays every driver call against it.

**`infrastructure.observe`, `topology.read`, `incident.investigate`** — read only
(observe / runtime / verify / discover):

```
core GET /20160918/vcns
core GET /20160918/vcns/{}
core GET /20160918/subnets
core GET /20160918/subnets/{}
core GET /20160918/internetGateways
core GET /20160918/natGateways
core GET /20160918/networkSecurityGroups
core GET /20160918/networkSecurityGroups/{}/securityRules
core GET /20160918/volumes
core GET /20160918/volumes/{}
loadbalancer GET /20170115/loadBalancers
loadbalancer GET /20170115/loadBalancers/{}
loadbalancer GET /20170115/loadBalancers/{}/health
loadbalancer GET /20170115/loadBalancers/{}/backendSets/{}/health
certificates GET /20210224/certificates
certificates GET /20210224/certificates/{}
dns GET /20180115/zones
dns GET /20180115/zones/{}
dns GET /20180115/zones/{}/records/{}/{}
containerinstances GET /20210415/containerInstances
containerinstances GET /20210415/containerInstances/{}
containerinstances GET /20210415/containers/{}
artifacts GET /20160918/container/repositories
artifacts GET /20160918/container/repositories/{}
postgresql GET /20220915/dbSystems
postgresql GET /20220915/dbSystems/{}
objectstorage GET /n
objectstorage GET /n/{}/b
objectstorage GET /n/{}/b/{}
queue GET /20210201/queues
queue GET /20210201/queues/{}
queue-data GET /20210201/queues/{}/stats
vault GET /20180608/secrets
vault GET /20180608/secrets/{}
identity GET /20160918/dynamicGroups
identity GET /20160918/dynamicGroups/{}
identity GET /20160918/policies
logging GET /20200531/logGroups
logging GET /20200531/logGroups/{}
logging GET /20200531/logGroups/{}/logs
redis GET /20220315/redisClusters
redis GET /20220315/redisClusters/{}
```

**Signal reads:** `infrastructure.observe` and `incident.investigate`
additionally allow both fixed read-only POST queries below. `logs.read` allows
only Logging Search; `metrics.read` allows only Monitoring, without metadata
GETs. `topology.read`, `firewall.inspect` and every mutating capability gain no
signal POST access:

```
loggingsearch POST /20190909/search
monitoring POST /20180401/metrics/actions/summarizeMetricsData
```

These are the exact methods/paths in Oracle's
[SearchLogs API reference](https://docs.oracle.com/en-us/iaas/api/#/en/logging-search/20190909/SearchResult/SearchLogs)
and [SummarizeMetricsData API reference](https://docs.oracle.com/en-us/iaas/api/#/en/monitoring/20180401/MetricData/SummarizeMetricsData),
cross-checked against the [Oracle Logging Search client](https://github.com/oracle/oci-dotnet-sdk/blob/master/Loggingsearch/LogSearchClient.cs)
and [Oracle Monitoring client](https://github.com/oracle/oci-go-sdk/blob/master/monitoring/monitoring_client.go).
Monitoring uses the read endpoint `telemetry`, never `telemetry-ingestion`.
No log ingestion, metric publication, alarm mutation or broader path wildcard is
allowed. The embedded contracts contain 9 capabilities and 18 services;
`infrastructure.observe` and `incident.investigate` each have 52 rules,
`topology.read` retains 50 driver-read rules, and `logs.read` / `metrics.read`
each have one signal rule. Regenerate both golden
files with `npx tsx scripts/generate-oci-allowlist.ts`; TS/Go parity is tested.

The Go executor exempts exactly these two read POSTs from its retry-token
requirement (`go/internal/runner/kinds/ocihttp.go`, `readOnlyPost`); other POSTs
still require a token. The control-plane payload schema currently requires
`opc-retry-token` on every POST, so the TS readers supply it. Neither signal
POST is automatically retried by the current executor (§8). Offline reader
tests exercise the production tables, runner serialization and payload schema
with synthetic responses; this does not establish live tenancy access.

**`firewall.inspect`**

```
core GET /20160918/networkSecurityGroups
core GET /20160918/networkSecurityGroups/{}/securityRules
```

**`service.restart`** (container instances; one POST per instance, `opc-retry-token` required)

```
containerinstances GET /20210415/containerInstances
containerinstances POST /20210415/containerInstances/{}/actions/restart
```

**`database.snapshot`** (PostgreSQL manual backup; `opc-retry-token` required)

```
postgresql GET /20220915/dbSystems
postgresql GET /20220915/dbSystems/{}
postgresql POST /20220915/backups
```

**`secret.write`** (Vault secret value; see §7)

```
vault GET /20180608/secrets
vault GET /20180608/secrets/{}
vault PUT /20180608/secrets/{}
```

**`deployment.deploy`** (manifest image verification and one-off migrations)

```
containerinstances GET /20210415/containerInstances
containerinstances GET /20210415/containerInstances/{}
containerinstances GET /20210415/containers/{}
core GET /20160918/vnics/{}
containerinstances POST /20210415/containerInstances
containerinstances DELETE /20210415/containerInstances/{}
```

The sole added write creates a migration instance with `opc-retry-token` and
`containerRestartPolicy: NEVER`. It uses the owning workload's private subnet,
NSGs, manifest environment and Vault OCID pointers. The command is an argv
vector, never a shell string. Workspace/environment/resource/managed tags are
checked together with the compartment; `zenith_release` identifies the one-off
execution and excludes it from workload replica reads, discovery and restart.
Recovery checks that tag, the image, argv and an observed exit code; absent,
duplicate, truncated or unreadable execution state is unknown. The timeout
includes launch, API reads and polling (at most 30 minutes).

OCI's [UpdateContainerDetails API](https://docs.oracle.com/en-us/iaas/tools/go/latest/containerinstances/index.html#UpdateContainerDetails)
accepts names/tags, not an image change. The workload port verifies the digest
already applied by the reviewed OpenTofu replacement, and waits for every
expected instance and container to be ACTIVE. It rejects a different image
instead of inventing an unsupported PUT or bypassing load-balancer/state
ownership. Mutable tags are refused. No release write is granted to observe,
restart or rollback capabilities.

Raw container logs are fully suppressed; only a fixed exit-code summary reaches
the driver log. The current runner persists raw HTTP result bodies, so adding a
logs endpoint would expose log contents before TypeScript could redact them.
No log retrieval rule is added. Finished migrations request cleanup, including
nonzero exits; running, timed-out and unproven instances are not deleted.

The optional `migrationKey` is exactly 48 lowercase hexadecimal characters. It is
a runner-local receipt selector, never sent to OCI. Its namespace is the verified
signed workspace plus operation plus key, independently of the per-RPC JTI.
Collection GET with that key and the exact compartment returns only safe receipt
state (`absent`, `unknown`, `running`, `completed`), instance ID, terminal exit and
cleanup state. The runner durably appends and fsyncs create intents before POST
and owned terminal exits before DELETE to `<auditPath>.oci-receipts`. Preserve
this dedicated journal and route retries to the same runner; no retention or
pruning policy is introduced. An incomplete intent stays unknown and cannot
launch again. A completed receipt survives deletion and runner restart.

DELETE requires a receipt created by this runner for the exact signed workspace,
operation, region and migration key, with an observed INACTIVE owned container
and integer exit 0..255 matching its launch image and argv. Tags, local static
bindings and caller completion assertions never authorize DELETE. The runner
rechecks the receipt at execution. Cleanup errors preserve the observed exit and
report unknown cleanup; HTTP acceptance means only cleanup requested, not
verified deletion completion. Repeated accepted cleanup does not resend DELETE.

By-id reads still need trusted local `resourceCompartments` bindings for every
instance, container and VNIC, and launch-body pointers (subnet, NSGs, Vault
secrets). The runner validates OCI create response ID types, exact requested
compartment and container references before establishing trusted bindings for
new migration instance/container IDs. Foreign, malformed, conflicting or truncated
responses cannot establish bindings or deletion rights. Runtime binding/receipt
state is synchronized; synthetic Go tests exercise creation, polling and cleanup.
Likewise, the existing workload resource-principal policy must actually match
the migration's workload tags; customer IAM/defined-tag setup is unverified.
These release paths have contract evidence only, not live OCI acceptance.

**Never allowed for any capability**, by absence from every list: secret-bundle
retrieval (`/20190301/secretbundles/…`: Zenith and the runner never read a
secret value back), object-level Object Storage (`/n/{ns}/b/{bucket}/o/…`:
customer data), any IAM write, `…/actions/changeCompartment`, secret deletion,
and general resource `DELETE`. Infrastructure changes go through `tofu.run`; exact
migration creation and receipt-authorized terminal cleanup above are the release exceptions. Signal reads use the capability split above: `logs.read` permits only
Logging Search, `metrics.read` only Monitoring, and `incident.investigate`
both signal queries plus driver metadata reads.

## 7. Secret writes carry a secret

`secret.write` is the one call whose body contains a secret value (the new
Vault secret content). Until the following exists, OCI `secret.write` MUST
stay disabled (`oci.secretWrite: false` in the runner's local config, the
default):

1. the control plane creates such a job with the body **sealed** to a
   runner-registered X25519 key (a new optional registration field
   `encryptionPublicKey`, separate from the Ed25519 identity key) in
   `sealedBodyB64`, which replaces `bodyB64`;
2. the plaintext never reaches the job row, the outbox, a log or an event; the
   job payload of this capability is stored encrypted or not at all;
3. the runner decrypts in memory, signs, sends, and zeroes the buffer;
4. the result never echoes the body, and OCI's error `message` is not returned
   (the TypeScript helper passes `redactMessage`), only `status` and the
   allowlisted headers;
5. idempotency: the new version is named from the operation id, so a retried
   job gets a conflict the driver treats as "already applied".

## 8. Result

```json
{ "status": "succeeded", "result": { "status": 200, "headers": { "opc-request-id": "…", "opc-next-page": "…" }, "bodyB64": "…", "truncated": false } }
```

Response headers are allowlisted to `opc-request-id`, `opc-next-page`,
`opc-work-request-id`, `etag`, `retry-after`, `content-type`. The body is capped
by the envelope's `maxOutputBytes` and the local response limit (default/hard cap
1 MiB); header values are bounded to 2000 bytes and credential-shaped header
strings are redacted using the runner's shared redactor. A truncated body is reported
with `truncated: true` and the control plane refuses to parse it.

An OCI error (`4xx`, `5xx`) is a **succeeded** job carrying that status: the
transport worked and the drivers classify the answer (`404`
`NotAuthorizedOrNotFound` is ambiguous by design; the drivers never conclude
"missing" from it alone). A refusal by the runner (§3) is `rejected`.

The runner retries `GET`/`HEAD` on `429`/`5xx` with jittered backoff, honouring
`retry-after` seconds or HTTP date, at most 3 retries (4 total attempts) within
the job timeout. An excessive delay waits for the job timeout. It never retries a
`POST`/`PUT`.

## 9. Audit

One line per HTTP attempt in the runner's local JSONL audit log: job id, capability,
service, method, the path **template** (OCIDs replaced by `{}`), status,
`opc-request-id`, and whether the body was sealed. Never a body, never a query
value that is a secret. Records contain only the trusted path template, never
wildcard resource names. Audit creation uses mode 0600 and appends are serialized
and synced. An audit failure fails the job with a fixed error, possibly after a
request took effect; the result retains any known HTTP status. The control plane
log stream is not used for these audit records.

## 10. Integration status and remaining limits

`src/lib/runners/dispatch.ts` includes `oci.http` in `KIND_DEFAULTS` with a
60-second timeout, 1 MiB output and 120-second queue TTL. The opt-in construction
in `go/internal/runner/executor.go` calls `kinds.NewOCI` and advertises the kind
only when configured with `enabled: true`. `go/internal/runner/config.go`
validates it and binds the registration labels to local tenancy/region/auth.
These are source-verified wiring claims, not a live OCI run. See the runnable
configuration in [RUNNER.md](RUNNER.md#ocihttp--the-oci-signing-proxy).

- The service table and API paths remain unverified against a live tenancy.
- Logging Search and Monitoring method/path contracts and compartment checks
  are implemented and covered by synthetic tests. Logging query syntax is
  limited to the single OCID scope described in §3. The Go executor's exact
  read-only POST exemption is implemented (§6); current TypeScript readers
  still supply retry tokens to satisfy the payload schema. Observability source
  adapters in `src/lib/observability/sources/oci-{logging,monitoring}.ts` are
  wired through runner sessions. No live service acceptance is established.
- `secret.write` remains disabled (`oci.secretWrite: false`): `sealedBodyB64`
  is the required sensitive-payload contract, not implemented sealed-body
  transport. Logging Search and Monitoring reads are implemented through
  runner-backed sessions; neither query is a secret-write transport.
- `src/lib/platform/credentials.ts` creates OCI platform sessions only through
  an active registered runner. Verification checks runner registration/labels,
  not OCI permissions; platform deploy/observe sessions remain unverified live.
- The state assembler now emits OCI S3-compatible endpoint/compatibility flags
  (`src/lib/tofu/backends.ts`, `src/lib/tofu/backend-config.ts`). Authentication
  still requires a customer S3 secret key kept on the runner; native principals
  cannot authenticate the S3 backend. No live state locking/restore is verified.
- Resource/OKE credentials for a `tofu.run` child need a separately verified Go
  child-environment allowlist; this HTTP extension launches no child process.
- An observe-only identity needs customer IAM limited to reads and local
  compartment/region bindings. The built-in capability method/path allowlist
  does not substitute for customer IAM or a verified connection.
