# Orrery

**A bring-your-own-cloud deployment and operations platform for small SaaS
teams. Your infrastructure, in motion.**

Orrery turns an application into a living, explained system: services,
resources, routes, and typed **bindings** in one canonical manifest that the
visual **System Map**, the **Source** view, the API, and the **Navigator**
agent all share. Every change becomes a readable plan with a cost delta
before it applies; every deploy streams durable progress, ends in an
unmissable live URL, and leaves a rollback point. Exports (manifest + real
Terraform + operations README) mean there is no lock-in.

## Run it

```bash
npm install
npm run seed     # demo workspace "Kepler Labs" with project "atlas"
npm run dev      # http://localhost:3400
```

Quality gates:

```bash
npm run typecheck
npm run lint
npm test         # unit tests (engine, actions, roles, providers, store, importers)
npm run smoke    # end-to-end: blueprint → deploy → URL, chaos failure → rollback
```

## Environment variables

| Var | Purpose | Default |
| --- | --- | --- |
| `ORRERY_DATA` | data directory (JSON snapshot + JSONL event/audit logs) | `.data/` |
| `ORRERY_FAST` | `1` collapses sandbox step durations (tests) | off |
| `AWS_ACCESS_KEY_ID` etc. | detected by the AWS preflight; **apply is disabled in Preview** either way | unset |
| `ANTHROPIC_API_KEY` | optional Navigator LLM parsing; without it the deterministic planner runs (and says so) | unset |

## Accounts (Supabase auth)

Auth is optional. With no keys, Orrery runs in **local demo mode** (one local
user, no sign-in). Add keys and the whole product requires a session.

This repo is wired to a hosted Supabase project (`orrery`, ap-south-1). Put its
keys in `.env.local` — never committed, see `.env.local.example` for the shape:

```bash
cp .env.local.example .env.local   # then paste URL + publishable key + secret key
npm run seed:users                 # creates the shared test accounts (idempotent)
npm run dev
```

Prefer to work offline? `npm run supabase:start` runs the same stack in Docker
and prints local keys for the same three variables. Nothing else changes.

Then `/login`, `/signup`, `/forgot-password` and `/reset-password` are live.
Every product route and `/api/*` requires a session (enforced in middleware);
the landing page and `/preview/*` stay public. On the hosted project, email
confirmation is on, so a new sign-up gets a link that returns through
`/auth/callback`; the seeded accounts below are pre-confirmed.

**Test accounts** (dev only — created by `npm run seed:users`):

| Email | Password | Role |
| --- | --- | --- |
| `tarun@orrery.test` | `orrery-owner-2026!` | admin |
| `claude@orrery.test` | `orrery-claude-2026!` | editor |
| `vedant@orrery.test` | `orrery-vedant-2026!` | editor |

Identity flows into the product: actions, audit entries and revisions carry the
signed-in user's name, and the header shows who you are with a way out. The
first user to sign in becomes the workspace admin. Data still lives in the local
JSON store — Supabase provides identity only, so there are no tables and no RLS
surface yet.

## Provider honesty

| Provider | Status | What that means |
| --- | --- | --- |
| Sandbox | **Available** | Fully working *simulated* execution. Clearly labeled; URLs serve a local preview page. |
| AWS | **Preview** | Real deployment planning and real Terraform/OpenTofu export. Applying from Orrery is disabled until credentials support ships. |
| Kubernetes / GCP / Azure | **Planned** | Visible in the picker, not selectable. |

## Repository shape

- `src/lib/domain` — canonical manifest model + diffing (the product's core)
- `src/lib/actions` — the typed action registry every surface calls
- `src/lib/engine` — durable deployment state machine
- `src/lib/providers` — sandbox (available), AWS (preview), planned stubs
- `src/lib/importers` / `blueprints` — compose/dockerfile/terraform import, starter systems
- `src/lib/navigator` — agent planner (deterministic v1)
- `src/app` — Next.js UI + API; `src/components` — design system
- `docs/` — thesis, architecture (Mermaid), contracts, design language, ownership, limitations

See `docs/LIMITATIONS.md` for what is real, partial, and not yet built.
