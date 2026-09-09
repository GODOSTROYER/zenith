# Running Zenith

Three ways, in increasing order of setup: **local dev** (no Docker), **local dev
plus LocalStack** (real S3 and SQS), and **everything in containers**.

If anything below does not behave, run `npm run doctor` first — it reports what
is configured, what is reachable, and the fix for each thing that is not.

---

## 1. Local development

```bash
npm install
npm run setup
npm run dev
```

Open <http://localhost:3400>.

`npm run setup` is safe to re-run. It checks Node and Docker (reporting, never
requiring), copies `.env.local.example` to `.env.local` if you do not have one,
seeds the "Kepler Labs" demo workspace when the data directory is empty, and
prints the commands that make sense for *your* machine.

With no keys configured, Zenith runs in **local demo mode**: one local user who
is admin of everything, no sign-in. That is a complete, working install — every
deployment path works against the built-in sandbox provider.

| Command | What it does |
| --- | --- |
| `npm run dev` | Turbopack dev server on 3400 |
| `npm run dev:webpack` | Original webpack dev server as a compatibility fallback |
| `npm run setup` | First-run setup, idempotent |
| `npm run doctor` | Configuration and reachability report |
| `npm run seed` | Reset to the demo workspace (**wipes the data directory**) |
| `npm run verify` | typecheck + lint + tests + smoke + Gimbal asset verification |
| `npm run build && npm start` | Production build, then serve it on 3400 |

Development routes compile on first use; production builds compile all routes
ahead of time. `npm run dev` uses the stable development Turbopack support in
Next 15.5.24. Production builds continue using webpack. Stop the current server
before switching bundlers or running a production build: both use `.next`.

The provider SDKs load as server-only Node dependencies rather than being
bundled into every route. Tailwind scans `src`, and TypeScript excludes scratch
data/app copies. Fonts are bundled locally with their licenses, so compilation
does not fetch Google Fonts. JSON polling waits for each response to finish,
shares pending reads, and backs off on unchanged data; a slow compile cannot
build up overlapping polls.

Screens import UI primitives directly from `components/ui/<component>` to keep
unrelated client components out of each route's server graph. The action catalog
travels with the existing bootstrap response; the product layout no longer
imports execution handlers. Navigator loads its execution runtime on mutation,
and its model name arrives with the page instead of a second server action.
The 3D character and System Map render only in the browser; map inspectors,
import dialogs and export panels load when requested. Loading boundaries reuse
the existing skeleton primitives while the next route resolves.

These changes reduce compilation work; they do not remove Next's first-use
compilation in development. Compare cold routes with a stopped server and a
fresh build directory, in the same order and with the same data. Warm navigation
and production serving should be measured separately from cold development.

On Windows, run production builds in the actual project directory. Do not build
a scratch app whose `node_modules` is a junction to this project: Next 15.3.3
can reproduce that junction in standalone output, then follow it while cleaning
the output on a later build. Use separate installed dependencies for a scratch
production build. The normal project uses a real `node_modules` directory.

---

## 2. With LocalStack (real S3 and SQS)

LocalStack is optional. It exists so a deployment provisions *something real*
without touching a cloud account.

```bash
npm run localstack:up     # docker compose up -d localstack
npm run dev
```

Then in Zenith, create a connection with the **LocalStack** provider and deploy
to it.

`npm run localstack:down` stops the container (`localstack:up` restarts it in
seconds); `npm run localstack:logs` tails it.

### What LocalStack actually exercises

Be precise about this, because Zenith is:

| Resource kind | On LocalStack |
| --- | --- |
| Object store (S3 bucket) | **Real.** `s3:CreateBucket`, verified with `HeadBucket`, listed back by drift detection. Removing it from the manifest really runs `s3:DeleteBucket` — and refuses if the bucket still holds objects, unless the environment allows stateful deletion |
| Queue (SQS) | **Real.** `sqs:CreateQueue`, real queue URL recorded as an output. Removing it really runs `sqs:DeleteQueue` — and refuses while messages are still in the queue, unless the environment allows stateful deletion |
| Postgres, Redis, containers, load balancers, DNS, email | **Simulated locally.** LocalStack Community has no RDS/ElastiCache/ECS/ALB, so those steps run as *labeled* local simulations — the step title says so, and drift reports them as "not looked at" rather than claiming they are healthy. Removing one is labelled the same way: the step says nothing was created to delete |

The exported Terraform bundle provisions all of it for real on AWS. Switching
targets is one step: delete `providers_override.tf` and supply real credentials.

The compose file enables exactly `SERVICES=s3,sqs`, because those are the only
two the adapter provisions for real.

**LocalStack Community does not persist data across a container restart**
(`PERSISTENCE` is a Pro feature). The named volume is a warm cache, not durable
storage — after `localstack:down && localstack:up`, re-deploy the environment.

### Pointing at a different LocalStack

`ORRERY_LOCALSTACK_ENDPOINT` (default `http://localhost:4566`). Set it in
`.env.local` if you run LocalStack elsewhere or on another port. The app
container gets `http://localstack:4566` automatically over the compose network.

---

## 3. Everything in containers

> `docker-compose.yml` is the **development** topology (LocalStack + one app container). The hosted control topology — one persistent process per `/data` volume, wildcard app domain, backups — is `docs/hosted/RUNBOOK-DEPLOY.md`. The latest GitHub CI run built the image even though the local Docker daemon on the development machine is unavailable.

```bash
cp .env.local .env          # or start from .env.local.example
docker compose --profile app up --build
```

Or via npm: `npm run docker:build`, `npm run docker:up`, `npm run docker:down`.

This starts LocalStack **and** Zenith, with the app on
<http://localhost:3400>, wired to LocalStack over the compose network, and its
data directory on a named volume at `/data`. `orrery` sits behind the `app`
profile, which is why a bare `docker compose up` starts only LocalStack.

Four things worth knowing:

- **Fonts are local.** Space Grotesk and JetBrains Mono ship in `public/fonts`
  with their licenses. `next build` does not contact Google Fonts. Installing
  npm dependencies and pulling base images still need network access unless
  those inputs are already cached.

- **`NEXT_PUBLIC_*` values are baked in at build time, and only from `.env`.**
  Next inlines them into the browser bundle when the image is built, so passing
  them at run time does nothing — the browser gets an unconfigured Supabase
  client and the app silently runs in demo mode. Compose interpolates build
  arguments from your shell or from `.env` **only**; it does not read
  `.env.local` for that. So for a container image with auth on, put
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS` and `NEXT_PUBLIC_SITE_URL` in `.env`,
  and rebuild (`npm run docker:build`) after changing any of them. Everything
  else — the `ORRERY_*` variables, `SUPABASE_SERVICE_ROLE_KEY`,
  `ANTHROPIC_API_KEY` — is read at run time from `.env` and `.env.local`, and a
  restart is enough.

- **The container starts with an empty database**, so it opens at
  `/onboarding`. The image contains the server only, not `tsx` or the seed
  scripts, so there is no `npm run seed` inside it. Either build the demo
  workspace through the UI, or seed on the host and bind-mount that directory
  in place of the named volume.

- **One process per data directory.** Never point a second container, or a host
  dev server, at the same `/data` volume: the store keeps the whole database in
  memory and rewrites it on save, so the second writer silently destroys the
  first one's work. Boot refuses to start when it detects this.

`ORRERY_PORT=3500 docker compose --profile app up` moves the host-side port if
3400 is taken.

### Verified vs unverified

`npm run build` with `output: "standalone"` is verified on this machine:
`.next/standalone/server.js` and the traced `node_modules` are produced and the
build exits 0. One caveat, under "A build copies your database" below. The
`Dockerfile` and `docker-compose.yml` are **written against Next's official
standalone example but not yet built here** — Docker Desktop on this machine is
in the stale-socket failure state described under Troubleshooting. Expect to run
`npm run docker:build` once before trusting it; CI's `docker` job builds the
image on every push.

---

## Supabase auth and test accounts

Optional. Without it, Zenith is a single local admin user and every auth surface
says so rather than breaking.

1. Put the project URL and publishable key in `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>     # server-only, for seed:users
   ```

   The legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` name is accepted too, so
   `supabase start` output can be pasted as-is.

2. Set the project's Site URL and redirect allow-list to `http://localhost:3400`
   (Authentication → URL Configuration).

3. Create the shared test accounts:

   ```bash
   npm run seed:users
   ```

   Idempotent, and it re-syncs passwords so the documented credentials always
   work. Accounts are created pre-confirmed through the admin API, which matters
   because email confirmation is on.

| Email | Password | Role |
| --- | --- | --- |
| `arnav@orrery.test` | `orrery-owner-2026!` | admin |
| `claude@orrery.test` | `orrery-claude-2026!` | editor |
| `sai@orrery.test` | `orrery-sai-2026!` | editor |

Local-only credentials for a local demo. Never point `seed:users` at a project
that has real users.

**OAuth buttons** are configuration, not a guess:
`NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS=github,google` renders those buttons, and
only after you enable each provider in the dashboard and register
`<site>/auth/callback` as its redirect URL. Empty (the default) means email and
password only. Restart the dev server after changing it — it is a
`NEXT_PUBLIC_*` value.

A local Supabase stack via `npm run supabase:start` also works
(`supabase/config.toml` is checked in, API on 54321). It needs Docker.

---

## Environment variables

Everything is optional. `npm run doctor` tells you which are set and what each
one turns on. Invalid values fail at boot with the variable name, what it
received and what it accepts — never a silent default.

| Variable | Default | Effect |
| --- | --- | --- |
| `ORRERY_DATA` | `./.data` | Data directory: snapshot, revisions, event and audit logs. One process per directory. The container sets `/data` |
| `ORRERY_FAST` | `0` | `1` collapses simulated step durations; a deploy finishes in seconds. Used by tests and smoke |
| `ORRERY_LOCALSTACK_ENDPOINT` | `http://localhost:4566` | LocalStack edge endpoint. The container gets `http://localstack:4566` |
| `ORRERY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ORRERY_LLM_MODEL` | `claude-opus-5` | Model for the Navigator's language front-end. Only used when `ANTHROPIC_API_KEY` is set |
| `ORRERY_SECRET_KEY` | *(unset)* | 32 bytes, base64 or hex (`openssl rand -base64 32`). Encrypts the secret store. Unset means every secret write is refused, saying so. **Keep the same key** — values written under an old one cannot be read back, and there is no recovery |
| `ORRERY_SMTP_URL` | *(unset)* | `smtp://user:pass@host:port` (`smtps://` for implicit TLS). Email alert delivery. Webhook and Slack channels need neither this nor the next |
| `ORRERY_ALERT_FROM` | *(unset)* | From address on alert email, e.g. `Zenith <orrery@example.com>`. Required alongside `ORRERY_SMTP_URL` |
| `NEXT_PUBLIC_SUPABASE_URL` | *(unset)* | Supabase project URL. **Build-time** |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | *(unset)* | Publishable key; `NEXT_PUBLIC_SUPABASE_ANON_KEY` also accepted. **Build-time** |
| `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS` | *(empty)* | Comma-separated: `github`, `google`. Unknown names are dropped with a console warning. **Build-time** |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3400` | Absolute origin for OpenGraph and share-card URLs. **Build-time** |
| `SUPABASE_SERVICE_ROLE_KEY` | *(unset)* | Server-only. Used by `npm run seed:users`. Never exposed to the browser |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables Claude language parsing in the Navigator. Without it the deterministic planner handles goals |
| `ORRERY_SEED_FORCE` | *(unset)* | `1` lets `npm run seed` wipe a data directory holding workspaces it did not create |
| `ORRERY_PORT` | `3400` | Read by `docker-compose.yml` only, for the host-side port. Not an application variable |

**Build-time** means Next inlines the value into the browser bundle during
`next build`. Changing one requires a rebuild (`npm run docker:build`), not a
restart.

---

## Troubleshooting

### Docker Desktop crashes on Windows with a stale socket

The symptom is Docker Desktop failing to start, or `docker version` hanging
forever, with an error naming `sailor-ingest.sock` — "the file cannot be
accessed by the system". Every `docker compose` command hangs after that.

Fix:

1. Quit Docker Desktop and kill any leftover `Docker Desktop.exe` /
   `com.docker.backend.exe` processes.
2. Rename the stale runtime directory (do not delete it, in case you need it):

   ```powershell
   Rename-Item "$env:LOCALAPPDATA\Docker\run" "run.stale.$(Get-Date -Format yyyyMMddHHmmss)"
   ```

3. Relaunch Docker Desktop. It recreates `run/` cleanly.

`npm run doctor` detects this: a `docker version` that does not answer within
six seconds is reported as a wedged daemon with this fix attached, rather than
hanging the way the CLI does. Nothing except LocalStack and the container run
needs Docker — `npm run dev` is unaffected.

### "Another Zenith process is already using the data directory"

Exactly what it says: something else holds `<ORRERY_DATA>/.orrery.lock`. Zenith
keeps the whole database in memory and rewrites it on save, so a second process
would silently overwrite the first one's writes — hence the refusal instead of a
corrupt database.

- **A dev server is already running.** Stop it, or give this process its own
  directory: `ORRERY_DATA=.data-scratch npm run dev`.
- **The pid named in the error is gone** (a hard kill or a power cut leaves the
  file behind). Boot reclaims a dead holder's lock automatically; if something
  still complains, delete `<ORRERY_DATA>/.orrery.lock`.
- **The error says the two processes ran from different directories.**
  `ORRERY_DATA` is resolved relative to the working directory when it is not
  absolute, so the same relative path from two places is two different
  databases. Use an absolute path.

`npm run doctor` prints the data directory and its current lock holder.

### Port already in use

Zenith uses **3400**. `npm run dev`, `npm start` and the container all bind it.

- Host: `next dev -p 3401` (or change the `dev` script). Note that this repo's
  screenshot tooling parks a production server on **3401**, so pick another port
  if that one is busy.
- Container: `ORRERY_PORT=3500 docker compose --profile app up`.
- **LocalStack on 4566**: `docker ps` shows what holds it. If it is something
  other than LocalStack, point `ORRERY_LOCALSTACK_ENDPOINT` elsewhere — the
  adapter detects a non-LocalStack service on that port and says so specifically
  rather than telling you to start Docker.

### Sign in returns to the login page

Password sign-in happens in the browser, but the Next.js server must also verify
the resulting session with Supabase. The browser can succeed while the server's
outbound network access is blocked. Server logs then show `[auth] Session
verification failed` with `AuthRetryableFetchError` and status `0`; the login page
explains that verification is unavailable.

Check connectivity to the configured Supabase host **from the process running
Next.js**, including its sandbox, firewall and proxy permissions. Restart that
server in a terminal with the required network access, then reload the page. A
still-valid browser session can open the workspace without another password
submission. Stop the existing server first so two processes never share the
data directory. Keep authentication configured; removing its keys does not fix
session verification.

### The dev server is slow to compile

It is, on this machine — first paint of a route can take tens of seconds while
the dev compiler works, and the Navigator and graph screens are the worst of
them. That is `next dev`, not Zenith.

**For a demo, use the production build:**

```bash
npm run build && npm start
```

Roughly three minutes to build, then every route is instant. Do this before any
recorded walkthrough or screenshot run.

`npm start` now prints `"next start" does not work with "output: standalone"
configuration`. **That is a warning, not an error** — Next serves normally after
it (only `output: "export"` actually refuses). It is Next suggesting the leaner
`node .next/standalone/server.js`, which also works. If you run the standalone
server directly, set `ORRERY_DATA` explicitly: it runs with
`.next/standalone/` as its working directory, so the default would resolve to
`.next/standalone/.data` rather than your real one.

### A build copies your database into `.next/standalone/.data` (Windows)

`src/lib/env.ts` defaults `ORRERY_DATA` to `path.join(process.cwd(), ".data")`.
Next's file tracer resolves that to a real directory, so 32 route traces list
the data directory and `next build` copies all of it — `state.json`,
`events.jsonl`, `audit.jsonl` — into `.next/standalone/.data`.

`next.config.ts` sets `outputFileTracingExcludes` to stop this, and it works on
Linux. **On Windows it silently does nothing** in Next 15.3.3:
`collect-build-traces.js` builds the exclude glob with `path.join(dir, exclude)`,
which produces backslashes that picomatch cannot match — the includes branch on
the adjacent line normalises with `.replace(/\\/g, "/")` and the excludes branch
does not. Confirmed across three builds here.

Consequences, all contained:

- **The Docker image is unaffected.** `.dockerignore` excludes `.data`, so the
  builder stage never has a data directory to trace. Docker also builds on
  Linux, where the exclude works anyway.
- `.next/` is gitignored, so nothing is committed.
- The real trap is running `node .next/standalone/server.js` **without**
  `ORRERY_DATA` set: its working directory is `.next/standalone/`, so it reads
  that frozen build-time copy instead of your live database. Always set
  `ORRERY_DATA` explicitly when running the standalone server directly, or use
  `npm start`.
- `rm -rf .next` between builds if the duplicated copy bothers you.

### Older builds fail fetching fonts

The current app serves its fonts from `public/fonts` using `src/app/fonts.css`.
If a build still reports a Google Fonts fetch error, check that it is building
the current checkout. CI treats verification, Next production build and Docker
image assembly failures as blocking workflow failures; font downloads are no
longer part of compilation. Repository rules must separately require these
checks before merging. See `hosted/CHECKPOINT.md` for current local evidence.

### Deployments fail at "Check LocalStack health"

LocalStack is not running, or not where Zenith is looking. `npm run doctor`
reports the endpoint it checked and whether `s3` and `sqs` are available.
`npm run localstack:up` starts it; `npm run localstack:logs` shows why it is
unhealthy if it started but is not answering.
