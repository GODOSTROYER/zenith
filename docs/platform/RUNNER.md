# zenith-runner — operator guide

`zenith-runner` is Zenith's outbound-only agent for your cloud or cluster. It
executes **signed jobs** from the Zenith control plane using the **workload
identity of the place it runs in**, so cloud credentials never leave your
network. The wire protocol is in [`RUNNER-PROTOCOL.md`](RUNNER-PROTOCOL.md); this
document is what you need to install, configure and trust it.

It is one static Go binary (`go/cmd/zenith-runner`, module
`github.com/GODOSTROYER/zenith/go`, standard library only).

## 1. What it is, and what it is not

| It does | It does not |
|---|---|
| connect **out** over HTTPS to Zenith (long-poll, heartbeat, results) | listen on any port |
| verify every job: Ed25519 signature with the pinned control-plane key, `typ`, its own id, expiry, replay, an embedded capability grant | trust anything it reads from a job payload as an instruction beyond the fixed job kinds |
| run OpenTofu (pinned version), sign AWS API requests with *local* credentials, call the in-cluster Kubernetes API, run bounded network probes | hold or receive AWS/GCP/Azure master credentials, model credentials, or Zenith database access |
| refuse anything not allow-listed **in its own local config** | let the control plane widen its local allowlists |

Two independent layers decide whether something runs: Zenith's capability broker
and policy engine decide *whether the operation is authorized*, and the runner's
local allowlists decide *whether this network accepts it*. A compromised control
plane still cannot make a runner do something its operator did not allow.

## 2. Install

### Helm (recommended on Kubernetes)

```sh
kubectl create secret generic zenith-runner-registration --from-literal=token='zrt_...'
helm install zenith-runner deploy/helm/zenith-runner \
  --set controlPlane.url=https://zenith.example.com \
  --set registration.existingSecret=zenith-runner-registration \
  --set image.repository=REGISTRY/zenith-runner
```

See `deploy/helm/zenith-runner/values.yaml` (every value is documented) and the
`examples/` directory (EKS IRSA, GKE Workload Identity, AKS Workload Identity,
Kubernetes read-only). The chart runs one replica with a `Recreate` strategy, a
persistent volume for the identity, `readOnlyRootFilesystem`, all capabilities
dropped, `RuntimeDefault` seccomp, and a NetworkPolicy that denies all ingress
and allows only DNS and HTTPS egress (metadata address excluded).

The chart was checked with `helm lint` and `helm template` (Helm 4.3.0), and the
configuration it renders was accepted by `zenith-runner check`. It has not been
installed into a live cluster.

### Container

```sh
docker build -f docker/runner.Dockerfile -t zenith-runner:1.0.0 --build-arg VERSION=1.0.0 .
```

The image is `gcr.io/distroless/static-debian12:nonroot` (no shell), contains the
runner and OpenTofu 1.12.5 verified against the official release checksum (the
build fails if the checksum is empty or wrong), and runs as uid 65532. Mount a
volume at `/var/lib/zenith-runner` and a config at `/etc/zenith-runner/`.
Built and run here with a read-only root filesystem; it has not been pushed
anywhere.

### Binary

`go/build.sh` builds `linux/amd64` and `linux/arm64` (`CGO_ENABLED=0`, `-trimpath`,
version injected with `-ldflags`) into `go/dist/` with a `SHA256SUMS` file. Install
OpenTofu **exactly** at the version in `src/lib/tofu/types.ts` (`TOFU_VERSION`,
currently 1.12.5) if you enable `tofu.run`.

### Registration

1. In Zenith create a **runner** registration token. It is single use, expires
   within an hour, is shown once and stored only as a SHA-256.
2. Register, from a file or the environment (a `--token` flag works but is
   visible in the process list, and the runner warns):

   ```sh
   zenith-runner --config /etc/zenith-runner/config.yaml register --token-file /run/token
   ```

   On first `run` the runner also registers by itself if it has no identity and
   finds `ZENITH_REGISTRATION_TOKEN` (or `registration.tokenFile`). That is what
   the Helm chart relies on.
3. Registration generates an Ed25519 key **on the host** and sends only the
   public half. The response delivers the control-plane public key(s) the runner
   then pins. Everything is saved to `<stateDir>/identity.json` (mode 0600; the
   runner refuses a group/world-readable identity file).

**Keep `stateDir` on a persistent volume.** The token is single use, so a
container that loses its state cannot register again without a new token.

Registering again over an existing identity needs `--force` and a new token.

## 3. Configuration

JSON or YAML, `--config FILE` (default `$ZENITH_CONFIG`, then the first existing
of `/etc/zenith-runner/config.{yaml,yml,json}`; with none, defaults plus
environment). Unknown fields are an **error**, so typos are caught at startup.
`zenith-runner check` validates the file and every enabled kind (for example a
bad allowlist entry or a missing `tofu` binary) without contacting Zenith.

YAML is parsed by a small built-in subset parser (no third-party dependency).
Supported: block maps and sequences, `key: value`, quoted and plain scalars,
one-line `[a, b]` / `{a: 1}`, comments. Rejected with a clear error: anchors,
aliases, tags, block scalars (`|`, `>`), multi-line flow collections, duplicate
keys, tab indentation. JSON files always work.

### Shared settings

| Key | Default | Meaning |
|---|---|---|
| `controlPlane.url` | required | `https://…` origin (optional path prefix). Plain `http` only for a loopback host (local development). |
| `tls.caFile` | system roots | Pin the CA bundle (PEM) used to verify Zenith. Verification is never disabled. TLS ≥ 1.2. |
| `tls.clientCert`, `tls.clientKey` | none | Client certificate for a control plane that terminates mTLS (self-hosted). A Vercel-hosted control plane cannot; there the request signature is the client authentication. |
| `stateDir` | `/var/lib/zenith-runner` | identity, replay cache, saved plans. Created 0700. |
| `name` | hostname | shown in Zenith |
| `labels` | `{}` | up to 20 key/value pairs sent at registration |
| `log.level`, `log.format` | `info`, `json` | `debug\|info\|warn\|error`, `json\|text` (stderr). Job payloads, grants, tokens and credentials are never logged. |
| `registration.tokenFile` | none | file with the single-use token for first-run registration |
| `pollWaitSec` | 20 | long-poll wait requested (0–25) |
| `heartbeatSec` | 30 | heartbeat period (5–300) |
| `maxConcurrent` | 4 | jobs running at once (1–64) |
| `shutdownGraceSec` | 30 | SIGTERM drain time for in-flight jobs |
| `maxResultBytes` | 4 MiB | largest result body posted (under the 4.5 MB request limit of serverless hosts); larger results become a `result_too_large` failure |
| `limits.defaultTimeoutSec` / `maxTimeoutSec` | 300 / 3600 | applied when a job names none / hard cap |
| `limits.defaultOutputBytes` / `maxOutputBytes` | 1 MiB / 8 MiB | likewise for output |
| `rejectUnknownConstraints` | false | refuse jobs whose grant carries policy-constraint keys this runner cannot enforce (see §7) |

Environment overrides: `ZENITH_CONFIG`, `ZENITH_CONTROL_PLANE_URL`,
`ZENITH_STATE_DIR`, `ZENITH_AGENT_NAME`, `ZENITH_LOG_LEVEL`, `ZENITH_LOG_FORMAT`,
`ZENITH_TLS_CA_FILE`, `ZENITH_TLS_CLIENT_CERT`, `ZENITH_TLS_CLIENT_KEY`,
`ZENITH_POLL_WAIT_SEC`, `ZENITH_REGISTRATION_TOKEN_FILE`,
`ZENITH_REGISTRATION_TOKEN`.

### Enabling job kinds

A kind is **disabled unless its block is present**. At least one must be enabled.
Write an empty block as `{}`: a key with nothing after it (`probe.tcp:`) is YAML
`null`, which counts as absent.

```yaml
kinds:
  probe.http: {}
  probe.tcp: {}
  probe.dns: {}
  aws.http:
    allow:
      infrastructure.observe: ["ec2:Describe*", "ecs:List*", "s3:GET /*"]
  tofu.run:
    binary: /usr/local/bin/tofu
  k8s.http:
    allow:
      infrastructure.observe: ["GET /api/v1/namespaces/*/pods"]
probes:
  allowLoopback: false
```

Any block accepts `enabled: false` to keep its settings but switch it off.
Capabilities registered with Zenith are the enabled kinds.

## 4. Job kinds

Every kind checks its payload strictly (**unknown fields are rejected**) before
anything runs. A failure is reported to Zenith as a `rejected` result with a
stable reason code (table in §6); nothing has executed.

### `tofu.run`

Payload: `{command: plan|apply|show, files:[{path,contentB64}], lockfile, configDigest, planFileSha256?, destroy?}`.

1. **Workspace digest.** The runner recomputes `configDigest` and refuses a
   mismatch (algorithm in §8). File paths must be relative `[A-Za-z0-9._-]`
   segments; `..`, `.terraform*`, state files, plan files and CLI config are
   refused. Accepted extensions: `.tf.json`, `.tfvars.json`, `.json`, `.tftpl`,
   `.txt` (HCL `.tf`/`.tfvars` only with `allowUnsafeConfig`). The lockfile
   travels separately and is written as `.terraform.lock.hcl`.
2. **Structural guard** on every `*.tf.json` (defense in depth, **not a
   sandbox**): provisioners and `connection` blocks, the `external`, `http` and
   `local` providers / data sources / resources, non-local module sources, and
   local-backend `path`/`workspace_dir` settings are refused.
3. **Fresh directory and pinned binary.** Each job gets a new 0700 temp dir
   (removed afterwards) and runs `tofu` by absolute path with argv only.
   `tofu version -json` must report exactly `tofu.version` (default 1.12.5).
4. **Environment allowlist.** Only fixed variables (`PATH`, a private `HOME`,
   `TF_IN_AUTOMATION`, `TF_INPUT`, `CHECKPOINT_DISABLE`, `TF_DATA_DIR`), the
   built-in cloud-identity passthrough (`AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`,
   `AWS_DEFAULT_REGION`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
   `AWS_ROLE_SESSION_NAME`, `AWS_STS_REGIONAL_ENDPOINTS`, `AWS_CONTAINER_*`,
   `AWS_EC2_METADATA_*`, `AWS_CA_BUNDLE`, `KUBERNETES_SERVICE_*`, proxy and CA
   variables) and names you add in `tofu.run.passEnv` reach OpenTofu. Anything
   else, and **every `ZENITH_*` name**, never does. (GCP and Azure workload
   identity variables are not in the built-in list: add the ones your providers
   need to `passEnv`.)
5. **Commands.** `init -input=false -no-color -lockfile=readonly`, then:
   * `plan`: `plan -out=<file> [-destroy]` and `show -json`. The binary plan file
     is **retained** under `<stateDir>/tofu-plans/` keyed by
     `(configDigest, sha256 of the plan file bytes)` for at most 24 hours
     (`planMaxAgeSec`). Result: `{command, exitCode, output, truncated,
     durationMs, planJson, planFileSha256}`.
   * `show`: requires `planFileSha256`; returns `planJson` for the retained plan.
   * `apply`: requires `planFileSha256`. It applies **exactly** the retained plan
     file this runner produced for that `configDigest` whose bytes still hash to
     `planFileSha256`, with the same lockfile; anything else is rejected
     (`plan_not_found`, `lockfile_mismatch`, expired, integrity failure). The
     plan is **single use**: it is deleted after an apply attempt, successful or
     not. A plan made with `destroy: true` can only be applied under
     capability `infrastructure.destroy`.
6. **Capabilities.** `plan`/`show` run under `planCapabilities` (default
   `infrastructure.plan`, `infrastructure.observe`, `cost.estimate`) or any apply
   capability; `apply` under `applyCapabilities` (default `infrastructure.apply`,
   `infrastructure.destroy`, `drift.repair`, `deployment.deploy`,
   `deployment.rollback`).
7. **Redaction and limits.** Output is redacted line by line for credential
   shapes before it leaves the runner (result and log stream), bounded by the
   job's `maxOutputBytes` keeping the head and the tail. `planJson` is **not**
   redacted (it must stay valid JSON and digest-stable) and is bounded separately
   by `maxPlanJsonBytes` (default 3 MiB); an over-limit plan **fails** rather than
   being truncated. Timeouts send SIGINT to the process group (so OpenTofu can
   finish writing state and release its lock), then kill after 30 s.

Settings: `binary`, `version`, `workDir`, `pluginCacheDir`, `cliConfigFile`,
`passEnv`, `planMaxAgeSec`, `allowUnsafeConfig`, `allowEphemeralState`,
`maxConcurrent` (default 1), `maxPlanJsonBytes`, `maxFiles`, `maxTotalBytes`,
`planCapabilities`, `applyCapabilities`.

**State.** The runner keeps no OpenTofu state between jobs. `apply` therefore
requires a **remote backend** (`s3`, `http`, …) declared in the compiled
configuration, and is refused with a local/implicit backend (state in the
job's temp dir would be destroyed with it, orphaning what was created).
`allowEphemeralState: true` lifts this for tests and throwaway environments only
(`allowUnsafeConfig` also skips the check, because it disables the structural
inspection the check depends on).

**Plan contents.** Plan files and `planJson` can contain sensitive values. The
plan store is 0700/0600 and entries are deleted on use or expiry; `planJson` goes
to Zenith over the signed TLS channel, which masks sensitive values in what it
stores and shows.

### `aws.http` — the SigV4 signing proxy

Zenith's TypeScript AWS drivers serialize an **unsigned** request (by the AWS
SDK) and send it as a job; the runner signs it with its **own** credentials and
returns the response. Payload: `{service, region, method, url, headers?, bodyB64?}`
(`headers` values may be strings or arrays).

Checks, in order:

1. `url` must be `https://`, no credentials, no fragment, port 443 or none, host
   matching `*.amazonaws.com`, `*.amazonaws.com.cn` or `*.api.aws` (ASCII, at
   least one label before the suffix). `evil.amazonaws.com.attacker.com`,
   `amazonaws.com`, IP literals, `user@host` tricks and look-alikes are refused.
2. `Authorization`, `X-Amz-Security-Token`, `X-Amz-Date`, `X-Amz-Content-Sha256`,
   `Host`, `Cookie`, `User-Agent` and hop-by-hop headers are **stripped**;
   pre-signed query parameters (`X-Amz-Signature`, …) are refused.
3. The **action is derived from the request itself**, never from a label:
   * JSON protocol — `X-Amz-Target` (`DynamoDB_20120810.PutItem` → `PutItem`);
   * query protocol — the `Action` parameter of the URL query or of a
     form-encoded body;
   * REST — `METHOD /decoded/path` (dot segments are refused).
   A request with both an `X-Amz-Target` and an `Action`, more than one
   `Action`, or a case variant such as `action=` is **refused as ambiguous**
   (parameter pollution would let the service run a different operation than the
   one authorized).
4. `service:Action` (or the REST form) must be in the allowlist for the job's
   **capability** (`kinds.aws.http.allow`). **Default deny**: a capability with
   no entry runs nothing.

Allowlist syntax: `service:Action`, where `Action` may end with a single `*`
(`ec2:Describe*`; `*` alone after a service is allowed, `*:*` and mid-string
wildcards are configuration errors), or for REST services
`service:METHOD /path/pattern` where a path segment `*` matches exactly one
segment and a final `**` matches the rest (`s3:GET /bucket/**`,
`lambda:GET /2015-03-31/functions/*/configuration`). `service` is the SigV4
signing name (`ec2`, `logs`, `s3`, `monitoring`, …).

Signing is AWS Signature V4 implemented in-tree and verified against the
**official AWS Signature V4 test suite** (26 cases reproduced byte for byte, plus
the AWS documentation's IAM `ListUsers` example and five independently computed
vectors; see `go/internal/awsauth/testdata/NOTICE.md`). S3 requests use the S3
rules (no path normalization or double encoding, `x-amz-content-sha256`).

Local credentials, chosen by what the environment provides (first match wins; a
failure is reported, never silently replaced by a lower source):

1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` [/ `AWS_SESSION_TOKEN`]
2. web identity — `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` (EKS IRSA and
   cross-cloud federation): the runner calls STS `AssumeRoleWithWebIdentity`
3. container credentials — `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or
   `_FULL_URI` (ECS task role, EKS Pod Identity; http only to loopback/ECS/EKS
   endpoints)
4. EC2 instance profile via IMDSv2 (unless `AWS_EC2_METADATA_DISABLED=true`)

Credentials are cached until five minutes before expiry, never logged, never
returned in a result, and redacted if they appear in an error.

The response is `{status, headers, bodyB64}` (standard base64). Headers are
allow-listed (`content-*`, `x-amz-*`, `x-amzn-*`, `etag`, `date`, …; never
`set-cookie`). An AWS 4xx/5xx is a *successful* job with that status, the SDK on
the control plane interprets it. A body above the limit (`maxOutputBytes`, and
`aws.http.maxResponseBytes`, default 8 MiB) fails the job with
`response_too_large` and `truncated: true` instead of returning a partial body.

Other settings: `maxRequestBytes`, `endpointOverride` (send to LocalStack or a VPC
endpoint proxy; the job's URL is still validated and signed), `stsEndpoint`,
`imdsEndpoint`.

### `k8s.http`

Payload `{method, path, bodyB64?, contentType?}` against the **in-cluster API
server** using the pod's service-account token (re-read for every request) and
the cluster CA. Allowlist per capability, `METHOD /path` with `*` = one segment
and a final `**`:

```yaml
k8s.http:
  allow:
    infrastructure.observe:
      - "GET /api/v1/namespaces/*/pods"
      - "GET /apis/apps/v1/namespaces/*/deployments/**"
```

Always refused, whatever the allowlist says: `exec`, `attach`, `portforward` and
`proxy` subresources, service-account `token` creation, `watch`/`follow`
streaming, dot or empty path segments, percent-encoding, and any path under
`secrets` unless you set `allowSecrets: true`. Grant the pod's ServiceAccount
matching RBAC; the allowlist narrows what the runner will *ask for*, RBAC what
the API server will *give*.

### `probe.http`, `probe.tcp`, `probe.dns`

Bounded reachability checks (payload and result shapes are defined by this
implementation; the protocol document only names the kinds):

* `probe.tcp`: `{host, port, timeoutMs?}` → `{ok, host, port, remoteAddr, latencyMs}`
  or `{ok:false, errorCode}` (`connection_refused`, `timeout`, `unreachable`,
  `dns_not_found`, …).
* `probe.http`: `{url, method?: GET|HEAD, headers?, timeoutMs?, followRedirects?,
  maxRedirects?, expectStatus?, includeBody?, maxBodyBytes?}` → `{ok, status,
  headers (allow-listed), latencyMs, bodyBytes, bodySha256, bodyPreview?
  (redacted, ≤ 64 KiB), tlsVersion?, tlsNotAfter?, redirects?}`. The URL's query
  string is never echoed back. TLS verification is always on (`probes.caFile`
  adds a private CA).
* `probe.dns`: `{name, type?: A|AAAA|CNAME|TXT|MX|NS}` → `{ok, answers, latencyMs}`.

A probe that finds the target unreachable **succeeded** (it made an
observation); `ok:false` says what it saw.

**Metadata and link-local targets are always refused** — `169.254.0.0/16`,
`fe80::/10`, `fd00:ec2::254`, `168.63.129.16`, `100.100.100.200`, unspecified and
multicast addresses, NAT64/IPv4-mapped forms of those, and the names
`metadata.google.internal`, `metadata.azure`, `instance-data` (and subdomains).
Loopback is refused unless `probes.allowLoopback`. The check is applied to the
**resolved addresses and the connection goes to the address that was checked**
(no second resolution), so a hostname that resolves to a metadata address, or
flips to one, cannot slip through; every redirect hop is re-checked. Guard
denials are reported as `rejected` with reason `guard_denied`.

## 5. Running it

`zenith-runner run` (the default). Lifecycle:

* **Poll** — `POST …/runners/{id}/poll` with `{max, waitSec}`; transient errors
  back off exponentially with jitter, 1 s → 60 s.
* **Heartbeat** every `heartbeatSec` with `{version, capabilities, running, host}`.
  The response can announce `nextKeys`; they are pinned and saved so key rotation
  (announced ≥ 24 h ahead) needs no restart.
* **Results** are posted with bounded retry; `409 already_settled` counts as
  delivered.
* **SIGTERM/SIGINT** — stop polling, let in-flight jobs finish for
  `shutdownGraceSec`, then cancel them (they still report), exit 0.
* **Revoked** (`401 agent_revoked` or a heartbeat with `revoked: true`) — stop
  immediately, report nothing further, **exit 3**.
* **Upgrade required** (`426`) — exit 4.

| Exit code | Meaning |
|---|---|
| 0 | clean shutdown |
| 1 | runtime error (cannot register, cannot create state, …) |
| 2 | usage or configuration error |
| 3 | revoked by the control plane |
| 4 | protocol version no longer accepted |

Clock: requests carry a timestamp and Zenith rejects skew over 60 s; keep NTP
running. Job and grant `iat`/`exp` are accepted with ±60 s of skew.

Logs are JSON on stderr. Per-job log lines are also streamed to Zenith
(`…/jobs/{jti}/logs`, ≤ 64 KiB per call), redacted for credential shapes and
capped at 4 MiB per job.

## 6. Verification order and rejection codes

For every job: signature with a pinned key → `typ` → `runnerId` is this runner
(and the workspace) → `iat`/`exp` → `jti` unseen (persisted cache, ≥ 24 h) →
kind enabled locally → embedded grant (signature, `exp`, `aud == runner:<id>`,
`cap == capability`, `op == operationId`, workspace) → payload schema →
kind-specific allowlists. Reported as `rejected` with `error: "<code>: <message>"`
and `result: {reason: <code>}`:

| Code | Cause |
|---|---|
| `malformed_token`, `unsupported_alg`, `unknown_key`, `bad_typ`, `invalid_signature` | not a valid compact JWS from a pinned control-plane key (`alg` must be exactly `EdDSA`) |
| `unsupported_protocol`, `wrong_target`, `invalid_claims` | wrong protocol id, job for another runner/workspace, missing ids |
| `expired`, `not_yet_valid` | outside `iat`/`exp` ±60 s |
| `replay` | id already accepted (see below) |
| `replay_cache_unavailable` | the cache could not persist the id: fail closed |
| `kind_disabled` | kind not enabled in this runner's config |
| `grant_invalid`, `grant_wrong_audience`, `grant_wrong_capability`, `grant_wrong_operation`, `grant_wrong_workspace` | embedded grant does not authorize this job |
| `invalid_payload` | payload does not match the kind's schema |
| `not_allowed` | local allowlist or guard said no |
| `guard_denied` | metadata/link-local target |
| `constraint_unsupported` | malformed or (strict mode) unknown grant constraint |

Replays are special: a re-delivered job id is dropped **without** a result,
because a second "rejected" could win the control plane's first-writer race
against the real result of the original delivery. A job whose *signature fails*
is reported using its (unverified, identifier-shaped) `jti` so Zenith is not left
waiting.

## 7. Grants, constraints and limits

The embedded grant is a second compact JWS (`typ: zenith-grant+jwt`). The runner
does **not** consume grant ids: one operation legitimately sends many `aws.http`
jobs under one grant, so single-use is enforced on job ids only.

Timeout and output are clamped to local `limits`, and the grant's constraints
`maxTimeoutSec` and `maxOutputBytes` can only tighten them. Other constraint
keys are policy decisions Zenith enforces before dispatch; the runner ignores
them unless `rejectUnknownConstraints` is true (then it refuses the job rather
than run it without enforcing what the policy asked for).

## 8. Algorithms (for implementers and auditors)

**Request signature** (`docs/platform/RUNNER-PROTOCOL.md` §3). The signed string
is six fields joined by `\n`, no trailing newline: protocol id, upper-case
method, path **including any base-URL path prefix and the query**, unix seconds,
nonce (16 random bytes, base64url), lowercase-hex SHA-256 of the exact body bytes
(of the empty string when there is none). Base64url is unpadded everywhere.
Golden vector: `go/internal/protocol/testdata/signing-vector.json` (verified with
Node's `crypto`); a signed job vector: `jws-vector.json` (verified with `jose`).

**`configDigest`**. Sort the files by `path` (byte order; paths are ASCII so this
equals JavaScript's code-unit order). For each file append
`path ‖ 0x00 ‖ lowercase-hex(sha256(content bytes)) ‖ 0x0A`. The digest is the
lowercase hex SHA-256 of that concatenation. The lockfile is not included
(`lockDigest` = SHA-256 hex of its bytes). Vectors:
`go/internal/runner/kinds/testdata/config-digest-ts-vector.json` (from the
TypeScript side, `tests/tofu/fixtures/config-digest-vector.json`) and
`config-digest-vector.json` (computed with Node's `crypto`); both pass. An empty
file list digests to `e3b0c442…b855` (the empty-string hash); the runner still
refuses a `tofu.run` job with no files.

## 9. Security notes and honest limits

* The runner's trust in Zenith is exactly the pinned Ed25519 keys plus its local
  allowlists. It verifies TLS (system roots or a pinned CA) and never disables it.
* `tofu.run` executes provider plugins, which are arbitrary code, with the
  runner's cloud identity. The lockfile (`-lockfile=readonly`) pins providers by
  hash; the structural guard and the environment allowlist narrow what a
  compromised *configuration* can reach; none of this sandboxes OpenTofu. Run the
  runner with only the cloud permissions you are prepared for Zenith's workflows
  to use, and scope the role per environment.
* `aws.http` action filtering relies on deriving the action from the request.
  It is accurate for the JSON, query and REST conventions above; a service that
  encodes its operation some other way should get no allowlist entry.
* Pattern redaction is best-effort: a secret with no recognizable shape on its
  own output line is not caught.
* Control-plane key rotation (`nextKeys`) is accepted over the verified TLS
  channel; the keys are not separately signed.
* `planJson` and plan files contain whatever the plan contains, including
  sensitive values; see "Plan contents".
* Verified by automated tests in this repository: everything above, using fake
  control planes, local listeners, a fake `tofu` for logic tests, **real OpenTofu
  1.12.5** for plan / show / apply of a `terraform_data` resource, and the real
  Docker image (build, checksum enforcement, read-only run). Not verified: any
  real cloud account (AWS, GCP, Azure), EKS/GKE/AKS, a live Zenith control plane,
  or IRSA/Workload Identity end to end.
