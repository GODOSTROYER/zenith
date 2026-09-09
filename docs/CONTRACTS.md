# Zenith — Contracts (READ FIRST)

What the codebase agrees on: the spine modules other code imports, the product
invariants, and the shape of each subsystem as it stands. Read it with
`docs/OWNERSHIP.md` (who owns which path) and
[docs/MODULE-MAP.md](MODULE-MAP.md) (what may import what). The spine files
listed below are the source of truth — import from them rather than
redefining what they already export.

## Spine — import, don't redefine

| Module | The exports other code builds on |
| --- | --- |
| `@/lib/domain/types` | `Manifest`, `Service`, `Resource`, `Route`, `Binding`, `Environment`, `Project`, `Revision`, `Deployment`, `DeploymentStep`, `DeploymentEvent`, `Changeset`, `SecurityFinding`, `NavigatorRun`, `Actor`, `AutonomyLevel`, zod schemas + `id()` |
| `@/lib/domain/graph` | `diffManifests(deployed, working)`, `validateManifest`, `bindingEnv`, `findNode`, `nodeName` |
| `@/lib/cost/pricing` | `monthlyCostUsd(manifest)`, `nodeMonthlyCostUsd`, `SIZE_SPECS` |
| `@/lib/db/store` | `db()`, `save(projectId?)`, `resetDb()`, `q.*` (incl. `q.revisionManifest(id)` — manifests are cold storage), `onChange(fn)`/`changed(c, projectId)` (post-save change events), `appendEvent`, `readEvents`, `appendAudit`, `readAudit` |
| `@/lib/actions/core` | `defineAction`, `runAction`, `actionRegistry`, `ActionContext`, `ActionPlan`, `ActionResult` |
| `@/lib/providers/types` | `ProviderAdapter`, `registerProvider`, `getProvider`, `providerRegistry`, `PreflightReport`, `ProviderProbe`, `StepRuntime`, `stepBudgetMs`, `ExportBundle` |
| `@/lib/env` | `env()` — validated `ORRERY_*`; `configured()` — which optional keys are present |
| `@/lib/log` | `log.{debug,info,warn,error}(message, fields)`, `withRequestId`, `currentRequestId` |
| `@/lib/data-lock` | `claimDataDir(dir)` — refuse a second process against one data directory |
| `@/lib/engine/types` | `EngineApi`, `StartDeploymentInput` |

## Global invariants (product law — violating these is a bug)

1. **One model.** UI, source view, API, agent all mutate the manifest through
   actions. No surface keeps private state about the system.
2. **Plan before apply.** Any mutation with cost or risk shows a readable
   preview (changeset / ActionPlan) before execution.
3. **Honest labels.** Provider availability (`available | preview | planned`)
   drives UI copy. Sandbox deploys are labeled simulated. Costs are labeled
   estimates.
4. **No dead controls.** Every rendered button does something or is visibly
   disabled with a tooltip saying why.
5. **Errors name their fix.** Every error string states what to do next.
6. **Notifications never cover controls.** Toasts stack bottom-left, auto-dismiss
   in 6s, and everything lands in the Activity feed. Nothing overlaps the map
   toolbar (bottom-right) or headers.
7. **Activation moment.** A successful deployment ALWAYS ends in a success
   panel with the live URL(s), copy + open buttons, health, and a suggested
   next step. URLs also live permanently on Environment → Outputs.
8. **Durable operations.** Refresh/restart never corrupts a deployment; SSE
   consumers reconnect with `?after=<seq>` and replay.
9. **Cancelled flows clean up.** Abandoning a wizard never leaves phantom
   records.
10. **Times** render local with an ISO tooltip (`title` attr), one format everywhere
   (`@/lib/format` helpers).
11. **Money** renders through `fmtUsd` (`@/lib/format`) everywhere, action plan
   text included. No second money formatter.

## How to raise an error (one rule per layer)

Invariant 5 says every error names its fix. *Where* the fix travels depends on
who is listening, and there is exactly one answer per layer:

| Layer | Shape | Built with |
| --- | --- | --- |
| API route (`src/app/api/**`) | `{ error: { message, fix? } }` + status | `throw new ApiError(msg, status, { fix })`, rendered by `errorResponse()` — both `@/lib/server/context`. `notFound(what, fix)` for 404s |
| Action `execute` (`src/lib/actions/defs/**`) | `{ ok: false, summary, error }` | return it, or throw an `Error` whose message names the fix — `runAction` catches and converts, and audits either way. The `require*` helpers in `defs/_shared.ts` are the sanctioned throwers |
| Action `plan` | `plan().blocked` — a sentence saying why, which disables the button | **return** `blocked`; never throw. `runAction` does *not* wrap `plan()`, so a throw escapes to the route as a generic 500 and the fix is lost (see docs/DEBT.md) |
| Boot / module load (`env`, `data-lock`, `secrets`, `supabase/admin`) | thrown `Error` whose message contains a `Fix:` sentence | `throw new Error(...)`. This is the only layer that may throw at import or boot time |
| Provider adapter | `PreflightReport` / `ProviderProbe` — `{ ok/reachable: false, detail, fix }` | return it. A provider reports; it does not decide the HTTP status |

Two `ApiError` classes exist on purpose: `@/lib/server/context` (thrown by
routes) and `@/lib/client/api` (raised by the browser after decoding the
envelope above). They must not be merged — the client one is in a `"use client"`
module and importing the server one would drag the store into the bundle.

## API conventions — `src/app/api/**`

Base: `/api`. JSON in/out. Errors: `{ error: { message, fix? } }` + proper status.

**Workspace resolution.** `route()` works out the caller and their current
workspace once, before the handler runs, and stashes it for the request. Every
scoped read calls `requireWorkspace()` — still synchronous and zero-argument —
so a route cannot pick a different workspace than the one the request resolved
to. The order is: the `orrery-workspace` cookie *if the caller is still a member
of it* → their first membership → `workspaces[0]` in demo mode (no auth keys) →
404 naming `/onboarding`. Server components and server actions call
`await currentWorkspace()` for the same answer. `workspaceRole(actor)` gives the
actor's role **in that workspace**; `roleOf` (actions/core) does not scope, see
docs/LIMITATIONS.md.

- `GET  /api/bootstrap` → `{ workspace, workspaces, projects, environments, deployments, connections, providers, settings, user, role, auth, members }` (single call the app shell hydrates from; providers include availability). `workspace` is the **resolved current workspace** and everything beside it is scoped to that one; `workspaces` is every workspace the caller belongs to as `{ id, name, slug, role }` — the switcher's list, and the only place the browser learns a workspace it is not in exists
- `POST /api/workspace` body `{ name }` → 201 `{ workspace }` — creates a workspace, makes the caller its admin, and selects it (sets the cookie below). Not an action: it happens before the membership an action would role-check. In demo mode (no Supabase keys) a second workspace is refused with 409 — one local user is admin of everything, so a second one is only a second name for the same permissions
- `POST /api/workspace/select` body `{ workspaceId }` → `{ workspace }` — sets the httpOnly `orrery-workspace` cookie. 403 when the caller is not a member (same answer for an id that does not exist, so ids stay non-enumerable), with a fix listing the workspaces they *are* in
- `GET|POST /api/workspace/invites`, `DELETE /api/workspace/invites/:id`, `PATCH|DELETE /api/workspace/members/:id` — admin only, and scoped to the resolved workspace on both sides: `requireAdmin` reads the caller's role *in that workspace* (`workspaceRole`, not `roleOf`), and every read filters by it
- `GET  /api/projects/:id` → `{ project, manifestHash, environments, revisions, findings, workingIssues, changesets: { [envId]: Changeset }, changesetsScopedTo? }`. `?env=<id>` computes only that environment's changeset; an unchanged payload answers `304` to `If-None-Match`. `revisions` is metadata only — manifests come one at a time from `/api/revisions/:id`
- `GET  /api/projects/:id/stream?env=ID&after=SEQ` → **SSE** of the same payload, pushed. `event: project`, `data: { etag, ...the GET body }`, `id: <seq>`; sent on connect and again whenever the store reports the project changed, at most one message per poll tick (300ms) and never twice for the same hash. Heartbeat every 15s; `Last-Event-ID` (or `?after=`) resumes the id sequence, but a snapshot stream has nothing to replay — a reconnect always gets current state. Same workspace scoping and the same 404 as the GET. Clients keep the 5s poll behind it and fall back automatically when the stream is not delivering
- `GET  /api/projects/:id/revisions?limit=50&cursor=` → `{ revisions, total, nextCursor? }` — paged revision metadata, newest first
- `GET  /api/revisions/:id` → `{ revision }` **including its manifest** — the only route that serialises one, since manifests live in cold storage (see docs/ARCHITECTURE.md ADR 1)
- `POST /api/actions/:actionId` body `{ input, mode: "plan" | "execute", scope: { projectId?, environmentId? }, idempotencyKey? }` → `{ plan? , result? }` — thin wrapper over `runAction`; actor derived from the demo session (single local user "you").
- `GET  /api/deployments/:id` → deployment snapshot
- `GET  /api/deployments/:id/events?after=SEQ` → **SSE** stream (replay then tail; heartbeat every 15s)
- `GET  /api/projects/:id/audit?limit=50` → audit feed
- `GET  /api/projects/:id/alerts?env=ID` → `{ rules, channels, kinds, events, open, recent, simulated, generatedBy, evaluatedAt, evaluationIntervalMs, delivery, emailProblem }` — `events` is open alerts first then recent closed ones, each carrying its own `deliveries: [{ channelId, at, ok, status?, error?, attempts? }]`; `kinds` is the evaluator's own catalog (title, what it watches, threshold range) so UI copy cannot drift from what is evaluated. `channels` is the **workspace's** delivery channels as metadata — the signing secret is never sent and a webhook/Slack URL is masked past its host, because that URL is itself a credential. There is deliberately no workspace-level channel route: channels ride here, so the screen that shows a delivery result can name the channel behind it. `delivery` is written from the channels that are actually enabled ("in-product only" vs. the count), and `emailProblem` is why email cannot send on this server, or `null`. **Reading evaluates**: conditions are recomputed before the response, so the page never shows a stale answer. Idempotent — a burst of readers produces one record, not one each
- `GET  /api/projects/:id/alerts/events?limit=50&cursor=&env=ID` → `{ events, nextCursor?, simulated }` — alert history, newest first; does not evaluate
- `GET  /api/environments/:id/export` → export bundle as JSON `{ files, readme }`
- `GET  /api/environments/:id/drift` → `{ simulated, observedAt, items, provider, revision }` — the deployed revision against what the provider's `observe()` finds. Read-only in the strong sense: no store write, no audit row, no cached result. Refuses rather than returning an empty list when there is nothing honest to say: 409 when the environment has never been deployed, 501 when the provider cannot read back at all, 502 when an available provider was asked and failed (LocalStack stopped). `simulated` comes straight from the adapter
- `GET  /api/connections/:id/discover?region=&projectId=` → `{ simulated, resources, alreadyReferenced, provider, region }` — resources that exist where the connection points and could be adopted. `projectId` drops what that project already references (`alreadyReferenced` counts them). Listing is not importing: nothing here touches a manifest
- `GET  /api/logs/:environmentId/:serviceId?after=SEQ` → SSE of synthetic app logs (sandbox provider generates)
- `GET  /api/preview/health/:deploymentId` → sandbox health summary
- `GET  /api/secrets?workspace=ID` → secret-store metadata (never a value)

## Action catalog — `src/lib/actions/defs/`

IDs are dot-namespaced, stable, and referenced by the UI and the Navigator:

`project.create`, `project.importCompose`, `project.applyBlueprint`,
`project.updateManifest`, `project.importResources`, `project.delete`,
`system.addService`, `system.updateService`, `system.removeService`,
`system.addResource`, `system.updateResource`, `system.removeResource`,
`system.addRoute`, `system.updateRoute`, `system.removeRoute`,
`system.bind`, `system.unbind`,
`system.setEnvVar`, `system.setSecret`, `system.rotateSecret`, `system.removeSecret`,
`env.create`, `env.updatePolicies`, `env.setBudget`,
`env.update` (rename + region), `env.clone`, `env.setConnection`, `env.delete`,
`deploy.plan` (read-only → returns Changeset), `deploy.apply`, `deploy.approve`,
`deploy.cancel`, `deploy.rollback`,
`ops.restartService`, `ops.scaleService`, `ops.investigate` (read-only, viewer),
`security.resolveFinding`, `security.dismissFinding`, `security.reopenFinding`,
`connection.create`, `connection.check`, `connection.disconnect`,
`workspace.setAutonomy`, `workspace.rename`,
`alerts.createRule`, `alerts.updateRule`, `alerts.deleteRule`, `alerts.acknowledge`,
`alerts.createChannel`, `alerts.updateChannel`, `alerts.deleteChannel`, `alerts.testChannel`.

Rules: `deploy.apply` consults `env.policies.approvalRequired` → engine
`awaiting_approval`; destructive manifest ops set risk accordingly; every
`plan()` returns real cost deltas via `diffManifests`/pricing. `project.delete`
and `env.delete` refuse while a deployment is in flight (`plan().blocked`), and
their plans say what keeps running afterwards: both delete Zenith's records,
never the infrastructure those records describe.

`project.importResources` (editor, plan-first) takes
`{ connectionId, region?, resources: DiscoveredResource[] }` and adds each one
to the working manifest as `ownership: "referenced"` with its `externalRef`,
through the normal changeset flow — so imports show as pending changes like any
other edit. Two rules are enforced in the action rather than trusted to the
caller: nothing it writes is ever `managed`, and the submitted array is a
**selection, not data** — every entry is matched by `externalRef` against a
fresh `discover()` on the server, and the provider's record is what lands in
the manifest. A reference the provider does not list is refused
(`plan().blocked`), as is a connection outside the caller's workspace. The cost
delta is always 0: a referenced resource is not Zenith's bill.

### Secrets

Zenith separates the two halves of a secret and never mixes them:

| | where it lives | who sees it |
| --- | --- | --- |
| the reference (`vault:<KEY>`) | `service.env[].secretRef` in the manifest | diffs, revisions, audit, exports, the browser |
| the value | `<ORRERY_DATA>/secrets.json`, AES-256-GCM under `ORRERY_SECRET_KEY` | this server process only |

- `system.setSecret` (editor) — `{ serviceId, key, secretValue?, secretRef?, moveExistingValue? }`.
  With `secretValue` it stores the value and writes only the reference. With
  `moveExistingValue` it takes the key's current plaintext, stores it, and swaps
  in the reference in one action — the store is written **before** the manifest
  is committed, so a failure leaves the plaintext where it was. With neither, it
  records a reference to a value you keep elsewhere.
- `system.rotateSecret` (editor) — `{ secretRef } | { serviceId, key }` plus
  `secretValue`. New value, same reference, `version + 1`. The manifest does not
  change, so this is not a manifest action and its plan describes the store.
- `system.removeSecret` (editor) — `{ serviceId, key }`. Removes the reference
  **and** the stored value; the plan says the value is unrecoverable and that
  running services keep their injected copy until redeploy.

With no `ORRERY_SECRET_KEY` the store is *not configured*: every write is
refused through `plan().blocked`, naming the variable and `openssl rand -base64
32`. It never degrades to storing plaintext, and it never accepts a value it
cannot keep. `GET /api/secrets?workspace=<id>` returns
`{ configured, reason?, fix?, secrets: [{ ref, version, createdAt, createdBy,
updatedAt, updatedBy, exists: true }] }` — metadata only. No route returns a
value; the only reader of one is the deploy path, in-process.

`requiredRole` is enforced on execute: `runAction` resolves the caller's
workspace member role and refuses anything above it, writing a `denied` row to
the audit trail with copy that names who can grant the role. Planning stays
open to every member, so anyone can see what an action would do before asking
for it. A provider that cannot really apply (AWS Preview, the Planned stubs)
refuses at plan time, before a revision is written.

### Alerts (`src/lib/alerts/`)

An `AlertRule` is a standing condition on one environment; an `AlertEvent` is
the durable record that it was true. Both live in `Database` (`alertRules`,
`alertEvents`) and are typed in `@/lib/domain/types`.

- **Four kinds**, in `ALERT_KINDS` — that record is the only definition of what
  a rule watches, its severity and its threshold range, and it ships on the
  wire so the browser never keeps a second copy: `health_degraded`,
  `deploy_failed`, `budget_exceeded` (threshold = percent of budget, default
  100), `replicas_below` (threshold = minimum ready replicas, default 1).
- **Same inputs as the screens.** Health and replicas come from `@/lib/logsim`,
  cost from `@/lib/cost/pricing`, deployment outcomes from the durable
  deployment records. An alert can never disagree with the health card above it.
- **Derived, not remembered.** `evaluateRule` reads; only the event log is
  stored, so a restart re-derives the same answer. No engine hook is needed —
  a terminal deployment status is already a durable record.
- **One open event per rule**, closed when the condition clears, when the rule
  is disabled, or when it is deleted (with the reason on the event). Events
  outlive their rule: deleting a rule keeps its history.
- **Evaluated** every `EVALUATION_INTERVAL_MS` (15s) by an `unref`'d timer
  started in `boot()`, which returns immediately when no rules exist and saves
  only when the log changed; and again on every read of the alerts route.
- **Acknowledging is editor-level** and does not close an alert — it records
  that a named person has seen it, so the shared record says somebody is on it.

#### Delivery channels (`src/lib/alerts/channels.ts`, `deliver.ts`)

An `AlertChannel` is **per workspace**, stored additively on
`db().settings.alertChannels` (`settings` is `Record<string, unknown>`, so no
`Database` change):
`{ id, workspaceId, kind: "webhook" | "slack" | "email", name, target, secret?,
enabled, createdBy, createdAt, lastDelivery? }`. `AlertRule.channelIds?` selects
them: **unset = every enabled channel**, `[]` = deliver nowhere (on screen
only), and a disabled channel is skipped either way.

- **webhook** — `POST` of
  `{ source: "orrery", event: "alert.fired" | "alert.resolved" | "alert.test",
  sentAt, text, alert: { id, ruleId, projectId, environmentId, severity,
  simulated, summary, detail, firedAt, resolvedAt?, resolvedReason? } }`.
  With a secret, `X-Orrery-Signature: sha256=<hex>` is an HMAC-SHA256 over the
  **exact bytes posted** (the body is built once so the two can never diverge).
  `X-Orrery-Event` carries the same event name, and
  `X-Orrery-Idempotency-Key` carries `orrery-<transition>-<eventId>-<channelId>`
  — **stable across every retry of that transition to that channel**, including
  a retry after this server restarted mid-send. The body is not: `sentAt`
  changes per attempt, and so therefore does the signature. A receiver that
  stores the key can drop the duplicate; one that does not may see the same
  notification twice after a crash.
- **slack** — Slack's incoming-webhook payload: `text` (the notification line)
  plus `blocks` — a `section` with mrkdwn, then a `context` line carrying
  severity/close reason and the `simulated` note.
- **email** — SMTP through `nodemailer`, `ORRERY_SMTP_URL` +
  `ORRERY_ALERT_FROM`. The package is imported at send time through a
  non-literal specifier, so `tsc` passes without it and a workspace with no
  email channel never needs it; a missing package or variable is reported as
  the delivery failure, naming `npm install` or the variable.
- **Retry** — `DELIVERY_ATTEMPTS` (3) with backoff (1s, 4s; collapsed by
  `ORRERY_FAST`), `DELIVERY_TIMEOUT_MS` (10s) per attempt via
  `AbortSignal.timeout`. A 4xx that is not 429 is permanent and is not retried:
  a wrong URL fails the same way three times.
- **Recorded, never silent** — every result lands on `AlertEvent.deliveries`
  and on `AlertChannel.lastDelivery`. `deliveries: []` means "Zenith tried and
  had nowhere to send"; absent means the alert predates channels. The Observe
  screen writes a different sentence for each, and for a failure it shows the
  reason.
- **Durable, and never blocking** — `queueDelivery` writes one
  `AlertOutboxEntry` per selected channel into `db().alertOutbox` **in the same
  save as the event transition**, then returns; the outbox drains on a
  microtask. A row is claimed (`pending` → `sending`, `claimedAt`, flushed to
  disk) *before* the network call and settled (`delivered` / `failed`,
  `settledAt`, `attempts`, `error`/`httpStatus`, flushed) after it, so a crash
  loses nothing: `boot()` schedules `replayOutbox()` right after
  `claimDataDir()` — unref'd, never awaited — which reclaims rows left
  `sending` by the dead process (`OUTBOX_LEASE_MS`, and everything at boot,
  where the data-dir claim proves no other writer exists) and drains what is
  still pending. Every terminal outcome also lands on `AlertEvent.deliveries`,
  once, so the screens keep telling the truth. `resolveOpen` is the single
  choke point for every close, so a rule that is disabled or deleted still
  closes the alert at the receiver. `flushDeliveries()` is for tests and
  scripts.
- **Actions** — `alerts.createChannel` `{ kind, name, target, secret?, enabled? }`,
  `alerts.updateChannel` `{ channelId, name?, target?, secret?, enabled? }`,
  `alerts.deleteChannel` `{ channelId }` — all **admin**, because a channel is
  workspace-wide and its target is where this server's alerts go; and
  `alerts.testChannel` `{ channelId }` — **editor**, one labelled message down
  the same path, result recorded either way. `alerts.createRule` /
  `alerts.updateRule` take `channelIds` (update accepts `null` to go back to
  every enabled channel). Every channel plan states exactly what will be sent
  where and that the secret — or the Slack URL, which *is* the credential — is
  held in plain text in this server's state file.

### `probe()` — optional reachability

`ProviderAdapter.probe?(): Promise<ProviderProbe>` answers one question:
*could a deploy to this provider start right now?* It takes no connection and
no credentials, so surfaces that offer a provider **before** a connection
exists can call it — onboarding's "Available now" list above all, which today
offers LocalStack whether or not Docker is running.

```ts
const probe = await getProvider("localstack").probe?.();
// { reachable: false, detail: "LocalStack is not reachable. Nothing answered
//   at http://localhost:4566/_localstack/health (…).", fix: "Start Docker
//   Desktop, then run `localstack start`…" }
```

Rules:

- **Safe to call on render.** No writes, one request, its own short timeout
  (LocalStack: a single GET against the health endpoint, 2.5s).
- **`fix` is present whenever `reachable` is false**, and names the command.
- **Optional, and its absence is meaningful.** A provider omits `probe` when
  nothing local can be down: the sandbox runs in-process, and AWS Preview only
  plans and exports. `undefined` means "nothing to check", never "unknown".
- **It does not override `availability`**, which remains the single source of
  truth for whether a provider is *selectable*. A probe only reports whether an
  already-available provider is usable at this moment.

Implemented today by LocalStack (`src/lib/providers/localstack/index.ts`),
which reuses the same health check as `preflight` and distinguishes
unreachable / timeout / unhealthy-HTTP / not-LocalStack rather than reporting
all four as "not reachable".

### `observe()` / `discover()` — reading back what is there

Two optional, strictly read-only additions to `ProviderAdapter`. They are what
drift and live-resource import are built on:

```ts
observe?(env: Environment, deployed: Manifest): Promise<LiveState>;
discover?(conn: CloudConnection, region?: string): Promise<Discovery>;

interface LiveResource { nodeId: string; kind: string; exists: boolean;
                         attributes: Record<string, string|number|boolean>; observedAt: string }
interface LiveState  { simulated: boolean; observedAt: string; resources: LiveResource[] }
interface DiscoveredResource { externalRef: string; kind: ResourceKind; name: string;
                               attributes: Record<string, string|number|boolean> }
interface Discovery  { simulated: boolean; resources: DiscoveredResource[] }
```

Rules:

- **`attributes` holds only what the provider actually inspected.** Drift
  compares the *intersection* of observed keys with what the manifest expects,
  so an adapter that cannot see a field never produces drift on it. Silence
  means "not looked at", never "matches" — which is why LocalStack omits the
  kinds it merely simulated rather than reporting them present and correct.
- **`nodeId: ""` means "found, and the deployed revision does not own it"** →
  an `extra` drift item.
- **`simulated` belongs to the call, not the row.** That is why both results are
  wrapped rather than bare arrays: an empty result still has to be able to say
  which kind of nothing it is.
- **Optional, and absence is meaningful** — the same rule as `probe()`. A
  Planned provider omits both. AWS Preview *implements* both and refuses, because
  "reading your account is deliberately not wired up" is a different statement
  from "not built yet" (`AWS_NO_READ_MESSAGE`, `src/lib/providers/aws/index.ts`).
- **Never mutate.** Neither method may create, change or delete anything.

Drift itself is pure and lives in `src/lib/drift/`: `computeDrift(deployed,
live)` returns `missing` / `changed` / `extra` items with a severity, worst
first. Secret-backed env vars are never compared — Zenith does not hold the
value it would compare against. Nodes that are not `managed` are skipped
entirely: Zenith reads a referenced resource and never reconciles it.

Implemented by: **sandbox** (deterministic seeded simulation — one resource a
size up, one plain env var altered, the same every call for a given
environment), **LocalStack** (real: `ListBuckets` + `ListQueues` against the
edge endpoint, by the names the adapter provisions), **AWS Preview** (refuses).

## Engine contract — `src/lib/engine/engine.ts`

Implements `EngineApi` from `@/lib/engine/types`, exported as `engine`.
Ticker: `setInterval` 250ms held on `globalThis`, started lazily; each tick
advances at most one running step per deployment using the provider's
`executeStep`. Sandbox speed: env `ORRERY_FAST=1` collapses `estMs` to ≤40ms
(smoke tests). Emit every transition via `appendEvent` with a per-deployment
monotonically increasing `seq` (store the counter on the deployment record).
Verification phase performs health checks (sandbox: synthetic, honest —
health shown = health computed). On step failure: deployment → `failed`,
remaining steps → `skipped`, and if the environment had a previous revision,
offer rollback (the UI + `deploy.rollback` action do the rest).

## Sandbox provider — `src/lib/providers/sandbox/`

Availability `available`, tagline says simulated. Realistic step plans per
node kind (prepare → provision → release → verify), jittered durations
totaling 8–20s per deploy (or fast mode), provider-stream log lines that look
like real infra output without impersonating AWS. URLs:
`https://{service}--{env}.{project}.orrery.app` — but the Output's `value`
must be a real clickable local path: `/preview/{deploymentId}/{serviceId}`
(the UI renders it as the pretty hostname with the local href). Failure
injection: any service with env var `ORRERY_CHAOS=fail_once` fails its release
step on the first attempt (used by the failure-recovery path).

## AWS provider — `src/lib/providers/aws/`

Availability `preview`. `planSteps` returns a real, honest plan (ECS/Fargate-
shaped) but `executeStep` throws
`"AWS execution requires credentials. Zenith Preview generates and exports the
full Terraform for this system — run it with your own tooling, or connect
credentials in a later release."`
`exportBundle` generates REAL, valid Terraform/OpenTofu HCL: VPC-referencing
variables, ECS services, RDS, S3, SQS, ALB + Route53 + ACM per manifest, plus
`terraform.tfvars.example` and a README explaining how to operate without
Zenith. This is the no-lock-in guarantee and must be genuinely usable.

## UI kit — `src/components/ui/`

Exported from individual files as named exports, client components where
needed:
`Button` (variants: primary/quiet/ghost/danger; sizes sm/md; `busy` prop),
`Chip`, `StatusDot` (status: ok/warn/err/info/idle/running; `pulse`),
`Card`, `Drawer` (right side, focus-trapped, ESC), `Dialog`, `Tabs`,
`Tooltip`, `Kbd`, `Meter`, `Sparkline`, `CodeBlock` (mono, copy button),
`EmptyState` (icon, title, body, action), `Skeleton`, `Toast` system
(`useToasts()` + `<Toaster/>`, bottom-left, auto-dismiss, feeds Activity),
`SegmentedControl`, `Field` (label + control + help + error), `Input`,
`Select`, `Switch`, `CostDelta` (renders +/− USD with color + tnum),
`RiskBadge`, `TimeAgo` (local + ISO title), `CopyButton`, `PhaseTimeline`
(deployment phases/steps), `LogViewer` (auto-follow, stream toggle),
`ThemeToggle` (persists `orrery-theme`, default dark).
Also `src/lib/format.ts`: `fmtUsd`, `fmtDate`, `timeAgo`, `cx` (clsx re-export).
Style: tokens only, refined hairlines, generous spacing, no glassmorphism.

## Screens — `src/app/(product)/`

Routes:
- `/` product entry → redirects to `/overview` when a workspace exists, else onboarding
- `/onboarding` guided 3-step: name workspace → pick provider (honest labels) → pick blueprint/import → creates project, lands on map
- `/overview` workspace home: project cards (health, cost, env chips)
- `/p/[slug]` **System Map** (the centerpiece) + right Inspector + bottom dock (Changes drawer)
- `/p/[slug]/source` read/edit manifest JSON (CodeBlock editor + validation panel; error boundary — an editor crash never whitescreens the app)
- `/p/[slug]/deploys` deployment timeline + detail (PhaseTimeline, logs, outputs)
- `/p/[slug]/revisions` list + diff any two + rollback
- `/p/[slug]/observe` logs + health + cost per environment
- `/p/[slug]/security` findings with one-click fixes
- `/p/[slug]/activity` audit feed
- `/p/[slug]/settings` environments, policies, budgets, export, danger zone
- `/p/[slug]/navigator` — agent surface
- `/preview/[deploymentId]/[serviceId]` sandbox "your app is live" page

System Map: computed strata layout (Edge → Services → Data, left to right,
dagre), no free dragging that implies false facts; nodes show status dot +
name + kind + cost; edges = bindings with capability labels; selecting opens
Inspector; all edits go through actions; pending (undeployed) diffs render
as ghosted/dashed treatments with a persistent "N pending changes — Review"
pill (top center) opening the Changes drawer: items, explanations, cost
delta, projected monthly, warnings, then Deploy → live progress → success
panel with URL (the activation moment).

## Navigator — `src/lib/navigator/` + `src/components/navigator/`

Deterministic planner v1 (no LLM dependency; if `ANTHROPIC_API_KEY` exists a
`llm` mode may enhance parsing, else label "deterministic planner"). Parses
goals like "add a postgres and connect it to api, set a $100 budget, deploy
to staging" into NavigatorStep[] of registered actions with rationale + risk
+ needsApproval; persists NavigatorRun; executes via `runAction` respecting
autonomy; UI shows plan → approvals → execution progress → summary; autonomy
dial (5 levels) writes `workspace.setAutonomy`; every step lands in audit.
