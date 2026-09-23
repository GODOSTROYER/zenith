# Zenith landing — verification notes

For the "Your cloud, in full view" landing (space opening, 23 September 2026,
after the rounds that removed the After-deployment chapter, reworked the
system card, Growth, Agents, Control and the close, sharpened the opening, and
unified the design language: two surfaces, one accent, one control family). This records what was
actually run and what was not. Design intent lives in
`zenith-landing-direction.md`.

## Automated

| Check | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | clean |
| Whole unit suite | `npx vitest run` | 2,954 passed, 87 skipped, 0 failed (275 files) |
| Fixtures and guide | `tests/screens/landing-scenario.test.ts` | manifests parse; estimates equal the cost model ($22 → $30, +$8); plan equals `diffManifests`; growth steps priced and bounded; the agent sequence has six steps and no command; every suggestion opens a walkthrough in its chapter; typed questions match or honestly miss |
| Shared state | `tests/screens/landing-state.test.ts` | walkthroughs never change selections; offers once per chapter, dismissal, 45 s cooldown, four-per-session cap, quiet mode, session restore |
| Chapters and companion | `tests/screens/landing-chapters.test.tsx` | no network calls, no `pre`/`code`, no Atlas text, no main-repository link; view switch keeps the selection; growth changes the estimate and configuration (the orb count reads "6 replicas") and labels it a concept preview; the five levels explain from the dial without any write; the roadmap draws six orbit cards from the registry with managed hosting as a vision; question panel answers, Escape restores focus; walkthrough emphasis is restored; minimise and restore |
| Renderer mood layer | `tests/navigator/gimbal-renderer.test.tsx`, `gimbal-character.test.tsx` | the approved workflow poses and colours are unchanged; moods reach the renderer; activation hands off to the host |

Motion hooks are mocked in the chapter tests (`useReveal`, `useHeroScene`,
`useOrbitMotion`, `useFlowMotion`, `useSystemFlow`, `useFan` and the rest);
GSAP, MotionPathPlugin and Lenis are exercised in the browser lab and the
headless probes below, not in jsdom.

`next build` was not run: the worktree's development server was serving the
page during the session and Next 15.5 shares `.next` between the two.
`npm run smoke` and `npm run gimbal:verify` were not run for the same reason.

## Browser lab (`scripts/zenith-landing-qa.mjs`)

Run against the development server (`ZENITH_QA_URL=http://localhost:3411`)
in headless Chrome 153 on Windows 11. A development server is slower than the
production build the script normally targets, so its performance numbers are
observations only. The lab waits for the opening's entrance and scrolls the
page before its full-page captures, because reveals play as sections come into
view.

Result: **20 of 20 checks passed, 0 unexpected page or console errors**
(report in `.data-zenith-review/qa-results.json`, captures under
`.data-zenith-review/supplemental/`: `1440-hero.png`, `1440-full.png`,
`390-hero.png`, `390-full.png`, `390-gimbal-sheet.png`,
`390-no-webgl-opening.png`, `keyboard-focus.png`, `walkthrough-restored.png`).

Two lab-side fixes were needed this round, neither a page defect: the guide
dialog is now named "Ask Gimbal" through `aria-label` (its serif title is a
tagline, not a name), and the lab's context-line locator was narrowed to the
context element after a second CSS-module class (`contextDot`) matched it.

| Lab observation (development server) | Desktop, cold cache | 390 px, 4× CPU, slow 3G-class network |
| --- | --- | --- |
| Largest contentful paint | 1,608 ms | 15,484 ms |
| Cumulative layout shift | 0.000 | 0.000 |
| Longest task | 155 ms | 1,012 ms |
| Transfer | 3.1 MB (unminified development bundle) | 3.1 MB |

The 1.0 s long task on the throttled run happened during the lab's
scroll-through, on the development server; its cause was not investigated and
a production build was not measured. The 15.5 s throttled paint was later
traced to the opening's words waiting for the motion library's chunk before
they entered; the fix and the re-measured numbers are under "The opening's
entrance and the agents chapter" below.

Checks: CTA for signed-out, new-member and member; CTA width with a delayed
and a failed `/api/me`; no-WebGL fallback (static Gimbal, panel and system
card usable); reduced motion; responsive at 320, 390, 768 and 1440 with no
horizontal overflow and Gimbal overlapping no CTA or navigation at rest;
keyboard focus on the five dial notches; Gimbal dialog open, chip and typed
answers, Escape; walkthrough emphasis and restore; contextual suggestion after
settled reading and dismissal for the session; mobile sheet; delayed fonts and
deferred chunks still show the headline, CTA and the six parts of the system.

## Design unification (impeccable skill, 23 September 2026)

The page had six unrelated palettes (indigo and violet system card, sunset
card, navy growth card, cold-blue roadmap and close, coral companion, purple
sky) and one-off colours in every stylesheet (37 distinct hex values in the
roadmap's, 52 in the companion's). `landing.css` now defines the whole
language and every stylesheet reads tokens: porcelain page; ink `#0d0e11` for
every card and night chapter (`.zenith-ink`, and `.zenith-ink-tokens` for
Gimbal's floating glass); the mark's vermilion `#e65332` as the only accent
with text-safe tints; neutrals as the surface at low alpha; one control family;
one flourish (a vermilion corner glow on ink). Eyebrows, the film grain and the
overshoot easings are gone.

Contrast, by calculation against the tokens: accent text `#b8391c` on porcelain
5.3:1 and `#ff8f6f` on ink 8.7:1; muted text 5.1:1 on porcelain and about 7:1
on ink; the accent itself 3.4:1 on porcelain, used only for large type and
fills there, and 5.2:1 on ink.

The mechanical detector ran once over the changed files after the rework. It
reported a padding transition and a side stripe on the plan rows (now a tinted
row with constant padding), four overshoot easings (now exponential ease-out),
and a gradient-tiled dashed line in the growth card (now an SVG line whose dash
offset carries the traffic). Two inspection rounds followed, desktop and phone
together, all chapters: the first found the companion's bubbles inheriting the
porcelain text colour (the ink tokens were on the wrong root) and the second
confirmed the fix and caught the SVG connector's intrinsic width pushing the
growth orbs apart (fixed with an explicit width). No third round.

## The opening's later round (23 September 2026)

Probed headless at 1440 × 900 after the apex composition, the sheet, the star
and the companion changes:

- The native scrollbar is gone on the landing (`innerWidth` equals the
  document's `clientWidth`); the page still scrolls, with the wheel, the keys
  and Lenis.
- The sheet starts exactly at the opening's foot (its edge at 900 px on a
  900 px viewport, so none of it shows at rest) with 40 px shoulders; at 480 px
  of scroll the opening has receded 163 px and dimmed to 0.32 while the sheet's
  edge sits at 420 px; the masthead turns solid only once the edge reaches it
  (at about 1,180 px it is solid), so white nav text never sits on porcelain.
- The star is 42 px wide (34 px on phones), centred on the ray at 720 px; its
  twinkle runs a 4.2 s cycle between 0.94× and 1.3× with a stronger bloom at
  the peak. A mouse pointer reaching it sends a small wave (four to six
  meteors, at most once every four seconds); a press sends a full wave; left
  alone, the sky sends one meteor, or a few, every nine to twenty-five seconds.
- "Welcome to" sits at the lettering's top-left (45 px in at 1440, the
  lettering's own left edge at 29 px); the tagline's comma travels with the
  turning word ("Your cloud," / "Your infra,").
- Gimbal is hidden while the opening is on screen (`data-hidden`, no pointer
  events) and has full opacity once the sheet's edge has climbed into the
  upper third of the viewport; the invitation appears with it. The check is
  measured on scroll, so an instant jump cannot leave it hidden.
- The star at the apex is a button named "Send a wave of meteors across the
  sky"; pressing it draws a dozen meteors on the starfield (captured
  mid-flight) and blooms the star.
- The guide panel: at 140 ms of its 560 ms arrival it is at opacity 0.92,
  scale 0.995 and 0.8 px of blur; settled it is exact; on Close it carries
  `data-closing` at opacity 0.72 after 90 ms, is gone after 400 ms, and focus
  returns to the launcher. The panel text no longer contains "not live AI" and
  has no checkbox; the bell toggles quiet mode.
- The lab reaches Gimbal by scrolling to the system chapter first
  (`revealGimbal`), since the launcher is not there on the opening; its
  responsive check now asserts that Gimbal is hidden on the opening and
  measures overlap with the CTA and navigation once it is shown.
- The ray runs behind the lettering (the "n" overlaps it; a hit test at the
  ray inside the lettering returns the heading) while the star stays in front
  and pressable (a hit test at its centre returns the star).

## The opening's entrance and the agents chapter (23 September 2026, late)

- Sampled every 50 ms, the first letter's opacity now runs 0 → 0.58 → 0.88 →
  0.98 → 1 across the entrance; before the fix it read 1 at load, dropped to
  0 when the motion library arrived about half a second later, then rose,
  which was the blink and the abrupt finish. The lettering, the ray and the
  star wait in their starting pose in the stylesheet until the library takes
  over (and appear on their own after 1.6 s if it never does); the words and
  the marks no longer wait for it at all. They enter from the stylesheet the
  moment it applies (a `data-enter` cascade: "Welcome to" at 0.35 s, the
  meaning line at 0.6 s, the tagline and the button at 0.75 s, the marks from
  0.9 s), because making them wait had pushed the throttled largest paint to
  15.5 s. Re-sampled after the change: the meaning line, the tagline and the
  first mark read 0 at 0.48 s, 0.82 / 0.55 / 0 at 0.89 s and 1 by 1.7 s; the
  first letter reads 0 at 0.34 s, 0.68 at 0.8 s and 1 by 1.44 s, with no drop
  in between. (The cascade's selectors are scoped under `.hero`: a bare
  attribute selector is rejected by CSS Modules as impure and took the page
  down to a 500 until it was scoped.)
- Re-measured by the lab after the change, on the development server:
  largest contentful paint 1,924 ms desktop cold (the meaning line, which now
  enters at 0.6 s) and 3,368 ms at 390 px under 4x CPU and slow-3G-class
  throttling (was 15,484 ms); layout shift 0.000 and 0.0004; longest task
  152 ms and 1,051 ms (the latter again during the throttled scroll-through).
  Final lab run after every change in this round: 20 of 20 checks, 0
  unexpected page or console errors; lint clean; the landing and navigator
  test files pass.
- Scrolling 700 px away and back: the tagline, the meaning line, the button
  and the lettering read opacity 0 away and 1 back, in both directions. The
  scroll-bound fades used to snapshot the elements mid-entrance (at opacity 0)
  and so returned them to nothing; they now state their own start values and
  are armed only after the entrance completes.
- Agents: four stations; as the pulse passes, the stations read done in the
  order 1000 → 1100 → 1110 → 1111, hold, then clear to 0000 for the next loop.
  The lede sits on one line at 1440; "Read the docs" is the only foot link;
  the trademark line and the sandbox pill are gone. A lit station's tint is
  opaque (measured `color(srgb 0.988 0.919 0.904)`), so the connector never
  shows through it, and the link badge is a 22 px circle with its glyph
  centred to the pixel.

## The control chapter (23 September 2026, late)

Words on the left, the dial on the right, no card. Watched for 17 s at
1440 × 900, the selected level read approve → bounded → autonomous → bounded
→ approve, one step every 3.4 s, with the needle and the arc easing between
them; the only link is "Read the docs" (the workspace guide, as a
placeholder); the meaning line under the readout follows the level. The
chapter test now expects the meaning lines and the "no workspace setting is
changed" note; the expectations for the removed card (its example and its
state legend) are gone.

## Phones (23 September 2026, late)

At 390 × 844 the masthead shows "Sign in", the real CTA as a 147 × 36 px
pill and the menu button; the opening's own button and the marks row are
hidden; the scroll cue sits at the bottom right (44 px, at x 326); no
horizontal overflow at 390 or 768. The lab waits for whichever CTA is visible
rather than the opening's.

## Headless probes (scratch script, this session)

A small Playwright script scrolled each chapter into view at 1440 × 900 and
390 × 844, waited for the motion to settle, captured it and read the DOM:

- Opening: the generated ridges render crisp at 2× device pixels (the
  captures were checked at 1440 × 900 with a device scale factor of 2), the
  beacon and the mark sit on the far ridge's summit, and the marks row shows
  eight marks: Kubernetes with its wheel visible through the white filter
  (`kubernetes-mono.svg`) and Oracle legible at 100 × 15 px (`oracle-mark.svg`).
  No hydration or console error: the ridge generator is seeded, so the server
  and the client draw the same paths.
- Cloud: all six orbit cards and the core reach opacity 1 and drift. The
  earlier "cards invisible" report was real and came from ScrollTrigger's
  `once` never firing under Lenis; one-shot reveals now use an
  IntersectionObserver.
- System card: the light travels the connections (`[data-flow-light]` at
  opacity 1, parts lit in turn), proposed connections march, parts have 18 px
  corners, no monospaced text in the card.
- Agents: the pulse travels the five stations and the gate lights
  (`data-approved`) before it continues.
- Control: the needle and the arc follow the selected notch; the balanced row
  centres the card and the dial.
- Close: the sheets fan out (`--fan` 0 → 1). They stayed stacked until the
  reveal tween stopped overwriting every tween on the same element
  (`overwrite: "auto"`).
- No horizontal overflow at either width for the system, growth, agents,
  control, cloud and close chapters.

## Two sheets, the phone opening and the glass guide (23 September 2026, later)

- The ink sheet rides over the porcelain exactly as the porcelain rides over
  the sky. At 1440 × 900 with the ink sheet's top at 55% of the viewport the
  porcelain reads `translateY(137.7px)` and its shade opacity 0.25; with the
  ink sheet at the top, 306 px (34% of the viewport) and 0.55; scrolled back
  above it, 0 and 0. The ink sheet keeps the 40 px shoulders (26 px on
  phones) and the same shadow; its first chapter paints no background and no
  top border of its own, so the shoulders stay round. The same handoff at
  390 × 844 reads 143 px and 0.275 midway.
- Phones: at 390 × 844 the lettering's centre sits at 60% of the height (55%
  at 360 × 740, 60% at 768 × 1024), the star at a fifth, and the meaning
  line ends 30 to 35 px above the summit because the mountains drop 12 svh
  on portrait screens; no horizontal overflow at any of the three.
- The guide as liquid glass, measured on the animation's own clock: the
  clip's inset reads 40% at 236 ms (the glass 60% grown), 5% at 436 ms,
  beyond the box at 689 ms (the shadow fading in), done at 780 ms; the text
  carries no filter at any point. At rest the body frosts at `blur(24px)
  saturate(1.3)` over an 0.8 ink fill (over porcelain that composites to
  about #3b3c3d, roughly 10:1 against the ink-surface text), the rim is a
  masked 1 px gradient, the lens ring a masked 14 px band with its own
  backdrop brightness, and the pointer highlight's custom properties read
  72% / 32% under the pointer and 22% / 0% at rest. Closing collapses the
  shape in 260 ms (opacity 0.96 at 126 ms of it); the dialog is gone and
  focus is back on the launcher afterwards. The phone sheet grows from its
  bottom-right corner in 640 ms with the lens ring off.
- The lab's mobile sheet check reads the dialog's box on its first frame,
  so the phone sheet grows without scaling (full width from frame one).
  Final run after these changes: 20 of 20 checks, 0 unexpected errors; 62
  test files (478 tests) pass; lint and the type check are clean; largest
  contentful paint 1,852 ms desktop cold and 2,936 ms throttled, layout
  shift 0 on both.

## Liquid glass, navigation and the loader (23 September 2026, late)

- Glass: in headless Chrome every glass surface reports `data-glass="lens"`
  with `backdrop-filter: url(#zenith-glass-N)`; the hero's button refracts
  the ridges through its rim. The masthead capsule's text tone reads dark
  over the sky and the ink sheet and light over the porcelain; Gimbal's
  guide, walked through every chapter with the panel open, reads light over
  the statement, agents and control chapters and dark over the system card,
  growth card, cloud and close. No horizontal overflow at 390 px (the phone
  capsule keeps the mark, not the wordmark). With the lens on, idling on
  the animated sky produced no long tasks. Building the maps first cost
  111 + 36 ms at 1x and 317 + 191 ms at 2x on the main thread; after
  mirroring the displacement map by quadrant, filling the flat interior of
  the light map in one pass, encoding to blobs asynchronously and scheduling
  the first build in idle time, the lab's desktop longest task fell from
  900 ms back to 319 ms.
- Navigation: clicking Agents then Cloud leaves `history.length` unchanged
  (2, 2, 2) and the URL at `/#agents`, then `/#cloud`; the logo returns to
  the top and clears the hash; Sign in plays the curtain (the sheet at
  286 px, 27 px, 0 px from covering at 120, 320 and 560 ms), `/login`
  arrives beneath it and it dissolves; Back then shows the landing (title,
  hero, `#agents` at 88 px from the top), Forward shows sign in again, and
  the sign-in page's logo returns to the landing under a `#08090d` sheet.
  No page errors (the starfield's zero-size `drawImage` during navigation is
  guarded).
- Loader: stepped frame by frame (assembly, register, star glint, beat) on
  both grounds; the boot splash lifted at 2.4 s and was gone at 3.2 s on a
  cold development landing, and at 1.3 s / 2.1 s on `/login`.
- Final run: 270 test files pass (5 skipped), lint and the type check are
  clean, the lab passes 20 of 20 with no unexpected errors. Development
  server figures: largest contentful paint 2,188 ms desktop cold (1,852 ms
  before the glass), 3,572 ms throttled; layout shift 0; longest task
  319 ms desktop, 2,095 ms throttled. One earlier lab run failed the
  contextual-suggestion check on a 15 s wait; the dismissal passed twice
  when run on its own and in the next full run.
- Not verified: Safari and Firefox (frosted fallback only, by design), a
  production build's figures, a real phone.

## Manual, in the desktop app's browser pane

- The opening renders its layers, the six-letter lettering as `h1` "Zenith",
  the marks row, and Gimbal with its light; Lenis is active (`html.lenis`);
  the masthead turns solid once the smoothed scroll settles.
- The pane cannot capture screenshots of this page, and its
  IntersectionObservers do not fire while the pane is hidden, which produced
  one false reading (the orbit cards "still hidden" after the fix). Headless
  captures were used for every visual judgement in this round.

## Not verified

- Real screen-reader runs (NVDA, VoiceOver). Structure was checked through
  roles, labels and the accessibility tree only.
- A production build's performance figures.
- Hover states (sheet glow and lift, orb and node hover) are CSS only and were
  not captured.
- The opening on a real high-density display: the starfield draws at up to 3×
  device pixels and the ridges are vectors, but the captures were made at 1×
  and 2× only.
- "Read the docs" in the agents chapter points at the workspace guide as a
  placeholder; the plugin documentation has no public home yet.
- Official Claude Code and Codex logos were not used; the agents chapter
  draws its own marks (a warm tile with an asterisk glyph, a dark tile with a
  hexagon) and names the products in text. Cloud marks come from Devicon with
  their notice in `public/cloud-logos`.
- The OG image route returns 500 on this development server with the original
  code as well; it was not changed beyond its two text lines.
- The glass guide was rendered in headless Chrome only. The masked lens ring
  (a backdrop filter inside a backdrop filter), the registered custom
  properties behind the pointer highlight and the clip-path expansion were not
  checked in Safari or Firefox; the panel keeps a solid fill and no rings
  where backdrop filters are unsupported, under reduced transparency and in
  forced colours.
