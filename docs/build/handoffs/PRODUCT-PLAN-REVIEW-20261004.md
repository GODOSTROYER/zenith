# Product deployment approval, native plan review

The product progress panel and deployment history previously sent
`deploy.approve` with only a deployment ID at every approval gate. A concrete
native plan requires the digest the human reviewed. The broker correctly
refused these product requests, leaving the ordinary product control unable to
clear the worker's plan gate.

Both views now read routing metadata from the existing authenticated operation
detail endpoint. They send the selected workspace in the read URL and require
the returned operation ID, workspace, project, environment and immutable
deployment/revision association to match the current product deployment. The
proposal's scope must agree too. The endpoint and broker continue to enforce
current identity and tenant access.

A confirmed, unbound native round-zero proposal keeps the existing product
approval/startup action. A later approval round or bound plan leads to
`/platform/operations/[id]`, where the existing PlanView and ApprovalCard show
the review and submit its exact digest. This product change does not submit a
plan digest or approve a native plan. It does not infer an approval round from
`workflowStartedAt`, and no source or plan values are rendered in the product
approval controls.

Unavailable reads, absent round metadata and mismatched associations offer an
explicit reload without a product approval fallback. A workflow without an
operation ID is also unavailable. Only a deployment without a native operation
and without a workflow executor keeps the legacy approval path. Cancellation
and rollback retain their existing server-authorized actions.

The read is active only for the current awaiting deployment. Every render checks
the current operation, deployment, revision and workspace association, so a
retained response cannot restore a previous deployment's approval control. An
open initial approval confirmation is removed when the native operation advances
to its plan round. Selecting another deployment clears its prior confirmation,
step selection and buffered logs; the detail view ignores another deployment's
stream events. The existing API client's cancellation and disposal behavior owns
the read lifecycle.

Owned source consists of the two product components, the new shared read-only
routing hook, the existing deployment-inspection fixture's URL-aware read stub,
the new product-plan review component suite and this handoff. The frozen packet
contains their before/after fingerprints and the exact incremental patch. No
other prepared source is changed.

The new suite renders both actual product components over modeled read results.
It covers round-zero startup, later plan routing with and without a workflow
start acknowledgment, bound round-zero plans, legacy approval, missing/failed/
loading reads, invalid rounds, foreign native and proposal scopes, mismatched
deployment/revision associations, changed deployments and workspaces, viewer
navigation, and a confirmation whose native round changes. It checks that
metadata canaries and digests are not rendered. The action runners and read
results are explicit test ports; these controls do not prove real browser
authentication, PostgreSQL persistence or Temporal execution.

No tests, compiler, lint, services, database, Docker or cloud calls were executed
while authoring this packet. Root must independently review and run the source.
Suggested affected checks, with the repository's configured dependencies, are:

```sh
npm test -- tests/screens/product-plan-review.test.tsx tests/screens/deploy-uncertainty.test.tsx tests/screens/deploy-history-page.test.tsx tests/bridge/deploy-bridge.test.ts tests/actions/deploy-approve-separation.test.ts tests/screens/platform/approval-card.test.tsx --no-file-parallelism
```

Root also owns the exact-source compiler and authentic browser/API journey. The
existing native platform page must retain the reviewed PlanView and real round
metadata, and its guarded decision endpoint must refuse stale, foreign,
unavailable and unreviewed plan requests. Those paths are outside this packet.

The independently reported worker fence-binding gap and MCP/CLI admission,
projection and review-URL gaps remain separate owner work. No custody guard,
capability audience, broker decision, startup API or controller is changed here.
