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
| `@/lib/providers/types` | `ProviderAdapter`, `registerProvider`, `getProvider`, `providerRegistry`, `PreflightReport`, `StepRuntime`, `ExportBundle` |
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
- `GET  /api/environments/:id/export` → export bundle as JSON `{ files, readme }`
- `GET  /api/logs/:environmentId/:serviceId?after=SEQ` → SSE of synthetic app logs (sandbox provider generates)
- `GET  /api/preview/health/:deploymentId` → sandbox health summary

## Action catalog (workstream B implements in `src/lib/actions/defs/`)

IDs are dot-namespaced, stable, and referenced by UI + Navigator:

`project.create`, `project.importCompose`, `project.applyBlueprint`,
`system.addService`, `system.updateService`, `system.removeService`,
`system.addResource`, `system.updateResource`, `system.removeResource`,
`system.addRoute`, `system.removeRoute`, `system.bind`, `system.unbind`,
`system.setEnvVar`, `system.setSecret`,
`env.create`, `env.updatePolicies`, `env.setBudget`,
`deploy.plan` (read-only → returns Changeset), `deploy.apply`, `deploy.approve`,
`deploy.cancel`, `deploy.rollback`,
`ops.restartService`, `ops.scaleService`,
`security.resolveFinding`, `security.dismissFinding`,
`connection.create`, `connection.check`, `connection.disconnect`,
`workspace.setAutonomy`.

Rules: `deploy.apply` consults `env.policies.approvalRequired` → engine
`awaiting_approval`; destructive manifest ops set risk accordingly; every
`plan()` returns real cost deltas via `diffManifests`/pricing.

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
