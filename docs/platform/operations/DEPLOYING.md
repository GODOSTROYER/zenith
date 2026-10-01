# Deploying the platform control plane

How the pieces of the platform control plane fit together, what each one needs
in its environment, and how to run them. This is for whoever operates a Zenith
install; the design is in [ARCHITECTURE.md](../ARCHITECTURE.md) and the ADRs.

Written against branch `ws/docs`, merged with `platform/integration` at `6354117` (2026-10-01). Everything
here is checked against the code on that branch; anything that is not verified
live says so, and the last section collects them.

## Status: what actually runs on this branch

The control plane is being built in several workstreams. Read this table before
the rest of the page, because a component that is "deployed" is not necessarily
doing work yet.

| Component | State on this branch |
|---|---|
| Platform control store (Postgres `platform` schema, PGlite locally) | Built and tested: on PGlite by default, and on real PostgreSQL when `ZENITH_TEST_PLATFORM_PG_URL` is set. **Nothing in `src/app` or the worker opens it yet**: no route and no activity calls `platformDb()`. It is used by `npm run migrate:platform` and the tests. |
| Credential broker and OIDC issuer | Built and tested with mocks. The two public routes (`/api/oidc/jwks`, `/api/oidc/.well-known/openid-configuration`) are live in the Next app. Nothing has run against real AWS STS or KMS. |
| OpenTofu engine (`src/lib/tofu`) | Built and tested with the real `tofu` binary; only builtin `terraform_data` and `hashicorp/random` have been applied. No cloud provider has been run against a cloud. Not called by the worker yet. |
| Policy engine (`policy/`, `src/lib/policy`) | Built and tested; the bundle is committed and reproducible. **No caller yet**: the capability broker that builds the input is in progress. |
| Resource model, placement and cost, observability | Built as pure libraries (no environment, no I/O except the observability sources' own clients). Not wired into any route. |
| Incident engine (`src/lib/incidents`), repository analysis (`src/lib/analysis`), platform UI components (`src/components/platform`) | Merged and tested. The incident engine and the analysis module are libraries that read no environment variables and are called by nothing yet; the UI components are presentational (data and callbacks come in as props) and no page or route renders them. Nothing here needs deploying. |
| Temporal workflows, client and execution worker | The workflows, client, worker process and image recipe are built and tested against real Temporal servers. **Every activity is a stub** that fails with `not_implemented` ("nothing was changed"): the worker boots, polls and runs workflows, and no operation can do real work. |
| Reconciliation controller (`src/lib/reconcile`, migration 2 `platform.reconcile_state`, `POST /api/internal/tick/reconcile`) | Built and tested. It observes and files `drift.repair` *proposals*; it never executes one. The route is gated by `CRON_SECRET` and answers `503 platform_store_unavailable` until production ports are registered with `wireReconcilePorts()`, which nothing on this branch does; `.github/workflows/tick.yml` does not call it either. It needs drivers to observe anything real, and none has merged. See section 2.8. |
| `zenith-runner` and `zenithd` (Go, `go/`, Helm chart, Dockerfiles) | Built by another workstream, with their own operator guides: [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md). Their control-plane side (the runner and machine routes, `src/lib/runners`, `src/lib/machines` beyond its types) is **not merged**, so nothing on this branch can register or feed an agent. I did not run or verify the agents. |
| AWS network and edge resource drivers (`src/lib/providers/aws/drivers/network`: VPC, subnet, security-group rule, ALB, Route 53 zone and record, ACM certificate) | Merged as modules and tested with mocked SDKs (plus `tofu validate` against the real provider schema when `ZENITH_TEST_TOFU_NETWORK=1`). **Nothing registers them**: the provider-level `drivers/index.ts` that would is not merged, so `getDriver()` finds none and the worker cannot use them. Every operation they declare is `contract` evidence ([CAPABILITY-MATRIX.md](../CAPABILITY-MATRIX.md)). |
| The remaining resource drivers (every other AWS group, and the Kubernetes, GCP, Azure, OCI and managed `zenith` providers), the capability broker, the control-plane side of the runner and machine protocols, REST `/api/platform/v1`, MCP v3, and the platform screens and routes | **In progress in other workstreams. Not documented here.** When they merge they get their own sections. |

The honest summary: today you can stand up the store, the OIDC issuer and the
worker, and you can see the pieces connect. You cannot yet run a deploy to a
cloud through them.

## 1. Topology

```
 browser / REST / MCP / CLI
            |
            v
 +----------------------------+          +---------------------------+
 | web / API control plane    |  start / |  Temporal                 |
 | Next.js (Vercel or a Node  |  signal  |  Cloud or self-hosted;    |
 | host)                      |--------->|  `temporal server         |
 |  - /api/oidc/* (live)      |  query   |  start-dev` locally       |
 |  - capability broker (WIP) |          +-------------+-------------+
 |  - Temporal client         |                        | polls
 +-------------+--------------+                        v
               |                          +---------------------------+
               |  SQL (pooler)            | execution worker          |
               v                          | long-running container    |
 +----------------------------+           |  - workflows (sandbox)    |
 | platform Postgres          |<----------|  - activities (stubs now) |
 | schema `platform`          |   SQL     |  - tofu binary            |
 +----------------------------+           +------+-------------+------+
                                                 |             |
                              AssumeRoleWithWebIdentity        | tofu state, S3
                                                 v             v
                                        customer cloud account (AWS)
```

| Component | Runs on | State it holds | Talks to |
|---|---|---|---|
| Web / API control plane | Vercel or any Node host | None of its own; reads the product store and (when wired) the platform store | platform Postgres, Temporal (start, signal, query only) |
| Execution worker | A long-running container built from `docker/worker.Dockerfile` | None; stateless | Temporal, platform Postgres, cloud APIs, `registry.opentofu.org` for providers, the customer's state bucket |
| Temporal | Temporal Cloud, self-hosted, or `temporal server start-dev` locally | Workflow history: ids, digests, counts and redacted messages only | The web app and the worker |
| Platform Postgres | Supabase (Supavisor transaction pooler) or any Postgres 16 | Schema `platform`: operations, leases, approvals, decisions, resources, connections | Web and worker |
| `zenith-runner`, `zenithd` (optional) | Customer VPC / VMs | See [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md); the control-plane side is not merged | Outbound to the control plane only |

### What must never run on Vercel

**The execution worker.** It is a process that polls Temporal continuously and
runs `tofu plan` and `tofu apply` for tens of minutes as child processes (the
workflow allows an apply up to 60 minutes, see [EXECUTION-WORKER.md](../EXECUTION-WORKER.md#retries-timeouts-heartbeats)).
A request-scoped serverless function can do neither. The worker is built as a
container for that reason.

Also keep off a serverless host:

- **PGlite as the platform store.** With no platform database URL set, the store
  defaults to PGlite on the local filesystem (`<ZENITH_DATA>/platform-pg`); on a
  serverless instance that is neither durable nor shared between instances. On
  Vercel set `ZENITH_PLATFORM_DB_URL` (or `SUPABASE_DB_URL`) explicitly.
- **The `tofu` binary and provider downloads.** Planning and applying belong to
  the worker, never to a route.

What may run on Vercel: the web app, the OIDC routes, and the Temporal *client*
(start / signal / query), which needs the Node runtime (not edge) and is already
listed in `serverExternalPackages` in `next.config.ts`.

## 2. Environment variables

### 2.1 How they are read

Each module reads the environment in **one function** and nowhere else, and each
refuses a bad value at start-up naming the variable (never the value):

| Concern | The one reader | Also validated at boot by `env()`? |
|---|---|---|
| Platform store | `platformDbConfigFromEnv` in `src/lib/controlplane/db/open.ts` | Yes: `ZENITH_PLATFORM_DB*` are in the schema in `src/lib/env.ts` |
| Workload identity and signing keys | `loadCredentialsConfig` in `src/lib/credentials/config.ts` | Declared in `env.ts` but left loose there; the loader validates |
| Temporal connection | `temporalConfigFromEnv` in `src/lib/workflows/config.ts` | No |
| Execution worker | `executionWorkerConfigFromEnv` in `workers/execution/config.ts` | No |
| OpenTofu binary and plugin cache | `resolveTofuBinary` (`src/lib/tofu/binary.ts`) and `TofuRunner` (`src/lib/tofu/runner.ts`) | No |
| Policy bundle path | `DEFAULT_POLICY_WASM` and `ZENITH_POLICY_WASM` in `src/lib/policy/engine.ts` | No |

A variable that `env()` validates makes the **product** refuse to start when it
is malformed, even on an install that never uses the platform. Conversely, the
Temporal, worker, tofu and policy variables are checked only when their module
is used.

A variable is **consumed today** only if some running code path reads it. The
"Consumed on this branch" column says where that is true; the rest are read by
code that exists and is tested but is not yet called from a route or an activity.

### 2.2 Platform store

| Variable | Default | Secret | Consumed on this branch | Meaning |
|---|---|---|---|---|
| `ZENITH_PLATFORM_DB` | `postgres` when a URL is set, otherwise `pglite` | no | `npm run migrate:platform`, tests | `pglite` or `postgres`. Naming `postgres` without a URL is an error that says which variable to set. |
| `ZENITH_PLATFORM_DB_URL` | falls back to `SUPABASE_DB_URL` | **yes** (carries the password) | `npm run migrate:platform`, tests | `postgres://` or `postgresql://` URI. In production use the Supavisor **transaction-pooler** URI (port 6543): the store uses no session state and no advisory locks, and turns prepared statements off, precisely so it works through the pooler. Never printed: errors say it was rejected and how long it was. |
| `ZENITH_PLATFORM_DB_MAX` | `5` | no | same | Connection pool size, integer 1 to 100. Postgres only. |
| `ZENITH_DATA` | `<cwd>/.data` | no | same | PGlite files live in `<ZENITH_DATA>/platform-pg`. One process per directory: PGlite has no cross-process locking. |
| `SUPABASE_DB_URL` | unset | **yes** | the product store, and as the fallback above | Supabase's own name for the same connection string. |

The code sets no `ssl` option on the connection. If your database requires TLS,
put it in the URL (for example `?sslmode=require`); the driver reads it from
there. This was not exercised against a TLS-only server here.

### 2.3 Workload identity and control-plane signing

Full reference, including what each key is for and how to rotate it:
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md).
Summary:

| Variable | Secret | Needed where | Meaning |
|---|---|---|---|
| `ZENITH_OIDC_ISSUER` | no | every process that **mints** tokens (the worker) and, unless the request origin is right, the web app | Issuer URL, for example `https://app.example.com/api/oidc`. https only (http for localhost). Customers pin this URL in their IAM OIDC provider, so **changing it means every connected account must redeploy its bootstrap stack**. |
| `ZENITH_OIDC_SIGNING_JWK` | **yes** | see below | RS256 private JWK, JSON or base64 of JSON. |
| `ZENITH_OIDC_KMS_KEY_ID` | no | see below | AWS KMS key id, ARN or alias (RSA_2048 or larger, `SIGN_VERIFY`). Use this in production: the private key never leaves KMS. |
| `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` | no | wherever the JWKS is served | Extra **public** keys to publish during rotation. A private key here is refused. |
| `ZENITH_CONTROL_SIGNING_JWK` | **yes** | the signer of grants and jobs (web / broker) | Ed25519 private JWK. Signs capability grants, runner jobs and machine requests. |
| `ZENITH_CONTROL_KMS_KEY_ID` | no | same | KMS alternative for the control key. **Not verified against real KMS** (Ed25519 via `ED25519_SHA_512`). |
| `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` | no | every **verifier** (the worker, runners) | Extra public Ed25519 keys accepted when verifying grants. A verifier needs the signer's public key: either the signer configuration or this. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | no | KMS signers | Region hint for the default KMS client when the key id is not an ARN. |

Rules the loader enforces: setting both the JWK and the KMS variable for the same
key family is an error; the OIDC key must be RS256 and the control key Ed25519,
so one cannot be loaded as the other; a private member in an `EXTRA_PUBLIC`
value is rejected outright.

Two placement consequences that follow from the code, not from a preference:

1. **The JWKS route needs a signer.** `GET /api/oidc/jwks` publishes the signing
   key's public half, derived from the configured signer. With no signer
   configured it answers `503 oidc_not_configured`. There is no public-key-only
   configuration for the OIDC key. So the process that serves the route (the web
   app) needs `ZENITH_OIDC_SIGNING_JWK` (a private key on the web host) **or**
   `ZENITH_OIDC_KMS_KEY_ID` with permission to call `kms:GetPublicKey` (no private
   key on the web host; this is the reason to prefer KMS).
2. **Token minting happens in the worker.** The credential broker runs inside
   activities, so the worker also needs the OIDC signer and `ZENITH_OIDC_ISSUER`
   (the minter has no request to derive the origin from).

The AWS SDK's default credential chain supplies the credentials for KMS calls
(`KMSClient` is built with only a region), and for `aws_assume_role` connections
the broker calls STS with Zenith's own default chain. Neither path has been run
against a real account.

### 2.4 Temporal

Read by `temporalConfigFromEnv`, for **both** the web app's client and the worker.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `ZENITH_TEMPORAL_ADDRESS` | `localhost:7233` | no | Frontend `host:port`. |
| `ZENITH_TEMPORAL_NAMESPACE` | `default` | no | Namespace. Must already exist. |
| `ZENITH_TEMPORAL_API_KEY` | unset | **yes** | Temporal Cloud API key. Setting it forces TLS. Never logged; `describeTemporalConfig` reports only "set" or "unset". |
| `ZENITH_TEMPORAL_TLS` | `false` | no | `true` or `1` forces TLS without an API key, with the SDK's default TLS settings. There is no option for a custom CA or for client certificates (mTLS is not wired). |

### 2.5 Execution worker

Read by `executionWorkerConfigFromEnv`. Details and defaults:
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#configuration).

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_WORKER_TASK_QUEUE` | `zenith-execution` | Task queue to poll. **Leave it alone.** The control plane's client starts workflows on the constant `zenith-execution`; there is no environment variable on the client side, so a worker polling another queue would never receive anything. |
| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` | Parallel activities **per replica** (1 to 1000). Each `tofu` plan or apply spawns provider processes; lower this before you let the kernel kill one mid-apply. |
| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` | Parallel workflow tasks (1 to 1000). |
| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` | How long running activities may finish after SIGTERM before they are cancelled. Set the container's stop timeout **above** this. |
| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` | Longest gap between heartbeats reaching Temporal; bounds how long a cancel takes to reach a running activity (100 to 60000). |
| `ZENITH_WORKER_WORKFLOW_BUNDLE` | unset | Path to a prebuilt workflow bundle. The image sets it to `/app/dist/execution/workflow-bundle.js`; unset, the worker bundles the TypeScript at start-up (development). |
| `ZENITH_WORKER_LOG_LEVEL` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`. |
| `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS` | `60000` | Period of the `health` log line; `0` disables. There is no HTTP health endpoint. |
| `ZENITH_WORKER_IDENTITY` | `zenith-exec:<host>:<pid>` | Worker identity shown in Temporal. |

### 2.6 OpenTofu engine

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_TOFU_BIN` | `tofu` found on `PATH` | Absolute path to the binary. The runner refuses any binary whose `tofu version -json` is not exactly the pinned `1.12.5` (`TOFU_VERSION` in `src/lib/tofu/types.ts`). The worker image installs 1.12.5 at `/usr/local/bin/tofu`, checksum-verified at build time. |
| `ZENITH_TOFU_PLUGIN_CACHE` | `<os tmp>/zenith-tofu-plugin-cache` | Absolute path of the shared provider plugin cache. The image's default lands in `/tmp`, which is lost whenever the container is replaced, so every new container re-downloads providers (the lockfile script notes about 160 MB per platform for the AWS provider). Pointing this at a persistent volume avoids that; this recommendation has not been tried. |

These are read from the **worker's** environment, but the child `tofu` process
never sees them or anything else: the runner builds the child environment from an
allowlist (`src/lib/tofu/env.ts`), and refuses `ZENITH_*`, `TF_CLI_ARGS*`,
`TF_LOG*`, `TF_VAR_*` and `TF_REATTACH_PROVIDERS` from any session or extra
configuration. No `ZENITH_*` variable, database URL or signing key can reach a
provider plugin.

The worker needs outbound HTTPS to `registry.opentofu.org` and the hosts the
registry points to for provider packages. `tofu init` runs with
`-lockfile=readonly`, so only the exact builds in the committed lockfiles
(`src/lib/tofu/locks/*.terraform.lock.hcl`) install.

The runner's own default wall-clock limit per command is 30 minutes
(`DEFAULT_LIMITS` in `src/lib/tofu/runner.ts`) while the workflow allows an apply
activity 60 minutes. The real apply activity must pass a larger limit or long
applies will be cut at 30 minutes; there is no such activity yet.

### 2.7 Policy engine

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_POLICY_WASM` | `<cwd>/policy/dist/policy.wasm` | Path of the compiled bundle. A missing, empty or tampered bundle makes `loadPolicyEngine()` reject with `PolicyLoadError`; callers must treat that as "deny everything". |

Two gaps to close when the broker and the `evaluatePolicy` activity are wired:

- `next.config.ts` has **no `outputFileTracingIncludes`** for `policy/dist/**`, so a
  Vercel build would not ship the bundle to a route that evaluates policy.
- `docker/worker.Dockerfile` copies only `src/lib` and `workers/execution`, so the
  **worker image does not contain the policy bundle** either. Either copy
  `policy/dist/` into the image and set `ZENITH_POLICY_WASM`, or mount it.

### 2.8 Reconciliation tick

The controller itself reads no environment except one development switch; the route
that drives it is gated like every other tick route.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `CRON_SECRET` | unset | **yes** | Bearer token for `/api/internal/tick/*` (the product's name for it; see [RUNNING.md](../../RUNNING.md#environment-variables)). Unset, the route answers 503 and runs nothing; a wrong bearer is 401. |
| `ZENITH_RECONCILE_MEMORY` | unset | no | `1` runs the pass against an in-memory backend that is empty unless something seeded it. Local development and route smoke tests only: nothing is durable. |

With neither production ports wired nor that switch set, the route fails with
`platform_store_unavailable` rather than reporting "0 drift" for a fleet nobody
looked at. Reconciliation is paced by a backoff ladder (5, 15, 60, then 180
minutes while nothing changes; open drift never backs off past 60 minutes and an
open incident never past 15), with deterministic jitter and a per-pass budget of
about 20 seconds and at most a bounded number of environments; sandbox
environments and environments with no verified connection are not reconciled.
That is from `src/lib/reconcile/scheduler.ts` and `pass.ts`; none of it has run
against a fleet.

### 2.9 Tooling only (not runtime)

| Variable | Used by | Meaning |
|---|---|---|
| `ZENITH_OPA_BIN` | `npm run policy:build`, `policy:check` | Path to the OPA binary. Must be exactly 1.19.1. Default: `opa` on `PATH`. |

### 2.10 Modules that read no environment

The resource model (`src/lib/resources`), placement and cost (`src/lib/placement`),
the observability fabric (`src/lib/observability`), the incident engine
(`src/lib/incidents`), repository analysis (`src/lib/analysis`) and the merged AWS
network drivers (`src/lib/providers/aws/drivers`) read no environment variables. Observability sources receive their clients and endpoints as
arguments from the broker session; the price catalog is a bundled JSON file.

### 2.11 Which component needs what

| Variable group | Web / API | Worker | Migration script |
|---|---|---|---|
| Platform store (`ZENITH_PLATFORM_DB*`, `ZENITH_DATA`) | yes, when the broker is wired | yes, when the activities are wired | yes |
| OIDC issuer and signer | yes (serves the JWKS; needs a signer) | yes (mints tokens) | no |
| Control signing key | yes (signs grants) | public key at least (verifies grants) | no |
| Temporal connection | yes (client) | yes | no |
| `ZENITH_WORKER_*` | no | yes | no |
| Tofu variables | no | yes | no |
| Reconciliation tick (`CRON_SECRET`, `ZENITH_RECONCILE_MEMORY`) | yes (the route) | no | no |
| Policy bundle | yes, when the broker is wired | yes, when the activity is wired | no |

## 3. The platform database

### 3.1 Choosing

| Where | Use | Migrations |
|---|---|---|
| Local development and tests | PGlite (Postgres compiled to WebAssembly, in process). Nothing to install. | Applied automatically when it opens. |
| Production and anything shared | PostgreSQL 16 through the pooler. | **You** apply them. The application never runs DDL against Postgres. |

### 3.2 Migrating

```bash
npm run migrate:platform                 # apply pending migrations
npm run migrate:platform -- --status     # print the ledger; exit 1 unless current
npm run migrate:platform -- --dry-run    # list what would be applied
npm run migrate:platform -- --url postgres://...   # target this database, not the environment's
```

The target is decided exactly as the application decides it (the variables in
section 2.2), and `.env.local` is read when present. The connection string is
never printed, only host, port and database name. Exit codes: 0 ok, 1 not
current or refused, 2 usage error.

What makes this safe to run from CI and by hand, at the same time if need be:
each migration and its ledger row (`platform.schema_migrations`: version, name,
checksum) commit in one transaction under a table lock, so two migrators
serialise and the loser finds the work done. A migration whose recorded checksum
differs from the code is refused (`schema_tampered`): shipped migrations are
never edited, a change is a new migration.

If you would rather apply SQL yourself (the Supabase SQL editor, `psql`), apply
`supabase/migrations/0014_platform_core.sql`. It is **generated** from the
TypeScript migrations by `npm run platform:emit-sql` (`-- --check` fails when it
is out of date; a test enforces byte equality). It is idempotent, writes the same
ledger rows with the same checksums (so the TypeScript migrator recognises it as
applied), turns row level security on for every table with no policies, and
revokes `anon` and `authenticated`. **`platform` must never be added to the Data
API's exposed schemas.**

The emitted file keeps one name as migrations are added; it grows. If you apply
migrations through the Supabase CLI's migration history, which records an applied
file by its version number and will not re-run a changed file, use
`npm run migrate:platform` (ledger-based) or apply the file by hand for any
schema version after the first. Two migrations exist today (`core` and
`reconcile`) and the emitted file already holds both, so a database that applied
the file before migration 2 landed is exactly this case. I did not exercise it
through the Supabase CLI.

### 3.3 What the application does about the schema

On first use of a Postgres store, `platformDb()` calls `assertPlatformSchemaCurrent`
once. If the ledger is missing or a migration is pending it **fails closed** with
the command to run ("Nothing was read or written"). A database *ahead* of the
build (a newer deploy already migrated) is accepted, because refusing would break
every rolling deploy. The order that follows: **migrate first, then roll out the
new application**; an older build keeps working against a newer, additive schema.
Older code rolling back after a migration is safe only as long as migrations stay
additive; there are no down migrations.

### 3.4 Retention

Two things bound themselves as they are written: resource observations (the
latest 100 per resource are kept, pruned on every append) and drift reports (the
latest 50 per environment). Functions exist to prune idempotency keys
(`idempotency.prune`) and agent request nonces (`nonces.prune`), but **no process
calls them yet**. Nothing deletes events, evidence, operations, approvals, policy
decisions, grants or runner jobs. Plan capacity for those tables to grow without
bound until a retention job exists, and treat pruning of operations and events as
a product decision, not a clean-up: they are the audit trail.

## 4. Signing keys

Generate them as described in
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md#generating-keys)
(one `tsx` one-liner per key; KMS commands for production). Then:

- store the private JSON in the platform's secret manager or your host's
  encrypted environment, never in the repository, a manifest, a chat or a ticket;
- give the web app and the worker the variables in section 2.3 as that table
  says;
- confirm the public endpoints from outside:

```bash
curl -s https://<host>/api/oidc/.well-known/openid-configuration | jq .
curl -s https://<host>/api/oidc/jwks | jq '.keys[] | {kid, alg, kty}'
```

Both paths are public by design and are allowed through the session middleware in
`src/middleware.ts` on this branch. A `401` or a login redirect there would stop
AWS from creating or using the OIDC provider.

Rotation is in [RECOVERY.md](RECOVERY.md#6-key-rotation).

## 5. Temporal

### 5.1 Locally

```powershell
# 1. a local Temporal: in-memory, no UI
temporal server start-dev --headless --port 7233

# 2. the worker, from the repo root (reads .env.local if present)
$env:ZENITH_TEMPORAL_ADDRESS = "127.0.0.1:7233"
npm run worker
```

If something else on your machine already listens on 7233, pick another port and
give the same address to the worker and to the app. The dev server keeps history
**in memory**: stopping it loses every workflow. Add `--db-filename <path>` to
keep it in a file.

On this branch the worker prints `execution worker ready` (with the configuration
minus secrets) and then a `health` line every minute. Any operation started
against it fails fast with `Activity markOperation is not implemented in this
worker build; nothing was changed`; that is the expected behaviour of the stub
build, not a fault.

### 5.2 In production

| | Temporal Cloud | Self-hosted |
|---|---|---|
| What you set | `ZENITH_TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233`, `ZENITH_TEMPORAL_NAMESPACE=<namespace>.<account>`, `ZENITH_TEMPORAL_API_KEY` | `ZENITH_TEMPORAL_ADDRESS` (and `ZENITH_TEMPORAL_TLS=true` if the frontend serves TLS with a publicly trusted certificate) |
| Authentication | API key only; it forces TLS. mTLS is not wired. | None in this configuration: no API key and no client certificates. Put it on a private network. |
| History | Held by Temporal; retention is a namespace setting. | Held in the database you run under it. Backing that up is yours. |
| What was verified | Nothing live. There is no Cloud account on the build machine; the option shapes follow the SDK's documented API-key and TLS options. | The dev server, locally. No production-shaped cluster. |
| Cost of operating | A subscription. | A cluster and its database to run, patch and back up. ADR-0009 names a Postgres-native engine as the fallback if this proves disproportionate. |

Workflow history is durable and replicated and is **not encrypted by Zenith** (no
payload codec is configured). It holds ids, digests, counts and short redacted
messages by contract, never credentials, secret values, plan files or provider
responses.

## 6. The execution worker

### 6.1 Image

```bash
docker build -f docker/worker.Dockerfile -t zenith-execution-worker .
```

Node 22.16 (base image pinned by tag and digest), OpenTofu 1.12.5 (pinned by
version and SHA-256; the build fails on an empty or wrong checksum), the bundled
worker and a prebuilt workflow bundle. It runs as a non-root user and listens on
**no port**: it only dials Temporal, the database, and the clouds. It uses `tini`
as PID 1 so SIGTERM reaches the worker and orphaned provider processes are
reaped.

**Status: written and command-checked, never built.** Docker is not available on
the machine it was authored on. The esbuild bundle command, the workflow-bundle
build and `node dist/execution/worker.cjs` booting against a Temporal dev server
were run; `docker build`, the `apt` and OpenTofu downloads inside it, the Linux
`@swc/core` binding and `npm ci --omit=dev` from the Dockerfile were not.

### 6.2 Running it

- Environment: sections 2.3 to 2.7 as applicable. Secrets arrive as environment
  at run time; none is baked into the image.
- Read-only root filesystem works with `/tmp` and `/var/lib/zenith` writable
  (OpenTofu working directories and the plugin cache go to the temp directory).
- Stop timeout: set the orchestrator's stop timeout (Kubernetes
  `terminationGracePeriodSeconds`, Docker `--stop-timeout`) **above**
  `ZENITH_WORKER_SHUTDOWN_GRACE_MS`, or the worker is killed in the middle of an
  activity. On SIGTERM the worker stops polling and lets running activities
  finish for that long, then cancels them; a second signal exits immediately.
- Replicas: the worker is stateless; run several against the same task queue.
  Scale on Temporal's schedule-to-start latency for the task queue, not on CPU.
  One task queue serves every tenant.
- Memory: `tofu` plans and applies are memory-hungry. The worker doc's rule of
  thumb of about 1 GiB per concurrent activity is an unmeasured guess.
- Health: read the JSON `health` log line and the pollers in Temporal's UI. There
  is no HTTP endpoint.

What happens when a worker dies mid-operation is in
[RECOVERY.md](RECOVERY.md#4-what-happens-to-an-operation-when-something-crashes).

## 7. The web / API control plane

- The Next app serves `/api/oidc/*` today. The capability broker, REST
  `/api/platform/v1`, MCP v3 and the UI for connections and approvals are in
  progress and are not described here.
- Route handlers that start or signal workflows must declare the Node runtime
  (`export const runtime = "nodejs"`); the Temporal client is a gRPC client.
- `@temporalio/client`, `@temporalio/worker`, `@electric-sql/pglite` and
  `@open-policy-agent/opa-wasm` are in `serverExternalPackages` already.
- The web app does not need the `tofu` binary, the worker variables, or
  `ZENITH_TOFU_*`.

## 8. Order of operations for a first install

1. Create the platform database; apply migrations (`npm run migrate:platform`,
   or the emitted SQL). Check with `-- --status`.
2. Generate the OIDC and control keys; store them as secrets (KMS for OIDC in
   production).
3. Deploy the web app with the variables in section 2.11; verify the two OIDC
   URLs from outside.
4. Stand up Temporal (Cloud namespace, or your cluster) and confirm the namespace
   exists.
5. Build and run the worker; confirm `execution worker ready` and pollers in
   Temporal.
6. Connect a customer account: [AWS-SETUP.md](AWS-SETUP.md). (The Zenith side of
   that step, entering the role ARNs, has no route or screen on this branch: the
   REST surface is in progress. The code path behind it is
   `AwsCredentialBroker.verifyConnection` over a `platform.provider_connections`
   row.)

## 9. What was and was not verified

Run on this machine (Windows 11, Node 24.19) while writing this page:

- `npm run migrate:platform` and `-- --status` against an empty PGlite directory
  (both migrations, `core` and `reconcile`, applied; status current) and
  `npm run platform:emit-sql -- --check`.
- `npm run policy:check`: OPA 1.19.1, 205 of 205 Rego tests pass and the committed
  bundle matches a fresh build.
- `temporal server start-dev --headless` on a spare port and `npm run worker`
  against it: the worker compiled its workflows (with the esbuild fallback, because
  the `@swc/core` native binding does not load here), reported `execution worker
  ready` and kept logging `health` with state `RUNNING`.
- The migration ledger, leases, operations and `reconcileOperations` against a
  real PostgreSQL 16.15 (see [RECOVERY.md](RECOVERY.md#8-what-was-rehearsed)).

Written but **not run by me**: the platform CI lanes in `.github/workflows/ci.yml`
(`policy`, `tofu`, `go`, `workflows`, `platform-postgres`, `ledger`,
`supply-chain`) and `.github/workflows/live-acceptance.yml`. The lane that applies
the platform migrations with the production migrator and runs the control-store
suites with `ZENITH_TEST_PLATFORM_PG_URL` set is `platform-postgres`; it targets a
bare PostgreSQL 16.15 container, so it says nothing about Supabase's role graph,
PostgREST or pooler. `live-acceptance.yml` is dispatch-only and has never been
executed (no sandbox AWS account exists); until it has, nothing is `real`.

**Not verified**, and stated once here instead of hedged everywhere:

- Anything against a real AWS account: STS `AssumeRoleWithWebIdentity`, KMS
  `Sign` and `GetPublicKey` (Ed25519 in particular), IAM accepting Zenith's
  tokens, the bootstrap template applied for real.
- Temporal Cloud and API-key authentication; mTLS (not built); a production-shaped
  self-hosted cluster.
- `docker build` of the worker image; SIGTERM handling on Linux; behaviour of the
  worker under load.
- A TLS-only Postgres (the `sslmode` note in section 2.2); the Supabase CLI
  history note in section 3.2.
- The recommendation to put `ZENITH_TOFU_PLUGIN_CACHE` on a persistent volume.
- A Vercel deployment of any of this: no Vercel build was run for these modules.
