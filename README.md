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
npm run verify   # all four, in order — this is what CI runs

npm run typecheck
npm run lint
npm test         # unit tests (engine, actions, roles, providers, store, importers)
npm run smoke    # end-to-end: blueprint → deploy → URL, chaos failure → rollback
```

All four gates run offline. **`npm run build` does not:** `app/layout.tsx`
loads its fonts through `next/font/google`, which fetches from
`fonts.googleapis.com` at build time, so a build on an air-gapped machine
fails with a font error rather than a code error. `.github/workflows/ci.yml`
therefore runs the build as a separate, non-blocking job. To make the build
offline-capable, vendor the font files and switch to `next/font/local`.

Point tests and scripts at a throwaway directory — `ORRERY_DATA=$(mktemp -d)` —
so a run never touches your working `.data/`. Orrery holds the whole database
in memory and rewrites it on save, so **one process per data directory**: a
second one is refused at boot with a message naming the pid holding it.

## Environment variables

Everything `ORRERY_*` is validated in one place, `src/lib/env.ts`; an invalid
value fails at boot naming the variable and what it accepts, rather than
silently falling back.

| Var | Purpose | Default |
| --- | --- | --- |
| `ORRERY_DATA` | data directory (JSON snapshot + JSONL event/audit logs). Relative paths resolve against the working directory, so run from the repo root. | `.data/` |
| `ORRERY_FAST` | `1` collapses simulated step durations (tests, smoke). Any other value is off. | `0` |
| `ORRERY_LOCALSTACK_ENDPOINT` | LocalStack edge endpoint the LocalStack provider talks to | `http://localhost:4566` |
| `ORRERY_LLM_MODEL` | model id for the Navigator's optional language front-end. Pin an older snapshot or try a cheaper one; the default tracks the model the grammar prompt was tested against. | `claude-opus-5` |
| `ORRERY_LOG_LEVEL` | lowest level `src/lib/log.ts` emits (`debug` \| `info` \| `warn` \| `error`) | `info` |
| `ORRERY_SECRET_KEY` | 32 bytes (base64 or hex) encrypting the secret store at `<ORRERY_DATA>/secrets.json`. Generate with `openssl rand -base64 32`. Unset means Orrery holds no secret values: every write is refused, saying so, and a manifest can still reference a value you keep elsewhere. Values written under an old key cannot be read back. | unset |
| `ORRERY_SMTP_URL` | SMTP server for **email** alert delivery channels, `smtp://user:pass@host:port` (`smtps://` for implicit TLS). Carries the password, so it is never echoed in an error, a response or a log line. Unset means an email channel records its refusal as the delivery failure, naming this variable; webhook and Slack channels need neither this nor `nodemailer`. | unset |
| `ORRERY_ALERT_FROM` | From address on alert email, e.g. `Orrery <orrery@example.com>`. Required alongside `ORRERY_SMTP_URL` — without it every send is refused, saying so. | unset |
| `AWS_ACCESS_KEY_ID` etc. | detected by the AWS preflight; **apply is disabled in Preview** either way | unset |
| `ANTHROPIC_API_KEY` | optional Navigator LLM parsing; without it the deterministic planner runs (and says so) | unset |

`NEXT_PUBLIC_SUPABASE_*` are deliberately *not* in `env.ts`: Next inlines
those into the client bundle by matching the literal `process.env.NEXT_PUBLIC_…`
text, so they must stay written out in `src/lib/supabase/env.ts`.

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

### Sign in with GitHub or Google

Optional, and off until you say otherwise. `/login` and `/signup` show a
`Continue with …` button for each provider named in
`NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS` (comma-separated; known names are
`github` and `google`). Unset — the default — means no buttons and no divider:
the pages stay email-and-password only. An unknown name is ignored with a
console warning rather than rendered, so a typo never becomes a button that
dies at the provider.

Enabling one takes three steps, in this order:

1. **Supabase dashboard → Authentication → Providers →** the provider. Turn it
   on and paste the client id and secret from the provider's own developer
   console (GitHub: Settings → Developer settings → OAuth Apps; Google: Cloud
   Console → APIs & Services → Credentials).
2. **Register the redirect URL** the provider sends the user back to. In the
   provider's console that is Supabase's own callback, shown on the same
   dashboard page (`https://<project-ref>.supabase.co/auth/v1/callback`). In
   Supabase, under **Authentication → URL Configuration**, add Orrery's
   callback — `<site>/auth/callback`, i.e. `http://localhost:3400/auth/callback`
   in development — to **Redirect URLs**, and set **Site URL** to `<site>`.
3. **Name it in `.env.local`** — `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=github,google`
   — and restart the dev server. `NEXT_PUBLIC_*` is inlined at build time, so a
   running server will not pick it up.

Signing in with a provider is still not joining. An OAuth user lands on the
same `/auth/callback`, becomes the same session, and meets the same rule below:
first real member, an invite naming their email, or an operator-set
`app_metadata.role`. Anyone else is refused by name, with the admins who can
invite them — exactly as an email user is. Their display name comes from
whatever the provider sent (`full_name`, then `name`, then `user_name`, then
`preferred_username`), falling back to the email's local part.

A refused or cancelled handshake comes back to `/login` as a *code*, never the
provider's text, and is rendered from the fixed table in
`src/components/auth/messages.ts`.

**Test accounts** (dev only — created by `npm run seed:users`):

| Email | Password | Role |
| --- | --- | --- |
| `tarun@orrery.test` | `orrery-owner-2026!` | admin |
| `claude@orrery.test` | `orrery-claude-2026!` | editor |
| `vedant@orrery.test` | `orrery-vedant-2026!` | editor |

Identity flows into the product: actions, audit entries and revisions carry the
signed-in user's name, and the header shows who you are and your role with a
way out. The first real user to sign in becomes the workspace admin. Nobody else
can join by signing up: an admin invites them by email and role under
Settings → Members (an invite is a standing permission, Orrery sends no mail),
or an operator sets `app_metadata.role` on their Supabase user. Every action
declares the role it needs and refuses below it; the interface disables those
controls first and says who can raise the role. Data still lives in the local
JSON store — Supabase provides identity only, so there are no tables and no RLS
surface yet.

## Provider honesty

| Provider | Status | Deploy | Drift & discovery | What that means |
| --- | --- | --- | --- | --- |
| Sandbox | **Available** | Simulated | Simulated, labeled | Fully working *simulated* execution. Clearly labeled; URLs serve a local preview page. Drift and discovery are deterministic simulations that show what those features look like — references it writes are prefixed `sim://` so they stay recognisable. |
| LocalStack | **Available** | Real for S3 + SQS | **Real** | AWS emulated on your machine. Buckets and queues provision for real; kinds Community cannot emulate run as labeled local simulations. Drift genuinely reads the endpoint, and reports nothing at all about the kinds it only simulated. Requires Docker + LocalStack running. |
| AWS | **Preview** | No — plan + export only | Refuses | Real deployment planning and real Terraform/OpenTofu export. Applying from Orrery is disabled until credentials support ships, and **no code path reads your account** — so drift and discovery refuse rather than return an empty, reassuring answer. Use `terraform plan` against the exported bundle. |
| Kubernetes / GCP / Azure | **Planned** | No | No | Visible in the picker, not selectable. |

Everything imported by live discovery lands as a **referenced** resource:
Orrery shows it and binds to it, but never provisions, changes or deletes it,
and it never appears in a cost estimate.

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
