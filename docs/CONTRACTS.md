# Orrery — Implementation contracts (READ FIRST)

Every workstream reads this file plus `docs/OWNERSHIP.md` before writing code.
The spine files listed below are the source of truth. **Import from them; never
edit them; never edit `package.json`** (list missing deps in your final report).

## Spine (already implemented — import, don't redefine)

| Module | Exports you build on |
| --- | --- |
| `@/lib/domain/types` | `Manifest`, `Service`, `Resource`, `Route`, `Binding`, `Environment`, `Project`, `Revision`, `Deployment`, `DeploymentStep`, `DeploymentEvent`, `Changeset`, `SecurityFinding`, `NavigatorRun`, `Actor`, `AutonomyLevel`, zod schemas + `id()` |
| `@/lib/domain/graph` | `diffManifests(deployed, working)`, `validateManifest`, `bindingEnv`, `findNode`, `nodeName` |
| `@/lib/cost/pricing` | `monthlyCostUsd(manifest)`, `nodeMonthlyCostUsd`, `SIZE_SPECS` |
| `@/lib/db/store` | `db()`, `save()`, `resetDb()`, `q.*`, `appendEvent`, `readEvents`, `appendAudit`, `readAudit` |
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
   (`@/lib/format` helpers from workstream C).

## API conventions (workstream D implements)

Base: `/api`. JSON in/out. Errors: `{ error: { message, fix? } }` + proper status.

- `GET  /api/bootstrap` → `{ workspace, projects, connections, providers, settings }` (single call the app shell hydrates from; providers include availability)
- `GET  /api/projects/:id` → `{ project, environments, revisions, findings, workingIssues, changesets: { [envId]: Changeset } }`
- `POST /api/actions/:actionId` body `{ input, mode: "plan" | "execute", scope: { projectId?, environmentId? }, idempotencyKey? }` → `{ plan? , result? }` — thin wrapper over `runAction`; actor derived from the demo session (single local user "you").
- `GET  /api/deployments/:id` → deployment snapshot
- `GET  /api/deployments/:id/events?after=SEQ` → **SSE** stream (replay then tail; heartbeat every 15s)
- `GET  /api/projects/:id/audit?limit=50` → audit feed
- `GET  /api/projects/:id/alerts?env=ID` → `{ rules, kinds, events, open, recent, simulated, generatedBy, evaluatedAt, evaluationIntervalMs, delivery }` — `events` is open alerts first then recent closed ones; `kinds` is the evaluator's own catalog (title, what it watches, threshold range) so UI copy cannot drift from what is evaluated. **Reading evaluates**: conditions are recomputed before the response, so the page never shows a stale answer. Idempotent — a burst of readers produces one record, not one each
- `GET  /api/projects/:id/alerts/events?limit=50&cursor=&env=ID` → `{ events, nextCursor?, simulated }` — alert history, newest first; does not evaluate
- `GET  /api/environments/:id/export` → export bundle as JSON `{ files, readme }`
- `GET  /api/logs/:environmentId/:serviceId?after=SEQ` → SSE of synthetic app logs (sandbox provider generates)
- `GET  /api/preview/health/:deploymentId` → sandbox health summary
- `GET  /api/secrets?workspace=ID` → secret-store metadata (never a value)

## Action catalog (workstream B implements in `src/lib/actions/defs/`)

IDs are dot-namespaced, stable, and referenced by UI + Navigator:

`project.create`, `project.importCompose`, `project.applyBlueprint`,
`project.updateManifest`, `project.delete`,
`system.addService`, `system.updateService`, `system.removeService`,
`system.addResource`, `system.updateResource`, `system.removeResource`,
`system.addRoute`, `system.updateRoute`, `system.removeRoute`,
`system.bind`, `system.unbind`,
`system.setEnvVar`, `system.setSecret`, `system.rotateSecret`, `system.removeSecret`,
`env.create`, `env.updatePolicies`, `env.setBudget`,
`env.update` (rename + region), `env.clone`, `env.setConnection`, `env.delete`,
`deploy.plan` (read-only → returns Changeset), `deploy.apply`, `deploy.approve`,
`deploy.cancel`, `deploy.rollback`,
`ops.restartService`, `ops.scaleService`,
`security.resolveFinding`, `security.dismissFinding`, `security.reopenFinding`,
`connection.create`, `connection.check`, `connection.disconnect`,
`workspace.setAutonomy`, `workspace.rename`,
`alerts.createRule`, `alerts.updateRule`, `alerts.deleteRule`, `alerts.acknowledge`.

Rules: `deploy.apply` consults `env.policies.approvalRequired` → engine
`awaiting_approval`; destructive manifest ops set risk accordingly; every
`plan()` returns real cost deltas via `diffManifests`/pricing. `project.delete`
and `env.delete` refuse while a deployment is in flight (`plan().blocked`), and
their plans say what keeps running afterwards: both delete Orrery's records,
never the infrastructure those records describe.

### Secrets

Orrery separates the two halves of a secret and never mixes them:

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
- **Delivery is in-product only.** There is no email, Slack or webhook path.
  `useProjectAlerts` from `@/lib/client/alerts` is the delivery channel; every
  plan and empty state says so. See docs/LIMITATIONS.md.
- **Acknowledging is editor-level** and does not close an alert — it records
  that a named person has seen it, so the shared record says somebody is on it.

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

## Engine contract (workstream A implements `src/lib/engine/engine.ts`)

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

## Sandbox provider (workstream A, `src/lib/providers/sandbox/`)

Availability `available`, tagline says simulated. Realistic step plans per
node kind (prepare → provision → release → verify), jittered durations
totaling 8–20s per deploy (or fast mode), provider-stream log lines that look
like real infra output without impersonating AWS. URLs:
`https://{service}--{env}.{project}.orrery.app` — but the Output's `value`
must be a real clickable local path: `/preview/{deploymentId}/{serviceId}`
(the UI renders it as the pretty hostname with the local href). Failure
injection: any service with env var `ORRERY_CHAOS=fail_once` fails its release
step on the first attempt (used by the failure-recovery path).

## AWS provider (workstream A, `src/lib/providers/aws/`)

Availability `preview`. `planSteps` returns a real, honest plan (ECS/Fargate-
shaped) but `executeStep` throws
`"AWS execution requires credentials. Orrery Preview generates and exports the
full Terraform for this system — run it with your own tooling, or connect
credentials in a later release."`
`exportBundle` generates REAL, valid Terraform/OpenTofu HCL: VPC-referencing
variables, ECS services, RDS, S3, SQS, ALB + Route53 + ACM per manifest, plus
`terraform.tfvars.example` and a README explaining how to operate without
Orrery. This is the no-lock-in guarantee and must be genuinely usable.

## UI kit (workstream C, `src/components/ui/`)

Export from individual files, named exports, client components where needed:
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

## Screens (workstream E, wave 2 — `src/app/(product)/`)

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
- `/p/[slug]/navigator` (workstream F) — agent surface
- `/preview/[deploymentId]/[serviceId]` sandbox "your app is live" page

System Map: computed strata layout (Edge → Services → Data, left to right,
dagre), no free dragging that implies false facts; nodes show status dot +
name + kind + cost; edges = bindings with capability labels; selecting opens
Inspector; all edits go through actions; pending (undeployed) diffs render
as ghosted/dashed treatments with a persistent "N pending changes — Review"
pill (top center) opening the Changes drawer: items, explanations, cost
delta, projected monthly, warnings, then Deploy → live progress → success
panel with URL (the activation moment).

## Navigator (workstream F, wave 2 — `src/lib/navigator/` + `src/components/navigator/`)

Deterministic planner v1 (no LLM dependency; if `ANTHROPIC_API_KEY` exists a
`llm` mode may enhance parsing, else label "deterministic planner"). Parses
goals like "add a postgres and connect it to api, set a $100 budget, deploy
to staging" into NavigatorStep[] of registered actions with rationale + risk
+ needsApproval; persists NavigatorRun; executes via `runAction` respecting
autonomy; UI shows plan → approvals → execution progress → summary; autonomy
dial (5 levels) writes `workspace.setAutonomy`; every step lands in audit.
