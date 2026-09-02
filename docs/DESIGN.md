# Orrery — Design language

**Feel:** an observatory at night. Calm, precise, alive. Deep blue-black
grounds, hairline structure, one mint-teal signal color used with restraint,
and a second periwinkle accent reserved exclusively for the Navigator so
agent activity is always recognizable. Equally considered light theme.

## Tokens (see globals.css — never hardcode)

- Surfaces: `bg0` page · `bg1` chrome · `bg2` card · `bg3` overlay; 1px `line` hairlines; shadows only on raised/overlay surfaces.
- Ink: `ink` / `ink-mute` / `ink-faint`.
- Brand: `signal` (actions, focus, primary buttons), `nav-accent` (Navigator only).
- Status axis (independent of brand): `ok` `warn` `err` `info`; `prod` amber identifies production environments (ring + chip) everywhere they appear.
- Radii: cards 12, controls 8. Type: Space Grotesk (UI + display), JetBrains Mono (code, ids, logs, costs). Tabular numerals for all metrics (`.tnum`).

## Type scale

12 label-caps (+2% tracking) · 13 secondary · 14 body · 16 emphasized · 20 section · 28 page title · 40 display (onboarding/success only).

**Landing scale (marketing surface only):** display `clamp(42px, 7vw, 84px)`
tracking −0.025em for the hero; `clamp(36–40px, 6vw, 68–72px)` for the two
display closers; section headings `clamp(28px, 4vw, 44px)`. Entrance motion
on the landing belongs to the two display closers only — the hero canvas is
the page's single authored moment. Product surfaces keep the original scale.

## Motion

Motion communicates state; nothing animates without meaning.
Durations 120/200/320ms, ease `--ease-swift`; CSS transitions and keyframes only, no animation library; `animate-enter` for list/panel entrances; `.status-pulse` only while something is genuinely in progress; `.edge-live` dash-flow on map edges only during active deployment of that binding's target. Respect `prefers-reduced-motion` (already global).

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
