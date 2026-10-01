# Runner protocol extension — `oci.http` (OCI request-signing proxy)

**Status: PROPOSAL.** This document extends `zenith.runner/v1`
([RUNNER-PROTOCOL.md](RUNNER-PROTOCOL.md)) with one new job kind. Nothing here
is implemented in `go/`; the TypeScript side (the `OciApiTransport` port and
the control-plane half of this job) ships in `src/lib/providers/oci/` and is
tested against this format. It is additive: no change to registration, request
signing, the job envelope, results, heartbeat or versioning. A runner that does
not advertise `oci.http` is simply never sent one.

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
| `path` | absolute, percent-encoded, at most 2048 bytes, **no** `..`, `//`, `?`, `#`, `\`, control characters |
| `query` | ordered `[name, value]` pairs, sorted by name; the runner signs and sends exactly these |
| `headers` | only `opc-retry-token`, `if-match`, `if-none-match`, `opc-request-id`; `Authorization`, `Host`, `Date`, `x-date`, `x-content-sha256`, `Content-Length`, `Content-Type`, `Signature`, `Cookie` and `Proxy-*` are **refused** (not stripped) |
| `bodyB64` | JSON body bytes, at most 1 MiB; never on `GET`/`HEAD` |
| `endpointHost` | only `queue-data`: the queue's `messagesEndpoint` host; must match `*.oraclecloud.com` |

The runner reports `Content-Type: application/json` itself when a body exists.

## 3. Runner verification, in order

Reject (`status: "rejected"`, with a reason) on the first failure:

1. every v1 check (signature, `typ`, runner id, `iat`/`exp`, `jti` replay, grant);
2. `oci.http` enabled in local configuration (`oci.enabled: true`);
3. payload schema, field rules above;
4. **host resolution**: `service` + `region` → host from the runner's own table (§5, or better the OCI Go SDK's endpoint resolution); the result must be `https://` and end in `.oraclecloud.com` (this covers `*.oci.oraclecloud.com` and `*.ocp.oraclecloud.com`). For `queue-data` the supplied `endpointHost` must match `^[a-z0-9.-]+\.oraclecloud\.com$` (a runner may additionally require `.queue.messaging.` in it; the exact endpoint shape is unverified);
5. **capability allowlist** (§6): `(service, method, path pattern)` must be in the allowlist of the job's `capability`;
6. **compartment binding**: any `compartmentId` in the query or body, and any OCID the runner can parse from `path` for a compartment-scoped call, must be in `oci.allowedCompartments` (runner local config) — the runner never operates outside the compartments its owner named;
7. no `169.254.0.0/16` or metadata hostnames can be reached by construction (the host comes from the table, not from the job).

## 4. Signing

The runner signs with its principal using the OCI Go SDK
(`common.DefaultRequestSigner` over `auth.InstancePrincipalConfigurationProvider`,
`auth.ResourcePrincipalConfigurationProvider` or
`auth.OkeWorkloadIdentityConfigurationProvider`, matching `oci.auth`). The SDK
fetches and refreshes the security token; the runner never returns, logs or
persists it. Signed headers: `(request-target) host date`, plus
`x-content-sha256 content-type content-length` when there is a body;
`keyId` is `ST$<security token>` as produced by the principal. The runner
never follows redirects and does not retry non-idempotent requests.

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
by the envelope's `maxOutputBytes` (default 1 MiB); a truncated body is reported
with `truncated: true` and the control plane refuses to parse it.

An OCI error (`4xx`, `5xx`) is a **succeeded** job carrying that status: the
transport worked and the drivers classify the answer (`404`
`NotAuthorizedOrNotFound` is ambiguous by design; the drivers never conclude
"missing" from it alone). A refusal by the runner (§3) is `rejected`.

The runner retries `GET`/`HEAD` on `429`/`5xx` with jittered backoff, honouring
`retry-after`, at most 3 times within the job timeout. It never retries a
`POST`/`PUT`.

## 9. Audit

One line per request in the runner's local JSONL audit log: job id, capability,
service, method, the path **template** (OCIDs replaced by `{}`), status,
`opc-request-id`, and whether the body was sealed. Never a body, never a query
value that is a secret.

## 10. Open points

- The service table (§5) and several API paths are taken from the OCI reference
  and SDK conventions and are unverified against a live tenancy.
- Resource-principal and OKE-workload runners need the OpenTofu child-env
  allowlist described in §4; that belongs to the Go runner.
- A second, observe-only runner (`oci.enabled` with an allowlist limited to
  §6's read set) is the OCI equivalent of ADR-0006's separate observe role.
- OCI Object Storage's S3-compatible API as an OpenTofu state backend needs a
  static customer secret key and endpoint flags the workspace assembler does not
  emit yet (see `deploy/oci/README.md`).
