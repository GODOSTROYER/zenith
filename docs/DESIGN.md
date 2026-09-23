# Zenith — Design language

**Identity:** “Your stack, clearly in view.” The authored Shift Register symbol
uses two offset solid shapes and a diagonal seam. The lowercase zenith wordmark
is custom vector lettering with no suffix. Shared
geometry lives in `src/components/shell/brand-geometry.ts`; the compatible
`OrbitMark` export now renders this symbol. Gimbal's moving rings remain
character-specific. Keep existing configuration and persisted names compatible;
see `BRANDING.md`.

**Onboarding:** Workspace → choose how to start → blueprint → review your
system. The workspace guide is optional and revisitable. Completion cues
reflect actual records, not page visits. AWS Preview never reads as a
deployed environment.

**Landing feel:** Your cloud, in full view. The public page opens in the sky
at its zenith (night gradient, stars, nebula, a warm horizon, three ridges and
a beacon) with the brand lettering across the viewport, then turns to porcelain
daylight: bold sans headlines, one paragraph at most, big rounded cards, the
two-column feature pattern with round-icon rows, and one example system in
every demonstration. It returns to night for the cloud roadmap and the close.
Gimbal lives in the bottom-right corner as a persistent guide. This replaces the
Atlas narrative and the infrastructure object.

**Product feel:** the Revision Object workbench. Warm porcelain and ink form a calm operational surface, with fine rules, precise alignment, vermilion proposed-change emphasis and a compact persistent navigation rail. See `zenith-app-design-contract.md` for the shared foundation, route ownership and signature interactions.

## Where things live

`src/components/ui` is the kit and the only source of primitives — import the
direct primitive paths for development performance (the barrel remains compatible), and never hardcode a colour
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
- Radii: bounded panels 5, controls 3, chips 2. Type: Manrope UI, selective Instrument Serif page titles, JetBrains Mono code/IDs/logs/costs. Tabular numerals for all metrics (`.tnum`).

## Type scale

12 metadata · 13 secondary · 14 body · 16 emphasized · 18 project/card title · 20 section · 34 product page title (30 mobile) · 44 onboarding display. Prefer sentence case for table headers and task headings.

Product pages share responsive 20px/28px gutters. A persistent collapsible 208px rail (60px compact) and 56px context bar replace stacked navigation. The selected workspace, project and environment remain visible; production is explicitly labeled. Controls are 32/36px on desktop and at least 44px on coarse pointers; mobile inputs use 16px text. Root-level tokens theme portals as well as screens. Ordinary sections use rules; elevation belongs to detached overlays. `tests/ui/theme-contrast.test.ts` checks base and tinted status surfaces in both themes.

## Landing language and scope

`src/app/_landing/landing.css` scopes the `--zenith-*` tokens to
`.zenith-landing` as one language with two surfaces and one accent. Porcelain
`#f6f4ee` is the page; ink `#0d0e11` is every card, the roadmap and the close,
composed with the `.zenith-ink` class (`.zenith-ink-tokens` carries the same
tokens for floating glass such as Gimbal's guide). The accent is the mark's
vermilion `#e65332` for fills, large type, what is proposed, selected, hovered
or lit; `--zenith-accent-text` (`#b8391c` on porcelain, `#ff8f6f` on ink) is
the same hue at text-safe contrast. Neutrals come from the surface: muted
text, hairline rules, panels and round icon tiles are the ink or the paper at
low alpha, never a third hue. Ink surfaces carry one flourish, a faint
vermilion glow from a corner. Controls are one family: the pill button (ink
on porcelain, porcelain on ink, vermilion under the pointer), segmented pills,
outline chips, round icon tiles, hairline text links. Radii: cards 28 px,
tiles 20 px, controls 14 px, pills 999. The sky (`space-hero.module.css`)
runs from ink through the vermilion horizon to a peach `#ffdcc4`; nothing on
the page is blue or violet. The landing does not follow the product's
light/dark toggle; it is the same page for everyone.

Manrope variable (600–700 for headlines) is the landing body and display face;
Instrument Serif italic is kept for accents; the existing JetBrains Mono
supplies sizes, revisions and estimates. The drawn brand lettering is the
opening headline itself, with the accessible name "Zenith".

The opening reads "Welcome to" above the lettering, carries the real
runtime-aware CTA plus "See the system", the tagline "Your cloud. In full
view.", and the marks Zenith works with. A pinned statement and the
"Only the real facts" strip follow, then the chapters reachable from the
masthead: System, Growth, Observe, Agents, Gimbal, Cloud, and the close.

One shared state (`landing-state.ts`, provided by `landing-experience.tsx`)
feeds every demonstration and Gimbal: the inspected view, the selected part,
the growth step, the chosen path, the observed part, the demonstration autonomy
level, the agent sequence step, walkthrough progress and the companion's own
state. Changing any selector changes only presentation; nothing on the page
reads or writes a workspace, an account or a provider.

The example system is defined once in `scenario.ts` with real product
manifests. Estimates come from `@/lib/cost/pricing` ($22 → $30, +$8 a month)
and the plan from `diffManifests`, so the page can never disagree with the
product's own explanations, risk labels and cost deltas. The growth chapter is
labelled a concept preview: its traffic-to-configuration sizing rules are the
page's assumptions, priced with the product tables; Zenith does not forecast
traffic. The observability chapter's signals are illustrative and labelled;
its honesty table comes from `docs/LIMITATIONS.md`. Managed hosting is labelled
"In development" because no hosted availability is advertised. No source code,
terminal, JSON, API request or configuration block appears on the page, and the
main repository is not linked; the public plugin repository is.

See `zenith-landing-direction.md` for the selected direction and the
implementation reference; verification findings belong in the dedicated
verification report.

## Motion

Motion communicates state; nothing animates without meaning. The following
CSS duration and primitive rules govern the shared product UI.
Durations 150/220/380ms, ease `--ease-swift`; CSS transitions and keyframes only, no animation library; `animate-enter` for list/panel entrances; `.status-pulse` only while something is genuinely in progress; `.edge-live` dash-flow on map edges only during active deployment of that binding's target. Respect `prefers-reduced-motion` (already global).

**Landing motion.** The landing is the one place an animation library is
used: `landing-motion.ts` runs GSAP with ScrollTrigger and Lenis smooth
scrolling, loaded lazily in the browser and gated by
`prefers-reduced-motion: no-preference` through `gsap.matchMedia`. Under a
reduce preference nothing moves and the page is laid out in its final state.
The opening's layers scroll at their own depth, the statement lights word by
word, reveals rise once, numbers count, the orbit drifts. `SystemDiagram` lays
out the example manifest as HTML nodes and measures them to route SVG
connections; every relationship is a real binding. Scroll, hover and selection
never execute anything.

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

**Personality moods.** The renderer carries a second, separate layer:
`idle`, `attentive`, `engaged`, `thinking`, `delighted`, `cautious` and
`pleased`. A mood changes pace, expression and ring choreography only; the
accent colour always comes from the workflow state, so no mood can resemble
Verified, Blocked or any typed outcome. The public page uses moods for
hover, opening the question panel, walkthroughs, discoveries and warnings;
the product never sets one. The landing companion (`gimbal-companion.tsx`)
keeps the character bottom-right without a card, draws its own soft light and
shadow behind it, opens a bubble, a walkthrough callout or a curated question
panel beside it, offers one contextual suggestion per chapter after settled
reading (12 s, 45 s cooldown, four per session, dismissed for the session),
and can be minimised or set to quiet mode. Nothing it does executes an action.

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
accent. Product errors use the same berry family; status meanings and behavioral contracts remain unchanged.
Critical landing WOFF2s are preloaded; measured local fallback metrics stabilize
first paint, and WebGL initializes only after fonts settle and the text paints.
