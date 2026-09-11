# components/screens — screen-level building blocks

What more than one screen needs and the kit should not own, because it knows
about actions, roles and changesets: `use-run-action.ts` (errorText,
useRunAction, useSafeToasts, Scope), `action-confirm.tsx` (ActionConfirm,
ErrorNote), `role-chip.tsx` (RoleChip, roleShortfall), `badges.tsx`
(SectionTitle, SimulatedChip, envTone, EnvDot, ActorDot, ChangeRow),
`use-async.ts` (the busy/error pair every async button hand-wrote),
`shared.tsx` (a re-export barrel over the four above — import the modules
directly in new code), `project-data.ts` (the one hook screens read the
project through), `download-file.ts`, `editor-boundary.tsx`, `export-panel.tsx`
and `import-report.tsx`. `onboarding-flow.tsx` is the onboarding orchestrator;
its steps live in `onboarding/`.

Do not put a single screen's own row, cell or dialog here — that colocates with
the route under `src/app/**`. Do not put a kit primitive here either.
