# Zenith.ai — Design language

**Identity:** “Your stack, clearly in view.” The authored Shift Register symbol
uses two offset solid shapes and a diagonal seam. The lowercase zenith wordmark
is custom vector lettering, with an optional visible `.ai` suffix. Shared
geometry lives in `src/components/shell/brand-geometry.ts`; the compatible
`OrbitMark` export now renders this symbol. Gimbal's moving rings remain
character-specific. Keep existing configuration and persisted names compatible;
see `BRANDING.md`.

**Onboarding:** Workspace → choose how to start → blueprint → review your
system. The workspace guide is optional and revisitable. Completion cues
reflect actual records, not page visits. AWS Preview never reads as a
deployed environment.

**Landing feel:** The Revision Object — the next change, made tangible.
Porcelain infrastructure objects, ink, controlled vermilion, large editorial
serif typography and precise ruled evidence. Existing service objects remain
spatially anchored while a queue is proposed, simulated and recorded. The
landing has intentional light and dark themes, with a consistently dark
inspect/review chapter and closing signature. This replaces the previous
observatory marketing direction.

**Product feel:** the existing shared UI remains in use: layered navy grounds,
mint actions, periwinkle Navigator identity and its considered light theme.
The landing's scoped tokens and display scale do not restyle product workflows.

## Where things live

`src/components/ui` is the kit and the only source of primitives — import the
barrel (`@/components/ui`), never a file inside it, and never hardcode a colour
there. `src/components/screens` holds the screen-level pieces the kit cannot
own because they know about actions and roles: `ActionConfirm`, `ErrorNote`,
`SectionTitle`, `SimulatedChip`, `RoleChip`, `ChangeRow`, `ActorDot`, `EnvDot`.
Everything else is one folder per area — `shell`, `map`, `inspector`, `deploy`,
`navigator`, `auth`, `landing` — with one exported component per file, pure
logic beside it in a plain `.ts`, and a `README.md` in every directory saying
what belongs there. Under `src/app`, a route folder keeps only its own files: a
`page.tsx` reads as data hooks → derived state → layout of sections, and
anything a second route needs moves into `src/components/<area>/`. Ownership
per path is in `docs/OWNERSHIP.md`; the deliberate exceptions are in
`docs/DEBT.md`.

## Product tokens (see globals.css — never hardcode in shared primitives)

- Surfaces: `bg0` page · `bg1` chrome · `bg2` card · `bg3` overlay; 1px `line` hairlines; shadows only on raised/overlay surfaces.
- Ink: `ink` / `ink-mute` / `ink-faint`.
- Brand: `signal` (actions, focus, primary buttons), `nav-accent` (Navigator only).
- Status axis (independent of brand): `ok` `warn` `err` `info`; `prod` amber identifies production environments (ring + chip) everywhere they appear.
- Radii: cards 12, controls 8. Type: Space Grotesk (UI + display), JetBrains Mono (code, ids, logs, costs). Tabular numerals for all metrics (`.tnum`).

## Type scale

12 metadata · 13 secondary · 14 body · 16 emphasized · 18 project/card title · 20 section · 24 product page title · 40 display (onboarding/success only). Prefer sentence case for table headers and task headings.

Product pages share responsive 20px/32px gutters. Workspace identity sits beside
the wordmark; project and environment remain in project chrome. Primary actions
belong beside their section heading, including New project. Controls are 32/36px
on desktop and at least 44px on coarse pointers; mobile inputs use 16px text.
The navy surface ladder and all text/status tokens pass 4.5:1 contrast in both
themes (see `tests/ui/theme-contrast.test.ts`). Cards are bordered, not shadowed.

## Landing language and scope

`src/components/landing/landing.css` scopes the `--zenith-*` tokens to
`.zenith-landing`. Light uses porcelain `#f4f3ee`, ink `#20211f` and vermilion
`#be3e25`; dark uses `#22241f`, warm ink `#f2f1e9` and the more luminous
`#ff886c` accent. Rules, panels and muted text have separate values in each
theme. The dark demonstration and closing chapter use their own deliberate
ink grounds rather than mechanically inverting every section.

Instrument Serif 400 roman/italic is the landing display face; Manrope variable
is the landing body/control face; the existing JetBrains Mono supplies resource
names, source, revisions and estimates. These are real self-hosted assets
declared in `src/app/fonts.css`, with provenance and OFL notices under
`public/fonts`. Space Grotesk retains its product UI role. The drawn brand
wordmark is independent of all font files.

The desktop hero uses `clamp(76px, 8.2vw, 132px)` at .92 leading and −.035em
tracking, with responsive overrides. It begins directly with “See the change.
Before you ship.” and includes the real runtime-aware CTA plus “Explore the
change.” Editorial section type, thin rules, restrained control corners and
substantial empty space provide hierarchy. Responsive layouts stack the model,
inspector and plan rather than requiring an offscreen horizontal diagram.
Product surfaces retain their original scale and shared primitives.

One local demo state feeds the hero, dark inspector/review stage and all four
model surfaces. The first view deliberately shows proposed revision 09 while
the active baseline is 08. Atlas has `atlas-api` and `atlas-worker`; the proposal
adds `atlas-jobs` and explicit publish/consume bindings. Static estimates are
$14 → $15 (+$1), labeled synthetic configuration rather than a billing quote.
The review checkbox and explicit Run simulation action are required before
progress begins. No provider is contacted.

Simulation records revision 09. Historical 08/09 views are read-only and leave
the active revision and approval state unchanged. The separate restore action
creates revision 10 using the 08 configuration, retaining 09 in the audit trail.
Reviewing and running the queue again appends 11; subsequent restores/runs
continue appending. Reset demonstration clears only the page's local example,
returning to baseline 08 with proposal 09 visible. This demonstration is not
persisted workspace history. Restoration means configuration, not deleted data.

The four surfaces use the selected manifest and revision: System Map, Source,
API and a scripted Navigator illustration. API examples send no request.
Source uses reserved example image references. Provider content comes from the
registry and states concrete current limits. Gimbal follows in a separate
chapter, then providers/export and the closing CTA. See
`zenith-reimagined-direction.md` for the selected direction and implementation
reference; verification findings belong in the dedicated verification report.

## Motion

Motion communicates state; nothing animates without meaning. The following
CSS duration and primitive rules govern the shared product UI.
Durations 120/200/320ms, ease `--ease-swift`; CSS transitions and keyframes only, no animation library; `animate-enter` for list/panel entrances; `.status-pulse` only while something is genuinely in progress; `.edge-live` dash-flow on map edges only during active deployment of that binding's target. Respect `prefers-reduced-motion` (already global).

**Landing scene exception.** `RevisionScene` lazily loads the native Three.js
renderer when visible, with an immediate authored SVG fallback. The scene is
decorative; HTML labels and controls carry every interaction and meaning.
Queue motion follows the shared demo phase, while existing service positions
stay fixed. The proposed queue is vermilion; the recorded treatment settles
into porcelain with a small vermilion revision tab. Restoration removes the
queue without erasing the retained record. Reduced motion uses stable poses;
rendering responds to visibility, system preference and low-power conditions.
Scroll, hover and model inspection never execute the simulation. No continuous
decorative spin or scroll-driven apply is part of this direction.

**Gimbal exception.** Navigator's procedural 3D character blends ring poses
through native Three.js animation; the CSS motion rule above continues to
govern UI. Exactly five workflow states — `planning`, `awaiting_approval`,
`applying`, `verified`, `blocked` — come from typed application state, never
assistant prose. Pose, motion, accent, icon, and HTML label consume that same
state. Planning explores; applying aligns; approval holds; blocked separates
the rings. As a separate personality layer, occasional blinks and winks occur
at irregular intervals. Applying and Blocked use restrained blinks. Hover
acknowledges with a glance; tap or keyboard activation greets with a cooldown.
Workflow transitions interrupt expressions and keep their status meaning.

The canvas is decorative and hidden from assistive technology; the overlaid
"Say hello to Gimbal" button is keyboard accessible. Always pair
it with an HTML status label and icon so meaning survives without motion,
color, or WebGL. Render on demand only while the character and page are
visible, with animation capped at 30 fps (20 fps in low-power mode). Support low-power LOD, explicit
still mode, and `prefers-reduced-motion` using static poses with idle
and greeting animation disabled; retain
SVG fallbacks while loading or when WebGL is unavailable. The outer glow uses
purple for planning, yellow for approval, blue for applying, green for verified,
and red for blocked. Approval and blocked glows remain steady; verification
acknowledges once. No glow or gesture may turn a simulated result into Verified.

Ready, Plan complete, Completed, Simulation complete, and Cancelled are
neutral lifecycle presentations, outside the five workflow states.
**Verified requires authoritative, non-simulated provider evidence for the
completed applied run.** Neutral outcomes must never borrow its success
accent, checkmark, or acknowledgement motion.

## Voice

Calm staff engineer. Explains during long operations, names the fix in every
error, celebrates the first successful deploy once (success panel, not
confetti spam), never uses alarm styling for non-emergencies. Provider labels
are honest: Available / Preview / Planned. Sandbox output is labeled simulated.
Costs are labeled estimates.

## Interaction law (enforced in review)

No dead controls · disabled controls explain themselves (tooltip) · toasts
bottom-left, 6s, mirrored to Activity, never covering the map toolbar or any
control that resolves them · long operations survive refresh (SSE replay) ·
editors have error boundaries with a "restore last good" action · destructive
actions confirm with typed names and honest consequence text · production
always visually distinct (prod ring/chip) · cancelled wizards leave no
phantom records.

The landing additionally uses a berry error token (`#932553` / `#ff8fbb`) in
its state glossary, keeping Blocked distinguishable from the vermilion brand
accent. Shared product status colors and behavioral contracts are unchanged.
Critical landing WOFF2s are preloaded; measured local fallback metrics stabilize
first paint, and WebGL initializes only after fonts settle and the text paints.
