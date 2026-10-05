# Platform page wiring

The product navigation links to `/platform`. Server pages read through the
same broker facade as REST, inside `runInStoreScope`; there is no internal
HTTP request built from a Host header. The browser sends same-origin cookies
and the reviewed workspace, never a bearer token, for decisions and settings.

- `/platform`: operations, status/environment filters, cursor pagination.
- `/platform/operations/[id]`: recorded status, timeline (up to 500 events),
  digest-bound approvals/rejections, pre-execution cancellation, policy and
  the operation's persisted cost estimate.
- `/platform/environments`: active-workspace environment choices.
- `/platform/environments/[id]`: paginated resources, independent desired,
  observed and runtime state, latest persisted drift, versioned autonomy.
- `/platform/environments/[id]/incidents`: up to 20 stored investigations.
- `/platform/settings`: effective policy and versioned replacement overrides.
- `/platform/connections/aws`: save identifiers, bootstrap exact generated
  trust, then verify via `connection.createAws` / `connection.verifyAws`.
  Its small browser-only `/platform/connections/aws/action` adapter refuses
  a mismatch between the reviewed workspace and the current workspace cookie.

New bearer-capable REST reads are
`/api/platform/v1/environments/[id]/{resources,drift,incidents}`. Resources
and drift use `infrastructure.observe` (there is no dedicated drift-read
catalog entry); investigations use `incident.investigate`. Each read calls
`authorizeRead` before tenant-scoped SQL, returns contract evidence, and
never returns grants, native provider responses or raw store errors. Resources
accept `limit=1..200` (default 100) and an opaque `cursor`. Drift is bounded
to 200 findings/addresses and 100 changed fields per finding. Responses over
1 MiB fail closed. Unknown observations remain unknown, including values
withheld by redaction, so redacted strings cannot become a false match.

The 15-minute stale marker is a display heuristic, not an SLA. Refreshing
storage never claims a new cloud observation. Simulation flags and recorded
times come from storage. External strings render as text.

## Integration limit

The current operation/evidence stores expose a plan digest and summaries,
but no readable normalized `PlanView` artifact. The changes table therefore
shows its honest empty state. An approval of a plan-bound operation is
disabled until a readable matching plan is supplied; rejection is available.
The orchestrator must add an authorized, bounded artifact read contract for
the execution worker's normalized plan, bound to workspace, operation and
plan digest, before wiring it into `loadOperation` and `OperationActions`.
No plan is reconstructed from a digest or cloud state.

Missing cost estimates and investigations stay missing. AWS verification
only establishes observe-role identity; deploy permissions and worker health
remain unverified. This work has no live-cloud, real-Postgres, Temporal or
browser-preview evidence. Tests under `tests/platform-ui` exercise PGlite SQL
and the broker with explicit session/bearer identity fakes, plus jsdom UI
interactions with fake HTTP replies.

## Operator journey (PROD-UX-01)

One projection, `src/lib/platform/operator-journey.ts`, turns a platform operation,
a legacy product deployment and a signed-runbook run into the same `JourneyView`
(stage, steps, cancel availability, explicit next steps). Server pages render it
for the first paint and `_components/journey-live.tsx` re-runs the same function
on every poll of the same read endpoints, so no view can describe a state the
projection would not. `uncertain` is its own stage everywhere and always carries
next steps; a workflow deployment defers to its linked operation.

- `/platform/operations/[id]`: live progress (polite live region), exact ownership
  transfers (LIFE-12) ahead of the approval card, plan diff, digest-bound approve,
  cancel, and a reapproval alert with focus when the plan digest changes.
- `/platform/deployments/[id]`: the legacy deployment through the same projection.
- `/platform/runbooks`, `/platform/runbooks/runs/[id]`: runs, schedules, exact step
  diff against the previous version, bound approval (independent admin only),
  cancellation, uncertain steps, audit trail (MACH-03).
- `/platform/readiness`: execution-plane prerequisites per provider (editors and admins).
- Connection admin pages are built by LIFE-01; the nav links to `/platform/connections`.
