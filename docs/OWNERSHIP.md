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
| E1 — Core UX (wave 2) | `src/app/page.tsx`, `src/app/(product)/layout.tsx`, `src/app/(product)/p/[slug]/layout.tsx`, `src/app/(product)/p/[slug]/page.tsx`, `src/app/preview/**`, `src/components/shell/**`, `src/components/map/**`, `src/components/inspector/**`, `src/components/deploy/**` |
| E2 — Screens (wave 2) | `src/app/onboarding/**`, `src/app/(product)/overview/**`, `src/app/(product)/p/[slug]/{source,deploys,revisions,observe,security,activity,settings}/**`, `src/components/screens/**` |
| F — Navigator (wave 2) | `src/lib/navigator/**`, `src/components/navigator/**`, `src/app/(product)/p/[slug]/navigator/**` |

Integrator additions: `src/lib/client/api.ts` (client data spine), `src/app/api/workspace/route.ts` (workspace bootstrap, exception in D's area).

Shared imports flow one way: screens → components/api → actions/engine → domain/store.
