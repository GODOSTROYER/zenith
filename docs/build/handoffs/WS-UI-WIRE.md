# WS-UI-WIRE — platform pages: render the merged components against the real API

Workstream: WS-UI-WIRE (new; orchestrator brief) — Branch ws/ui-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-ui-wire
Base: platform/integration @ e92a3df (tsc clean)

## Situation
- Presentational components are merged and tested in `src/components/platform/**` (see its
  README.md): approval-card, operation-timeline, operation-status, plan-changes-table,
  policy-decision-panel, cost-estimate-card, drift-list, resource-state-table/detail,
  investigation-view, autonomy-control, aws-connection-setup, state-badges … NOTHING renders them.
- REST exists under `/api/platform/v1`: `GET operations`, `GET operations/{id}`,
  `GET operations/{id}/events`, `POST operations/{id}/approve|reject|cancel` (approve/reject are
  browser-session only with exact Origin), `GET|PUT environments/{id}/autonomy`,
  `GET|PUT workspace/policy`, runners/machines admin lists. No REST read exists yet for resource
  state / drift / incidents.
- Product actions for AWS connections exist: `connection.createAws`, `connection.verifyAws`
  (src/lib/actions/defs/connection-aws.ts; human-only).
- Product app routes live in `src/app/(product)/**` (overview, workspace, apps, integrations, …).

## Owned paths
src/app/(product)/platform/** EXCEPT src/app/(product)/platform/placement/** (another job) ;
the product navigation component (find the one file that lists overview/workspace/apps — add one
"Platform" entry only) ; src/components/platform/** (small additive props only; do not change
existing component behaviour/tests) ; NEW read routes
src/app/api/platform/v1/environments/[id]/resources/route.ts and …/[id]/drift/route.ts (and an
incidents read route if the incident engine exposes stored investigations) ; tests for all of it
(new files; follow the repo's existing component/route test setup).
Do NOT edit src/middleware.ts, src/lib/server/**, src/lib/capabilities/** (other jobs).

## Build
1. Pages (server components where data is read, client components only for interaction):
   - Operations list (filters: status, environment) → detail page: status, timeline from events,
     plan changes + policy decision + cost, approval card with Approve/Reject that POST from the
     browser session (CSRF/Origin as the route requires), cancel.
   - Environment resources & drift: resource-state table/detail and drift list from the new read
     routes (platform store resources/observations + persisted drift from src/lib/reconcile).
   - Autonomy & policy settings: autonomy-control bound to GET/PUT autonomy; workspace policy view/edit.
   - AWS connection setup page using aws-connection-setup with the connection actions.
   - Incidents/investigations view if data is readable; otherwise an honest empty state.
2. New read routes: authorize with the broker (`authorizeRead`, matching catalog read
   capabilities — check src/lib/capabilities/catalog.ts for resource/drift read names), uniform
   not-found for foreign ids, bearer-capable like other reads, bounded output, no secrets
   (attribute names and redacted values only — reuse existing redaction).
3. Honesty: show unknown/simulated/stale states as such (components already model this); every
   evidence label stays `contract` until live; never render cloud/log text as HTML.
4. Tests: route auth/tenancy/shape; page data loaders; approve/reject posts carry no
   Authorization header and require the session; empty/error states.

## Verification
- npx tsc --noEmit ; npx eslint "src/app/(product)/platform" src/components/platform "src/app/api/platform/v1/environments" <your tests>
- npx vitest run --maxWorkers=2 <your tests> tests/components tests/capabilities (whichever exist)
- `npx next build` is NOT required (too heavy with 13 parallel jobs); the orchestrator will build.
