# File ownership (conflict prevention)

**Rule: write ONLY inside your paths. Everything else is read-only.**
Missing dependency? List it in your final report — do not edit package.json.

| Owner | Paths |
| --- | --- |
| Integrator (spine) | `package.json`, configs, `docs/**`, `src/lib/domain/**`, `src/lib/db/**`, `src/lib/cost/**`, `src/lib/actions/core.ts`, `src/lib/providers/types.ts`, `src/lib/engine/types.ts`, `src/app/globals.css`, `src/app/layout.tsx`, `scripts/**` |
| A — Engine & providers | `src/lib/engine/**` (except types.ts), `src/lib/providers/sandbox/**`, `src/lib/providers/aws/**`, `src/lib/providers/planned.ts`, `src/lib/security/**`, `src/lib/logsim/**`, `tests/engine/**` |
| B — Actions, importers, blueprints | `src/lib/actions/defs/**`, `src/lib/importers/**`, `src/lib/blueprints/**`, `fixtures/**`, `tests/actions/**`, `tests/importers/**` |
| C — UI kit | `src/components/ui/**`, `src/lib/format.ts`, `src/components/theme/**` |
| D — API layer | `src/app/api/**`, `src/lib/server/**` |
| E1 — Core UX (wave 2) | `src/app/page.tsx`, `src/app/(product)/layout.tsx`, `src/app/(product)/p/[slug]/layout.tsx`, `src/app/(product)/p/[slug]/page.tsx`, `src/app/preview/**`, `src/components/shell/**`, `src/components/map/**`, `src/components/inspector/**`, `src/components/deploy/**`, `src/components/landing/**` |
| E2 — Screens (wave 2) | `src/app/onboarding/**`, `src/app/(auth)/**`, `src/app/(product)/overview/**`, `src/app/(product)/p/[slug]/{source,deploys,revisions,observe,security,activity,settings}/**`, `src/components/screens/**`, `src/components/auth/**` |
| F — Navigator (wave 2) | `src/lib/navigator/**`, `src/components/navigator/**`, `src/app/(product)/p/[slug]/navigator/**` |

Integrator additions: `src/lib/client/api.ts` (client data spine), `src/app/api/workspace/route.ts` (workspace bootstrap, exception in D's area).

Paths added after the table was written, all integrator-owned:
`src/lib/env.ts`, `src/lib/log.ts`, `src/lib/data-lock.ts`,
`src/lib/auth/**`, `src/lib/supabase/**`, `src/lib/secrets/**`,
`src/lib/drift/**`, `src/lib/alerts/**`, `src/lib/client/{alerts,secrets}.ts`,
`src/lib/providers/localstack/**`, `src/middleware.ts`.

Shared imports flow one way: screens → components/api → actions/engine →
domain/store. Inside `src/lib` the boundary is per file, not per directory —
see the repository shape in docs/ARCHITECTURE.md, and keep `src/` free of
static import cycles.

`tests/` mirrors `src/`. A test belongs in the directory matching the module it
exercises; whoever owns the module owns its tests.

## UI layout — where a change goes

Every directory under `src/components` has a `README.md` saying what lives
there and what must not; read that one before adding a file. The short version:

- **`components/ui/`** — the kit, and the only source of primitives. Imported
  as `@/components/ui` (the barrel), never file by file. Tokens only, no domain
  types, no knowledge of a project or an action.
- **`components/screens/`** — what more than one screen needs and the kit
  cannot own because it knows about actions, roles and changesets: `shared.tsx`
  (`ActionConfirm`, `ErrorNote`, `useRunAction`, `SectionTitle`,
  `SimulatedChip`, `RoleChip`, `ChangeRow`, `ActorDot`, `EnvDot`,
  `roleShortfall`), `project-data.ts`, `download-file.ts`. `onboarding-flow.tsx`
  orchestrates; its steps are `screens/onboarding/step-*.tsx`.
- **Area folders** — `shell/`, `map/`, `inspector/`, `deploy/`, `navigator/`,
  `auth/`, `landing/`. One area, one folder, one exported component per file,
  kebab-case filenames, `<Component>Props` exported when a sibling uses it.
  Pure logic sits beside its components in a plain `.ts` (`map/graph-model.ts`,
  `map/layout.ts`, `inspector/logic.ts`, `deploy/output-link.ts`,
  `auth/messages.ts`) so it is tested without rendering anything.
- **`src/app/**`** — a route folder holds `page.tsx`, `layout.tsx`, `route.ts`,
  `loading.tsx` / `error.tsx` and its **own** helpers only. A `page.tsx` reads
  as data hooks → derived state → layout of sections; a section, row, cell or
  dialog used by that one screen colocates beside it
  (`observe/health-strip.tsx`, `security/finding-row.tsx`, `deploys/status.ts`).
  The moment a second route needs it, it moves to `src/components/<area>/` — no
  route folder may import from another route folder.

`"use client"` goes on the component that actually uses hooks or handlers;
presentational components and pure modules carry no directive.
