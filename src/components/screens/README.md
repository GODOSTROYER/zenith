# components/screens — screen-level building blocks

What more than one screen needs and the kit should not own, because it knows
about actions, roles and changesets: `shared.tsx` (useRunAction, ErrorNote,
ActionConfirm, SectionTitle, SimulatedChip, RoleChip, ChangeRow, ActorDot,
EnvDot, roleShortfall), `project-data.ts` (the one hook screens read the
project through), `download-file.ts`, `editor-boundary.tsx`, `export-panel.tsx`
and `import-report.tsx`. `onboarding-flow.tsx` is the onboarding orchestrator;
its steps live in `onboarding/`.

Do not put a single screen's own row, cell or dialog here — that colocates with
the route under `src/app/**`. Do not put a kit primitive here either.
