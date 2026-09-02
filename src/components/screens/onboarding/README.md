# components/screens/onboarding — the three setup steps

One file per step (`step-workspace`, `step-provider`, `step-system`), plus the
progress `rail.tsx` and the `types.ts` the steps hand each other. Each step is
self-contained: it takes what it needs as props, reports what it settled on,
and knows nothing about the other two.

`../onboarding-flow.tsx` is the only importer — it owns which step is showing
and where a finished flow goes. Nothing is created before `step-system`'s last
button; keep it that way.
