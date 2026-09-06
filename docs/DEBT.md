# Zenith.ai — known debt

A map, not a backlog. Everything here is deliberate or measured; nothing is a
vague worry. Snapshot taken while polishing `src/lib` (see the report at the
bottom for what was fixed in that pass).

Counts: **18 `ponytail:` markers** (11 in `src/lib`), **0 `TODO`/`FIXME`**,
**1 remaining dead export**, **4 removed**, **3 duplicate helpers unified**.

---

## 1. `ponytail:` markers — deliberate ceilings

Each names the ceiling it accepts and the upgrade path. In `src/lib`:

| Where | Ceiling |
| --- | --- |
| `src/lib/db/store.ts:17` | Single-process JSON/JSONL file store. Swap for SQL behind this same module. **This is the root ceiling the next four inherit.** |
| `src/lib/db/store.ts:145` | Revision-manifest LRU is a `Map` in insertion order, 32 entries. |
| `src/lib/db/store.ts:400` | In-memory event tail is capped; older reads fall back to a file scan. |
| `src/lib/data-lock.ts:14` | A pid file, not a real lock. Two containers sharing a volume (different pid namespaces) defeat it. Upgrade: exclusive open of the state file, or stop rewriting it whole. |
| `src/lib/actions/core.ts:140` | Idempotency replay window is in-process. A retry that crosses a restart applies twice; `IDEM_WINDOW_NOTE` says so on the wire. |
| `src/lib/server/context.ts:114` | Invites live in `settings`, not a `Database` column. |
| `src/lib/alerts/index.ts:26` | One global 15s evaluation interval — no per-rule schedule, no hysteresis. |
| `src/lib/alerts/deliver.ts:22` | No dead-lettering, no per-channel circuit breaker. Three attempts, then the failure is recorded and dropped. |
| `src/lib/alerts/deliver.ts` | The delivery timeout races the send rather than aborting the socket. Delivery itself is durable (outbox rows are claimed before the send and settled after), so a timeout costs a retry, not a lost alert. |
| `src/lib/secrets/index.ts:18` | Read-through file access, no cache. Deliberate: a cache is a correctness bug the moment two processes hold the data directory. |
| `src/lib/providers/localstack/index.ts:722` | "Unowned" means unowned *by this environment*; two Zenith.ai environments against one LocalStack see each other's resources as extra. |

Outside `src/lib` (owned by the UI workstreams, listed so this file is the one
place to look): `app/(product)/p/[slug]/revisions/page.tsx:70`,
`app/(product)/p/[slug]/security/page.tsx:563` and `:872`,
`app/(product)/p/[slug]/security/dismiss-dialog.tsx:9`,
`app/(product)/p/[slug]/security/use-fix-plans.ts:7`,
`components/inspector/plan-first.tsx:162`, `components/ui/log-viewer.tsx:269`.
The last two pairs are the same marker text in two files — the screen split
copied it, and one of each pair should go when that refactor settles.

## 2. `TODO` / `FIXME`

None. The codebase states its compromises as `ponytail:` markers with a named
ceiling instead, which is the convention to keep.

## 3. Dead exports

Four were removed in this pass (`blueprintIds`, `secrets.secretExists`,
`boot.engineModule`, `context.actorFromRequest` — each had zero references
anywhere, including its own file). One is deliberately kept:

- **`navigatorHeaders`** (`src/lib/server/context.ts:51`) — no caller. It mints
  the header pair that `isNavigator()` checks, so deleting only the minter would
  leave a security guard that can never pass. The Navigator runs in-process
  today (`lib/navigator/run.ts` never goes over HTTP), so the pair is unused but
  intact. Delete both, or neither.

**Exported but only used inside its own file (55 symbols).** Not dead, and
mostly correct: an exported type that names an exported function's signature
(`OrreryEnv`, `LogFields`, `AuditFilter`, `SecretMeta`, `SsePull`, `DriftKind`…)
belongs in the public surface even with no importer today. The ones that are
genuinely just internal helpers wearing an `export` — `round2` (domain/graph),
`baseDomainFor` / `connectionLabel` (actions/defs/env), `findChannel` /
`workspaceOfRule` (alerts/channels), `emailBody` / `messageForEvent` /
`deliverEvent` (alerts/deliver), `sandboxHost` (providers/sandbox) — were left
alone in this pass: de-exporting them is churn across files two other agents
are editing right now. Do it in one sweep when the tree is quiet.

**Used only by `tests/` or `scripts/` (18 symbols).** All legitimate seams —
`resetDb` (29 test callers), `flushDeliveries`, `evaluateAll`, `pollDelay`,
`readSecretValue`, `createAdminClient`. Documented as such where it matters.

## 4. Duplicated helpers

Unified in this pass:

- **FNV-1a hashing, three copies → one.** `domain/types.hash32` (hex string),
  `providers/sandbox.hash32` (number, *same name, different return type*) and
  `logsim.seedOf` (number, same loop) all ran the identical FNV-1a. Now one
  exported `fnv1a(s): number` in `domain/types`, with `hash32` the hex wrapper
  over it. Numerically identical, so every deterministic simulation is unchanged.
- **Money formatting, two → one.** `actions/defs/_shared.usd` duplicated
  `format.fmtUsd`. All 17 call sites now use `fmtUsd`, which is what
  CONTRACTS invariant 10 asked for; the sign handling in `editSummary` folded
  into `fmtUsd`'s own `{ sign: true }`.
- **`slugify`, two → one.** `format.slugify` (URL slugs) had zero callers and was
  deleted; every caller already used `importers/types.slugify` (manifest node
  names, `/^[a-z][a-z0-9-]{1,30}$/`). That file's claim to be "the only
  slugifier" is true again.
- **`AUTONOMY_MEANING`, name collision.** Two exported constants, same name,
  different sentences: the dial's short form (`navigator/shared`) and the action
  plan's long form (`actions/defs/workspace`). The second is now a file-local
  `AUTONOMY_PLAN_LINE`. Both texts kept — they address different readers.

Known and **deliberately not** unified:

- **Two `ApiError` classes.** `server/context` (thrown by routes) and
  `client/api` (raised in the browser after decoding the envelope). Merging them
  would drag the store into a `"use client"` bundle. See docs/CONTRACTS.md.
- **A third slug rule, inline** at `src/app/api/workspace/route.ts:39` — a
  workspace slug, 30 chars, fallback `"workspace"`. Different constraints again,
  and that file belongs to the API workstream.
- **djb2 in `components/deploy/changes-review.tsx:30`** and a fourth FNV in
  `components/inspector/logic.ts:150` — both client-side, both keying local
  state. They could import `fnv1a`; that is a UI-workstream change.

## 5. Error handling — one real inconsistency

docs/CONTRACTS.md now states one rule per layer. One outlier remains, and it is
a behaviour bug rather than a style one:

> **A throw inside an action's `plan()` escapes `runAction`.** `runAction` wraps
> `execute()` in try/catch and converts a throw into `{ ok:false, error }`, but
> the `mode === "plan"` branch returns *before* that try block
> (`src/lib/actions/core.ts:230` returns; the `try` starts at `:282`). The
> `require*` helpers in `defs/_shared.ts`
> throw messages that name their fix, so planning with a stale `projectId`
> produces a generic 500 — *"Something went wrong on the server"* — and the
> carefully written fix is lost.

Verified, not theorised: planning `system.addService` against a missing project
throws `Project "…" does not exist. Pick one from the workspace overview.` out
of `runAction`. The fix is to wrap the plan branch the same way and surface the
message as `plan().blocked`; it is left here because it changes a response
status (500 → 200 with a blocked plan) and that is more than an organisation pass.

## 6. Environment reads

One way to read env: `src/lib/env.ts` (validated `ORRERY_*`) plus
`src/lib/supabase/env.ts` (`NEXT_PUBLIC_*`, which Next inlines by literal text).
Two raw reads were folded into the schema in this pass:
`ORRERY_STEP_TIMEOUT_MS` (was read raw in the engine and validated nowhere) and
`ORRERY_FAST` in `navigator/run.ts`.

Remaining by design, and documented in `env.ts`'s header: provider credentials
(`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`) are
presence-only flags there and their values stay at their single call site, so
`env.ts` never becomes a place a secret can be read from by accident.
`NODE_ENV` is exempt everywhere.

`ORRERY_STEP_TIMEOUT_MS` is not in `.env.local.example`; that file was outside
this pass's ownership.

---

## 7. UI — `src/components` and `src/app` (excluding `src/app/api`)

Snapshot after the UI organisation pass. Counts: **5 `ponytail:` markers**,
**0 in-scope files over 600 lines**, **7 duplicate groups unified**,
**2 dead exports removed**, **10 directory READMEs added**.

### 7.1 Oversized files

Every file the pass was asked to split, and what it became. A page file now
reads as: data hooks → derived state → layout of sections.

| Was | Lines | Now |
| --- | --- | --- |
| `components/inspector/editors.tsx` | 1670 | deleted → 10 siblings, largest `service-editor.tsx` 378 |
| `components/screens/onboarding-flow.tsx` | 1178 | 176 + `onboarding/` (largest `step-system.tsx` 507) |
| `components/map/system-map.tsx` | 1063 | 585 + `graph-model.ts` 237, `toolbar.tsx` 227, `node-menu.tsx` 128, `keyboard.ts` 120 |
| `p/[slug]/observe/page.tsx` | 982 | 100 + 4 section files (largest 308) |
| `p/[slug]/security/page.tsx` | 943 | 274 + 8 siblings (largest 256) |
| `p/[slug]/deploys/page.tsx` | 682 | 187 + 3 siblings + `status.ts` |
| `p/[slug]/activity/page.tsx` | 534 | 305 + `filters-bar`, `columns`, `event-cell` |

Still large, and deliberately not touched in this pass — each is one coherent
screen, not a grab bag:

| File | Lines | Why it is left |
| --- | --- | --- |
| `p/[slug]/settings/environments.tsx` | 920 | Seven colocated forms (rename, clone, move, new, policy…) for one card. Splits the same way `security/` just did; nobody has needed it yet. |
| `p/[slug]/revisions/page.tsx` | 853 | `EnvironmentCompare` / `CompareView` / `LeavingNote` are the obvious three siblings. |
| `components/landing/landing.tsx` | 845 | Marketing surface, one page, its own type scale. Low churn. |
| `p/[slug]/observe/alerts.tsx` | 804 | Nine inline components (rule list, history, four dialogs). The biggest remaining split candidate in the product. |
| `p/[slug]/source/page.tsx` | 801 | Gutter-synced editor; `WorkingTab` / `DeployedTab` / `IssueList` split cleanly. |
| `components/landing/hero-canvas.tsx` | 684 | One canvas animation. Nothing to extract that would not be worse. |
| `components/map/dialogs.tsx` | 554 | Import + blueprint dialogs. Two files if it grows again. |
| `p/[slug]/settings/page.tsx` | 371 | Was on the split list; it is not large. Left alone. |

### 7.2 Components defined inside page files

Every inline component in a `page.tsx` was used **once in its own file** — none
was reused across files, and there are **zero cross-route imports** anywhere
under `src/app/**` (no `from "@/app/…"`, no `../` outside `api/`). Nothing had
to be extracted for correctness; the extractions above were for size.

One with real reuse pressure remains: `settings/page.tsx:SectionHead`, used 8×
in its own file, whose `<h2 className="text-[20px] font-medium
tracking-[-0.01em] text-ink">` is repeated verbatim as an `<h1>` in
`navigator/navigator-screen.tsx`. Different heading level, so not unified.

### 7.3 Duplicates unified

| What | Was | Now |
| --- | --- | --- |
| Section title (`h3`, 12px / 0.04em / ink-faint, byte-identical) | 4 copies (inspector, changes-review ×2, success-panel) | `screens/shared.tsx:SectionTitle` |
| `simulated` chip (`tone="info"`) | 5 copies (observe/page ×3, observe/alerts ×2) | `screens/shared.tsx:SimulatedChip` |
| `needs {role}` chip (byte-identical) | 2 copies (`shared.tsx:PlanBody`, `inspector/plan-first.tsx`) | `screens/shared.tsx:RoleChip` |
| `download(filename, body, type)` (byte-identical) | 2 copies (security, activity) | `screens/download-file.ts:downloadFile` |
| `viewerReason(verb, role)` | local to a 943-line page, needed by 3 new files | `security/rows.ts` (pure, testable) |
| `nodeLabel(manifest, id)` | exported from a 1670-line component file | `inspector/logic.ts` (pure) |
| primary-link class string | 2 copies in `overview/page.tsx` | one `PRIMARY_LINK` const in that file |

Dead exports removed: `screens/shared.tsx:Money` (zero call sites anywhere);
`screens/shared.tsx:PlanBody` un-exported (only its own file used it).

### 7.4 Duplicates deliberately **not** unified

Each would change a rendered class attribute, a heading level, or a visual —
which this pass was not allowed to do.

- **Uppercase section label, 24 copies** — `text-[12px] tracking-[0.02em]
  text-ink-mute uppercase`, a *different* style from `SectionTitle` (0.02em vs
  0.04em, `ink-mute` vs `ink-faint`, no `font-medium`). Spread over `h2`, `h3`,
  `h4`, `p` and `span`, and 5 carry layout prefixes (`mb-2`, `border-b
  border-line bg-bg1 px-4 py-2`, …). A shared component needs an `as` prop plus
  `className` passthrough, and would silently change heading levels at some
  call sites. **Upgrade path:** decide the tag per call site first, then
  extract. `ui/field.tsx:66` uses the same string plus `font-medium` — a
  near-miss worth folding in at the same time.
- **File-picker `<label>`, 2 copies** — `map/dialogs.tsx:459` and
  `screens/onboarding/step-system.tsx`. Pixel-identical; the only difference is
  `duration-[120ms]` vs `duration-[var(--dur-fast)]`, and `--dur-fast` *is*
  120ms. Unifying means picking one class string, i.e. changing a class
  attribute. **Upgrade path:** extract `FilePickerLabel` into
  `screens/shared.tsx` in the same pass that standardises on the token.
- **`OutputRow`, 2 definitions** — `deploy/success-panel.tsx:46` and
  `deploys/output-row.tsx`. Same domain object, same helpers
  (`deploy/output-link.ts`), genuinely different rows: `px-4 py-2.5` + globe
  icon + two-line label vs `px-5 py-3` + mono label + kind subtitle, and a
  primary-signal vs quiet-bordered Open link. Their "simulated" tooltips differ
  by one clause. Not swappable without a visual decision.
- **Role rank map, 5 copies** — `{ viewer: 0, editor: 1, admin: 2 }` in
  `screens/shared.tsx`, `deploy/caller-role.ts`, `shell/command-palette.tsx`,
  `settings/access.ts`, `security/rows.ts` (and three more in `src/lib`). The
  canonical one is `src/lib/actions/core.ts`. Two of the UI copies live in pure
  modules that tests import directly; pulling a `"use client"` module into them
  to save one line would be worse. **Upgrade path:** export the rank from
  `lib/actions/core.ts` and have all eight read it.
- **Role-refusal sentence, 5 near-copies** — same tail (*"Ask a workspace admin
  to raise your role in Settings → Members…"*), different heads and different
  fix clauses across `caller-role.ts`, `settings/access.ts`,
  `command-palette.tsx`, `roleShortfall` and `viewerReason`. Unifying changes
  copy. Needs a wording decision, not a refactor.
- **Coloured dot spans, 8 hand-rolled** — the kit's `StatusDot` renders a
  wrapper plus an absolutely-positioned inner span with `role="img"`, so none is
  a drop-in. Worth flagging as a **real inconsistency, not just duplication**:
  `screens/shared.tsx:EnvDot` colours staging `bg-signal` and sandbox `bg-info`,
  while `shell/project-chrome.tsx:74:EnvLabel` colours both `bg-ink-faint` — the
  same concept, two colour rules.
- **One-line empty states** — `shell/activity-bell.tsx:112` (`<p>`) and
  `shell/command-palette.tsx:280` (`<li>`) share a class string exactly but not
  a tag; `deploy/deploy-dock.tsx:279` is a third size. The kit's `EmptyState` is
  much taller (`px-6 py-12`, a 15px heading) and would change all three.
- **Landing's own copy button and pill tabs** (`landing.tsx:95`, `:333`) —
  duplicate `ui/copy-button.tsx` logic including its failure string, and
  reimplement `ui/tabs.tsx` as rounded pills. Deliberate: the marketing surface
  has its own look. Written down in `components/landing/README.md`.

### 7.5 Hand-rolled where the kit already has it

None is pixel-identical to its kit equivalent, so all are left. Listed so
nobody re-discovers them: `overview/page.tsx` primary link (kit `Button` adds a
transparent border and hovers `bg-signal-strong`, not `brightness-110`);
`deploys/output-row.tsx` Open link and `command-palette.tsx:205` (kit adds
`font-medium` and `hover:bg-bg3`); `shell/product-chrome.tsx:33 CHIP` (kit
`Chip` is `px-2`, 11.5px, `leading-5`); `map/edges.tsx:120` badge;
`map/dialogs.tsx:487` textarea (`rounded-ctl`, no `leading-[1.6]`);
`navigator/command-bar.tsx` and `source/page.tsx` textareas (deliberately
transparent and borderless inside their own shells); `revisions/page.tsx:314`
and `navigator/step-card.tsx:208` checkboxes (different accent token, no
visible label); `product-chrome.tsx:147` skeleton (`animate-pulse` vs the kit's
`status-pulse`); `command-palette.tsx:213` portal (the kit `Dialog` renders a
visible header and close button); `map/node-menu.tsx` (the kit `Popover`
anchors to a trigger and cannot open at cursor coordinates — its local
`NodeMenuItem` also has a `danger` variant the kit's `MenuItem` lacks, and is
now named so it no longer collides with the kit export).
`app/global-error.tsx` uses inline styles on purpose — the root boundary must
render without the CSS bundle. **Leave that one alone.**

### 7.6 `ponytail:` markers under `src/components` and `src/app`

| Where | Ceiling |
| --- | --- |
| `components/inspector/plan-first.tsx:162` | The reload-and-retry affordance shows for *any* refusal on a token-carrying input, a role block included. Narrow it if a reason code ever lands beside `blocked`. |
| `components/ui/log-viewer.tsx:269` | Screen-reader politeness is tied to Follow: turning Follow off silences the announcements. Split the two controls if anyone needs them apart. |
| `p/[slug]/revisions/page.tsx:70` | A re-read drops back to the first page, so pages opened with "Load older" lose them on refresh. Keep the cursor in the URL to fix. |
| `p/[slug]/security/use-fix-plans.ts:7` | One plan request per fixable finding, in parallel. A batch plan endpoint if a project ever carries enough findings for that to matter. |
| `p/[slug]/security/dismiss-dialog.tsx:9` | The dismissal reason is debounced 250ms before planning, so the plan on screen can lag the keystrokes. It is always the input that executes. |

### 7.7 One exported component per file — the exceptions

The rule holds everywhere the pass touched, with two deliberate module
exceptions and six pre-existing ones. Each is a cohesive group where splitting
would produce 15-line files and one more import per call site:

| File | Exports | Why it stays one file |
| --- | --- | --- |
| `screens/shared.tsx` | 8 | It *is* the shared-pieces module; splitting it makes eight files nobody would ever open on their own. |
| `inspector/editor-parts.tsx` | 4 | `SizeField`, `CostHint`, `Facts`, `StaleNotice` — sub-field pieces, never a screen, only ever imported by their five sibling editors. |
| `ui/popover.tsx` | 3 | `Popover` + `MenuItem` + `MenuNote` are one control. |
| `ui/toast.tsx` | 2 | `ToastProvider` + `Toaster` are one mechanism. |
| `map/nodes.tsx` | 3 | One renderer per stratum, registered together in `nodeTypes`. |
| `shell/wordmark.tsx` | 2 | `Wordmark` + `OrbitMark`, the same mark at two sizes. |
| `auth/auth-form.tsx`, `map/dialogs.tsx`, `shell/project-chrome.tsx`, `observe/alerts.tsx` | 2 each | Pre-existing; outside this pass. `observe/alerts.tsx` is the one worth splitting (see 7.1). |
