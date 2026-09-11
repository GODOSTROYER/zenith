# Zenith — module map

One page for "where does this live, and what may it import?". Longer prose on
the same tree is in [docs/ARCHITECTURE.md](ARCHITECTURE.md); the per-module
export contracts are in [docs/CONTRACTS.md](CONTRACTS.md); who owns which path
is [docs/OWNERSHIP.md](OWNERSHIP.md).

Two products share one repository and one process:

- **A — infrastructure.** Manifest, actions, engine, providers. Persists to
  `.data/state.json` + JSONL logs through `src/lib/db/store.ts`.
- **B — hosted apps.** Private apps served on `<slug>.<ZENITH_APP_DOMAIN>`.
  Persists to `.data/control.sqlite` through `src/lib/hosted/authority/`.

They are deliberately separate stores. Nothing in `src/lib/hosted/authority`
writes to the JSON store, and nothing in `src/lib/db` knows the authority
exists.

---

## Layers

A module may import from its own layer and every layer above it. It may not
import from a layer below. "Layer" is a reading aid over the real rule, which
is the no-cycles invariant below.

### L0 — pure

No `node:` imports, no env, no store. Safe in the browser and at the edge.

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/domain/types.ts` | `Manifest` and every record type, their zod schemas, `id()`, `fnv1a()`, `hash32()` | zod |
| `src/lib/domain/graph.ts` | `diffManifests`, `validateManifest`, `bindingEnv`, `findNode` | `domain/types`, `cost/pricing` |
| `src/lib/domain/roles.ts` | `WorkspaceRole`, `WORKSPACE_ROLE_RANK`, `roleReaches` | nothing |
| `src/lib/cost/pricing.ts` | Estimate tables. Prices a manifest, never an account | `domain/types` |
| `src/lib/format.ts` | `fmtUsd` / `fmtDate` / `timeAgo` / `fmtDuration` / `cx` | nothing |
| `src/lib/importers/types.ts` | Importer vocabulary and the one `slugify()` / `uniqueName()` | `domain/types` |
| `src/lib/hosted/contracts/**` | Hosted types, zod schemas, error codes, host rules, tracker/source contracts. The barrel `@/lib/hosted/contracts` | zod |
| `src/lib/navigator/shared.ts` | Client-safe Navigator vocabulary — the only Navigator module the browser may import | `domain/types` |

### L1 — process facts

Reads `process.env`. Still knows nothing about persistence.

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/env.ts` | Every validated `ORRERY_*` variable | L0 |
| `src/lib/hosted/config.ts` | Every validated `ZENITH_*` variable, and `appHostname()` | L0, `env.ts` |
| `src/lib/log.ts` | One JSON object per line; request id via `AsyncLocalStorage` | L0 |
| `src/lib/data-lock.ts` | Refuse a second process against one data directory | L0, `env.ts` |
| `src/lib/hosted/digest.ts` | The one SHA-256 / tree-digest rule the hosted subsystem uses | `node:crypto` |
| `src/lib/hosted/edge.ts` | Host split in `src/middleware.ts`. Edge runtime: no `node:`, no config module | `hosted/contracts/hosts` |

### L2 — persistence

The only layer that opens a file or a database.

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/db/store.ts` | Product A's repository module: `state.json` (hot) + JSONL logs + cold revision manifests. `db()` / `save()` / `q.*` / `onChange` | L0–L1 |
| `src/lib/secrets/` | AES-256-GCM value store beside the snapshot | L0–L1 |
| `src/lib/hosted/authority/**` | Product B's control authority: one SQLite file, one connection, `tx()`, the repositories, the outbox | L0–L1 |
| `src/lib/hosted/artifacts/` | Content-addressed artifact store and the trusted pre-release verification | L0–L1, `hosted/digest` |
| `src/lib/hosted/data/**` | The per-app customer data layer (the fixed broker's storage side) | L0–L1 |

### L3 — domain services

Business rules over the stores. No `Request`, no `Response`, no route knowledge.

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/drift/` | Pure: deployed manifest vs a provider's `LiveState` | L0–L2, `providers/types` |
| `src/lib/security/rules.ts` | Findings derived from a manifest | L0–L2 |
| `src/lib/logsim/` | Deterministic synthetic logs + health for sandbox environments | L0–L2 |
| `src/lib/blueprints/` | Manifest factories | L0–L2 |
| `src/lib/importers/` | compose / dockerfile / terraform → manifest + `ImportReport` | L0–L2 |
| `src/lib/providers/types.ts` | The adapter contract and the registry — the documented spine import | L0–L2 |
| `src/lib/providers/{sandbox,localstack,aws,planned}` | The four adapters | L0–L2, `providers/types`, `drift` |
| `src/lib/engine/engine.ts` | Durable deployment state machine + 250 ms ticker | L0–L2, `providers/*` |
| `src/lib/alerts/` | Rules, workspace channels, delivery with retry | L0–L2 |
| `src/lib/hosted/access/` | Grants, invitations, exchanges, app sessions. The only authority on who may open an app | L0–L2 |
| `src/lib/hosted/build/` | The pinned recipe and the three build runners. The only place a submission is compiled | L0–L2, `hosted/source` |
| `src/lib/hosted/source/` | The untrusted-input boundary: tar reading, source validation, materialisation | L0–L2 |
| `src/lib/hosted/release/` | Apps, publish jobs, releases, rollback, suspension, the job runner | L0–L2, sibling L3 via `deps.ts` |
| `src/lib/hosted/runtime/` | `local` and `cloudflare` behind one `HostedRuntime` interface | L0–L2 |
| `src/lib/hosted/gateway/` | Admission, reserved routes, the broker surface, artifact serving, the response guard | L0–L2, siblings via `deps.ts` |
| `src/lib/hosted/quota/` | Requests per app per UTC day, body limits, the enforcement table | L0–L2 |
| `src/lib/hosted/usage/` | The usage ledger, the spending estimate, the 50/75/90 % alerts | L0–L2 |
| `src/lib/hosted/events/` | Pseudonymous activation events and the scorecard over them | L0–L2 |
| `src/lib/hosted/export/` | App export and import — the "you can leave" file | L0–L2 |
| `src/lib/hosted/backup/` | Encrypted off-host backup, clean-host restore, the deliberate reopen step | L0–L2 |
| `src/lib/hosted/health/` | Real health and real logs for a hosted app, with release attribution | L0–L2 |

### L4 — orchestration

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/actions/core.ts` | `defineAction` / `runAction` / roles / idempotency / audit | L0–L3 |
| `src/lib/actions/defs/**` | The action catalog. Importing a def registers it as a side effect | L0–L3, `actions/core` |
| `src/lib/navigator/{planner,llm,run,verification}.ts` | Deterministic planner, optional LLM enhancement, executor, run verification | L0–L3, `actions/*` |
| `src/lib/auth/session.ts` | Who is signed in. Identity only, never a permission | L0–L3, `supabase/*` |
| `src/lib/supabase/*` | One entry point per Next context. Deliberately not barrelled | L0–L1 |

### L5 — request edge

| Path | Owns | May import |
| --- | --- | --- |
| `src/lib/server/boot.ts` | `ensureBoot()`: data-dir claim → `ensureHosted()` → engine → actions → alerts | L0–L4 |
| `src/lib/server/context.ts` | Barrel over the six modules below; every existing importer still resolves here | — |
| `src/lib/server/errors.ts` | `ApiError`, `notFound`, `json`, `errorResponse` | L0–L1 |
| `src/lib/server/request.ts` | `RequestState`, `currentRequest`, `route({ workspaceRole? }, handler)`, `intParam` | L0–L4 |
| `src/lib/server/workspace.ts` | `requireWorkspace`, `workspacesFor`, `currentWorkspace`, `membershipCheck` | L0–L4 |
| `src/lib/server/membership.ts` | invites, `ensureMember`, join target/role, the denial sentence (policy from `auth/policy.ts`) | L0–L4 |
| `src/lib/server/actor.ts` | demo/navigator actors, `resolveActor`, `workspaceRole`, `requireAdmin` | L0–L4 |
| `src/lib/server/scope.ts` | `scopedProject/Environment/Deployment`, `buildCtx` | L0–L4 |
| `src/lib/server/hosted.ts` | The hosted request edge: one `hostedRoute({ workspaceRole?, appRole?, verify? })`, `readJsonBody`, `requireAppOwner`; `hosted/{access,release}/http.ts` are barrels over it | L0–L4 |
| `src/lib/server/sse.ts` | SSE streams with `?after=<seq>` replay | L0–L4 |
| `src/lib/hosted/access/http.ts` | Re-export barrel over `src/lib/server/hosted.ts` kept for existing import paths. Not re-exported by the access barrel | `server/hosted` only |
| `src/lib/hosted/release/http.ts` | The `/api` layer for app routes: hosted status mapping, the two role checks | L0–L4 + `server/context`, `actions/core` |
| `src/app/api/**` (50 route files, 22 of them under `api/hosted`) | HTTP. Parse, authorise, delegate, shape the envelope | L0–L5 |
| `src/app/hosted-gateway/[host]/[[...path]]` | Where `hosted/edge.ts` rewrites an app-host request | `hosted/gateway` |

### L6 — UI

| Path | Owns | May import |
| --- | --- | --- |
| `src/app/(product)/**`, `src/app/(auth)/**` | Screens. Server components read through L2–L4; client components go through `lib/client/*` | anything server-safe, plus `lib/client/*` |
| `src/components/**` | The kit, the map, the inspector, the screens, the shell — each with its own `README.md` | L0, `lib/client/*` |
| `src/lib/client/{api,hosted,alerts,secrets}.ts` | `"use client"` — the only way UI code talks to the API | L0 + `fetch` |

---

## Invariants

1. **No static import cycles in `src/`.** Not a directory hierarchy — a file
   graph. Three violations are open; see below.
2. **`src/lib` and `src/components` never import from `@/app`.** Verified: zero
   matches for `from "@/app` in either tree. The dependency runs one way, so a
   route can be deleted without touching a library.
3. **Two stores, never crossed.** `db/store.ts` owns `.data/state.json`;
   `hosted/authority` owns `.data/control.sqlite`. Nothing in the authority
   directory writes to the JSON store.
4. **One validated place per env prefix.** `ORRERY_*` in `src/lib/env.ts`,
   `ZENITH_*` in `src/lib/hosted/config.ts`. Secrets are presence-only in both
   and are read at exactly one call site each.
5. **Every mutation goes through the action registry** (product A) or through a
   `tx()` on the authority with its effects in the outbox (product B). No
   surface keeps private state about the system.
6. **Commit before ACK.** A hosted route answers 200 only after `COMMIT`
   returned; anything that leaves the process is an outbox row written in the
   same transaction.
7. **Barrels are deliberate.** `actions/defs/`, `importers/`, and each hosted
   subdirectory have one. `supabase/`, `navigator/` and `providers/` do not,
   each for a stated reason (see docs/ARCHITECTURE.md, "Barrels").

## Known violations

None as of 2026-09-11. The three cycles this section used to list — `hosted/access/http.ts` → `server/context`, `hosted/release/http.ts` → `server/context`, and `hosted/release/http.ts` → `actions/core` — were all the same shape (an L3 module carrying its own HTTP layer that reached back to L5) and were removed by moving that layer to `src/lib/server/hosted.ts`. The two `http.ts` files remain only as re-export barrels.

Edges that look like violations and are not:

- `actions/core.ts` reads membership policy from `auth/policy.ts` (L4 → L1). It no longer imports `hosted/config` directly.
- `hosted/release/phases/build.ts` and `release/runner.ts` share `buildSlot` through `release/build-slot.ts`, so the phase never imports the pipeline that drives it.

Worth watching: `actions/defs/hosted.ts` may still import `server/request` for `currentRequest()`; the cleaner home for that value is the `ActionContext` the route already builds.
--- | --- | --- |
| `hosted/access/http.ts` → `server/context` | Hosted access routes want `route()`'s boot, request id, workspace resolution and `no-store` | Move the file to `src/lib/server/hosted-route.ts` (or beside the routes), leaving `access/` free of the request layer. The access barrel already refuses to re-export it, so no consumer moves. |
| `hosted/release/http.ts` → `server/context` | Same wrapper, plus the hosted-status error mapping | Same move. `release/index.ts` does not re-export `http.ts` either. |
| `hosted/release/http.ts` → `actions/core` | The app routes run hosted mutations as audited actions | Follows the file. Once `http.ts` sits at L5, calling L4 is the normal direction. |

Two edges people expect to find here and which are **not** cycles:

- `actions/core.ts` imports `hosted/config` (L4 → L1). Legal, and only to read
  `hostedMode()`.
- `actions/defs/hosted.ts` imports `hosted/config`, `hosted/release`,
  `hosted/authority` **and `server/context`**. The last one is L4 → L5 and is
  the fourth edge worth removing, though it closes no cycle today: the
  `currentRequest()` it wants belongs in the `ActionContext` the route already
  builds.

---

## Where to look first

| Question | Start here |
| --- | --- |
| How does a mutation happen? | `src/lib/actions/core.ts`, then `src/lib/actions/defs/<area>.ts` |
| Who may do this? | `src/lib/server/context.ts` (workspace role) and `src/lib/hosted/access/grants.ts` (app role) |
| What does the API return? | The route file under `src/app/api/**`, mirrored in `src/lib/client/hosted.ts` (hosted) or `src/lib/client/api.ts` (product A) |
| How is a hosted app served? | `src/lib/hosted/gateway/handle.ts` → `admission.ts` → `artifacts.ts` or `broker.ts` |
| How does a deploy run? | `src/lib/engine/engine.ts` → `src/lib/providers/<id>/index.ts` |
| What does the process do on start-up? | `src/lib/server/boot.ts` → `src/lib/hosted/index.ts` |
| Where is this table? | `src/lib/hosted/authority/schema.ts`, then `repos/<table>.ts` |
| Why is this ceiling here? | `grep -rn 'TODO(ceiling):' src`, then [docs/DEBT.md](DEBT.md) |
