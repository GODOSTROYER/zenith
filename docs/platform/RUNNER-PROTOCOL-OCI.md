# Runner protocol extension — `oci.http` (OCI request-signing proxy)

**Status: IMPLEMENTED MODULE; INTEGRATION PENDING.** This extends `zenith.runner/v1`
([RUNNER-PROTOCOL.md](RUNNER-PROTOCOL.md)) with one new job kind. Request validation,
principal loading, RSA signing, HTTP execution, bounded results and local audit
are implemented in `go/internal/oci/` and `go/internal/runner/kinds/ocihttp*.go`.
The TS vocabulary and payload schema include `oci.http`. The executor construction
and dispatch defaults additions in §10 are required before enabling it in a
deployed runner. Those files belong to other workstreams and were left untouched.
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
| `method` | `GET` `HEAD` `POST` `PUT` (no `DELETE`; see §6) |
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

## 4. Signing

The runner uses standard-library RSA PKCS#1 v1.5 with SHA-256 and the wire rules
in [Oracle's signing reference](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm).
No OCI SDK dependency was added: the Go module has no dependencies and this
workstream forbids dependency changes. Signed headers: `(request-target) host date`,
plus `x-content-sha256 content-type content-length` for POST/PUT, even without a
body. `keyId` is `ST$<security token>`. A Node-crypto-generated synthetic RSA
vector in `go/internal/oci/testdata/signing-vector.json` independently checks GET,
DELETE signer behavior, non-ASCII JSON byte lengths and empty PUT. DELETE is still
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

**Never allowed for any capability**, by absence from every list: secret-bundle
retrieval (`/20190301/secretbundles/…`: Zenith and the runner never read a
secret value back), object-level Object Storage (`/n/{ns}/b/{bucket}/o/…`:
customer data), any IAM write, `…/actions/changeCompartment`, secret deletion,
and every `DELETE`. Infrastructure changes go through `tofu.run`, not this
kind. `logs.read` (Logging search) is reserved and **not implemented**.

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

## 10. Open points

Before deploying, the orchestrator must add these two wiring points outside the
workstream's owned paths. Do not deploy with OCI advertised but unconstructed.

In `src/lib/runners/dispatch.ts`, add to `KIND_DEFAULTS` after `aws.http`:

```ts
  "oci.http": { timeoutSec: 60, maxOutputBytes: 1024 * 1024, queueTtlSec: 120 },
```

In `go/internal/runner/executor.go`, add after the AWS construction block in
`NewExecutor` (the names below need no additional imports):

```go
if k := cfg.Kinds.OCIHTTP; k != nil && k.Enabled {
    o, err := kinds.NewOCI(*k, kinds.OCIDeps{Getenv: deps.Getenv, Now: deps.Now})
    if err != nil { return nil, err }
    e.kinds[kinds.KindOCIHTTP] = o
}
```

The TS union currently makes the omitted defaults entry a type error; it was
left visible rather than weakened with casts or suppression. Executor and
dispatch integration must be verified by their owning workstreams.

`tests/providers/oci/allowlist.test.ts:247–252` also hard-codes the former proposal
status. Its owner must replace that test with current implementation assertions
while retaining the sealing and disabled-secret-write assertions:

```ts
it("states implemented scope and the sensitive-payload requirement", () => {
  expect(doc).toMatch(/IMPLEMENTED MODULE; INTEGRATION PENDING/);
  expect(doc).toMatch(/sealedBodyB64/);
  expect(doc).toMatch(/oci\.secretWrite: false/);
  expect(doc).toContain("go/internal/oci/");
  expect(doc).toContain("go/internal/runner/kinds/ocihttp*.go");
});
```

That test file is outside this workstream's owned paths. The existing provider
compile/static suites also refuse the sample stack's `redis/cache` identity grant
because the OCI identity driver has no Redis policy mapping. Keep that fail-closed
behavior until its owner supplies a verified mapping or corrects the sample grant.

- The service table (§5) and several API paths are taken from the OCI reference
  and SDK conventions and are unverified against a live tenancy.
- Resource-principal and OKE-workload runners need the OpenTofu child-env
  allowlist described in §4; `tofu*.go` is outside this workstream's owned paths
  and was not changed. This `oci.http` implementation launches no child process.
- A second, observe-only runner (`oci.enabled` with an allowlist limited to
  §6's read set) is the OCI equivalent of ADR-0006's separate observe role.
- OCI Object Storage's S3-compatible API as an OpenTofu state backend needs a
  static customer secret key and endpoint flags the workspace assembler does not
  emit yet (see `deploy/oci/README.md`).
