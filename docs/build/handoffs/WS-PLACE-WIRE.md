# WS-PLACE-WIRE — `provider: auto`: put the placement solver into the product

Workstream: WS-PLACE-WIRE (new; orchestrator brief) — Branch ws/place-wire — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-place-wire
Base: platform/integration @ e92a3df (tsc clean)

## Situation
- The solver and cost engine are merged and tested: `src/lib/placement` exports `solvePlacement`,
  `explainPlacement`, `componentsFromGraph`, `estimateGraphCost`, `loadDefaultCatalog`,
  `regionInfo`, `regionSatisfiesResidency` (see solver.ts, explain.ts, index.ts).
- A worked, tested end-to-end use exists: `scripts/acceptance/scenarios/j-multicloud-planning.ts`
  (manifest → expand → solve single-provider and cross-cloud → explain → write back → re-expand).
- Manifest V2 accepts `placement.provider: "auto"` (src/lib/resources/manifest-v2.ts:74);
  expansion only notes it (src/lib/resources/expand-context.ts:~280): NOTHING in the product calls
  the solver. A UI component exists: `src/components/platform/placement-comparison.tsx`
  (`PlacementComparison({ result, … })`).
- Capability `placement.solve` exists in src/lib/capabilities/catalog.ts (read, risk low,
  integrationScope "plan").

## Objective
A user or an agent can ask "where should this run?" for a project whose manifest says
`provider: auto` and get a ranked, explained, deterministic recommendation restricted by the
workspace's real connections; a human applies it explicitly. The solver never switches clouds by itself.

## Owned paths
src/lib/placement/recommend.ts (new; small additive exports elsewhere in src/lib/placement only if
needed) ; src/app/api/platform/v1/environments/[id]/placement/route.ts (new) ;
src/lib/actions/defs/placement.ts (new) + registering it in src/lib/actions/defs/index.ts ;
src/lib/agent-access/v3/tools/placement.ts (new) + its registration in the v3 tool index and
tests/agent-v3/golden/catalog.json ; src/app/(product)/platform/placement/** (new page) ;
tests/placement/recommend*.test.ts, tests/agent-v3/placement*.test.ts, tests/actions/placement*.test.ts (new).
Do NOT edit src/lib/resources/** (another job edits it) or other pages under src/app/(product)/platform.

## Build
1. `recommendPlacement({ workspaceId, projectId, environmentId? , constraints? })`: load the
   project's current manifest (upgrade to V2), expand it, build the solver input from the
   manifest's placement constraints (budget, residency, latency regions, zones/HA) and the
   workspace's connections: candidates are limited to providers with a verified connection;
   optionally include unconnected providers marked `requiresConnection: true`, never ranked above
   a connected one without saying so. Return the solver result, the plain-text explanation,
   per-candidate cost lines and rejected-candidate reasons. Deterministic (same input → same
   seed/candidate). Pure read: no store writes.
2. REST `POST /api/platform/v1/environments/{id}/placement` (read semantics; POST for the body):
   authorize with the broker's `authorizeRead` for `placement.solve` at project scope (see how
   other v1 routes authorize), bearer-capable. Uniform not-found for foreign ids.
3. Product action `placement.recommend` (read-only plan, no approval) and an apply path: applying
   a recommendation writes `placement.provider/regions` into the manifest through the EXISTING
   manifest-editing action path (find it in src/lib/actions/defs), as a normal reviewed change —
   never silently re-pointing an environment's connection. If the chosen provider has no
   connection, the apply is refused with a fix telling the user to connect it.
4. MCP v3 tool `zenith_recommend_placement` (read tool: authorizeRead first; untrusted_data
   envelope like the other read tools); update the golden catalog test.
5. Page `src/app/(product)/platform/placement/page.tsx` rendering `PlacementComparison` for a
   chosen project/environment, with the explanation and an "apply" control that runs the action.
6. Tests: recommend (connected-only ranking, unconnected marked, budget refusal with numbers,
   residency, determinism, no writes), route (auth, tenancy, bearer), action, MCP tool + catalog.

## Verification
- npx tsc --noEmit ; npx eslint src/lib/placement src/lib/actions/defs src/lib/agent-access/v3 "src/app/api/platform/v1/environments" "src/app/(product)/platform/placement" tests/placement tests/agent-v3 tests/actions
- npx vitest run --maxWorkers=2 tests/placement tests/agent-v3 tests/actions
