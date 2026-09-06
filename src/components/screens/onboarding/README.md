# components/screens/onboarding — the three setup steps

One file per step (`step-workspace`, `step-provider`, `step-system`), plus the
progress `rail.tsx` and the `types.ts` the steps hand each other. Each step is
self-contained: it takes what it needs as props, reports what it settled on,
and knows nothing about the other two.

`../onboarding-flow.tsx` is the only importer — it owns which step is showing
and where a finished flow goes. Workspace selection or creation is explicit in
`step-workspace`; workspace creation also establishes the local sandbox
connection. `step-provider` records a choice only. Project creation and any
additional connection creation wait for the final action in `step-system`.

The progress rail appears beside the form on desktop and above it on narrow
screens. Completion still means scoped workspace records exist; selected or
visited steps are not completion. Provider choices use the shared product
tokens, and disclose actual adapter behavior: local S3/SQS operations are real,
while LocalStack application services/routes and other emulated behavior remain
simulated. A successful connection health check is not application verification.
