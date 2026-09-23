# Zenith — Your cloud, in full view

Selected creative direction and implementation reference for the public
landing. 23 September 2026. Supersedes the Atlas story and the revision
sculpture recorded in `zenith-reimagined-direction.md`. The identity (Shift
Register symbol, zenith vector lettering, Gimbal's rings) carries over; the
composition, palette and motion are new.

## Direction

Zenith is the point directly overhead. The page opens in that sky: a night
gradient thinning into a warm horizon, stars, a nebula haze, three mountain
ridges meeting under a beacon of light, and the brand lettering itself across
the whole viewport. "Welcome to zenith." Underneath, daylight: porcelain
ground, bold sans headlines, one paragraph at most, big rounded cards, and the
same example system in every demonstration. The page returns to night for the
cloud roadmap and the close. The personality is confident and playful in a few
words, never chatty; the honesty labels stay, small and near the numbers.

One language, everywhere: two surfaces (porcelain page, ink cards and night
chapters), one accent (the mark's vermilion), neutrals taken from the surface
at low alpha, one control family (pills, segmented pills, outline chips, round
icon tiles, hairline links), and one background flourish (a faint vermilion
glow from a corner of every ink surface). The indigo, violet, sunset, navy and
cold-blue palettes of earlier rounds are gone; the sky itself now runs from ink
to the vermilion horizon. Tokens and rules live in `landing.css` and
`docs/DESIGN.md`.

Reference: the pacing of wishlabs.ai (giant wordmark over atmosphere, a marks
row, a pinned word-by-word statement, a "real numbers" strip, cream body with
rounded cards, night closing). Nothing of theirs is reused; the structure is
the lesson.

## Sequence

1. **Sky** (`space-hero.tsx`). Layers with their own scroll depth: sky, nebula,
   starfield canvas, horizon glow, a haze band, three generated ridges, clouds
   and a film grain. The ridges come from `hero-ridges.ts`: ridged noise from
   fixed seeds (identical on the server and the client), 520 points each, a
   pointed summit under the zenith point, a rim-light band and a hairline
   along every crest, valley haze and atmospheric perspective from far to
   near, drawn in one 1600 × 1000 scene with `xMidYMax slice` so nothing
   stretches and the beacon and the mark sit exactly on the summit. The
   starfield paints a Milky Way band and dust once per resize at up to 3×
   device pixels, then the twinkling stars, with glints on the brightest.
   Two compositions share the sky. The default, "apex": "Welcome to" and
   the lettering wide and centred (`h1`, accessible name "Zenith", the letters
   tracked a little wider), the meaning of the word beneath in the serif
   ("ze·nith · the point of the sky directly overhead. The highest point."),
   an eight-point star glowing at the top of the ray that rises from the
   summit (`--summit-bottom` is measured so the ray always lands on the far
   ridge's crest; the star twinkles on a four-second cycle, sends a small wave
   of meteors when the pointer reaches it and a full wave when pressed, and the
   sky sends one or a few meteors of its own every nine to twenty-five
   seconds), the tagline "Your cloud, in full view." at the foot on the left,
   whose second word turns to "infra" and back every nine seconds with its
   comma, and the real runtime-aware CTA on the right. "Welcome to" sits at the
   lettering's top-left. "classic"
   (`?hero=classic`) is the earlier left-set opening with "See the system"
   and the mark resting on the summit. Both end with the marks Zenith works
   with (Claude Code, Codex, AWS, LocalStack, Kubernetes, Google Cloud, Azure,
   Oracle Cloud). Everything after the opening is two raised sheets, each
   with rounded shoulders and its own shadow, each sliding over what precedes
   it while that recedes at a third of the scroll and darkens: the porcelain
   sheet (`.zenith-sheet`, the chapters up to the control dial) starts exactly
   at the opening's foot, so none of it shows until the visitor scrolls, then
   slides over the sky; the ink sheet (`.zenith-sheet-ink`: the cloud chapter,
   the close and the footer) slides over the porcelain the same way
   (`useSheetHandoff`). The masthead turns solid when the porcelain's edge
   reaches it, and Gimbal stays out of the opening, rising into its corner
   once that edge has climbed into the upper third of the viewport.
   The landing hides the native scrollbar so nothing sits at the right edge.
   On portrait screens the star sits a fifth of the way down, the lettering
   below the centre of the sky (its centre near 60% of the height), and the
   mountains drop a little (12 svh) so the meaning line still clears the summit.
   On phones and small tablets (900 px and under) the opening is leaner: the
   real CTA moves into the masthead beside "Sign in" (the menu no longer
   repeats it), the marks row and the opening's own button are gone, the
   tagline sits bottom-left and the scroll cue bottom-right. Kubernetes uses
   a single-colour derivative of the Devicon mark (`kubernetes-mono.svg`) so
   its wheel survives the white filter; Oracle uses a viewBox-cropped copy
   (`oracle-mark.svg`). Availability for those marks is stated in the roadmap
   chapter, not here.
2. **Statement** (`statement.tsx`). One sentence, pinned, lit word by word as
   it scrolls. The only paragraph the page asks anyone to read.
3. **Only the real facts.** Four numbers that are true of the product: one
   typed definition, five autonomy levels, two agents linked in the browser,
   zero lines of code on the page. No customers, downloads or benchmarks.
4. **We map the system.** (`before-chapter.tsx`) The two-column feature: a bold
   line, a paragraph, three round-icon rows; beside them an ink card
   holding the interactive system: the current/proposed switch, the diagram
   with rounded glass parts and a light that travels the connections in story
   order (`FLOW_STORY`), three stats, the plan item by item behind a
   disclosure. Proposed connections march; nothing in the card is monospaced.
5. **What changes when you grow?** (`scenario-chapter.tsx`) One ink card:
   the traffic switch, five orbs (API, queue, workers, storage, database) that
   grow with the sizing and carry a replica count, traffic that flows faster
   between them, and the estimate beside with its one-line "what changed",
   the concept-preview pill and "How these numbers are made" behind a
   disclosure. The technical diagram with sizes and replicas is gone.
6. **Keep the tools you already use.** (`agents-chapter.tsx`) One wide tile:
   the flow from the agent (two app tiles, squircles in the products' own
   colours with drawn glyphs, not official logos) through the browser link
   and the prepared change to the approval gate. A pulse travels it and every
   station it has passed stays lit in the accent until the loop starts over;
   the four stations are the sequence's steps, with one short hint each.
   Three small cards state the boundaries; "Read the docs" points at the
   workspace guide until the plugin documentation has a home.
7. **And you stay in control.** (`gimbal-chapter.tsx`) A balanced two-column
   row: on the left the heading, one short description ("Gimbal works as far
   as you let it…"; the note that no workspace setting is changed here), the
   three marks for what never moves and "Read the docs"; on the right the
   dial (five notches, a needle, a readout and one serif line for what the
   level means). Left alone and in view, the dial turns through the levels on
   its own, up and then down, resting 3.4 s on each; a visitor's turn holds it
   for twelve seconds, a walkthrough holds it entirely, and it is still under
   a reduced-motion preference. The earlier ink card with the policy line and
   the example request is gone.
8. **Your cloud. Your call.** (`cloud-orbit.tsx`) The constellation, ported as
   designed, with registry availability beside each mark and managed hosting
   as a product vision.
9. **The system stays yours** and **Reach the zenith.** (`close-chapter.tsx`)
   Night again, in the original close's composition: the original close's
   fanned sheets (`zenith.manifest.json`, `Terraform / *.tf`,
   `Operations / README.md`) as night glass, fanning out as they come into
   view and lifting with a glow under the pointer, beside "The system stays
   yours."; then the serif invitation "Reach the zenith." with the tagline
   "Make your next change a clear one." (both accents in the mark's
   vermilion), the blueprint line, the real CTA and "Explore the guide" on the
   left and the large vermilion mark on the right; then the original footer
   (wordmark, "The next change, made tangible.", Sign in · Guide · GitHub, the
   GitHub link pointing at the public organisation page rather than the
   private repository).

The "After deployment" chapter was removed on request (too technical for the
page); its curated answer about observability stays in the guide. Every
corner on the page is rounded: switches and steps are pills, cards 22–30 px.

Gimbal (`gimbal-companion.tsx`) lives bottom-right from the first chapter on, staying out of the opening and rising into its corner as the sky scrolls past, on the product
renderer with the mood layer, its own light and shadow, the suggestion bubble,
walkthroughs and the curated question panel. See "Gimbal" below.

## Motion

`landing-motion.ts` owns every animation, on GSAP with Lenis smooth scrolling,
loaded lazily in the browser and gated by `prefers-reduced-motion:
no-preference` through `gsap.matchMedia`. Under a reduce preference nothing
moves: the page is laid out in its final state, the statement's words are
already lit, the starfield is a still drawing.

- Opening: letters rise one by one, then the welcome line, actions, tagline
  and marks; on scroll each sky layer moves at its own depth (`data-speed`)
  while the wordmark recedes and fades.
- Statement: a scrubbed stagger over `[data-word]`.
- Reveals: `[data-reveal]` under a chapter rises once, grouped by
  `[data-reveal-group]`.
- Numbers: `useCountUp` tweens an estimate when a control changes;
  `useCountOnView` counts the facts up once.
- System: `useSystemFlow` moves a light along the measured edges with
  MotionPathPlugin, lighting each part it reaches, looping while on screen and
  rebuilt when the edges are re-measured.
- Agents: `useFlowMotion` runs the pulse across the stations and holds it at
  the approval gate.
- Control: the dial's needle and arc are CSS transitions on `--notch`.
- Orbit: cards drift on their orbits; the core breathes.
- Close: `useFan` fans the sheets out (`--fan` 0 → 1) the first time they are
  seen; the idle bob and the hover lift are CSS.
- One-shot reveals use an IntersectionObserver (`onceVisible`) rather than
  ScrollTrigger's `once`, which did not fire reliably under Lenis; reveal
  tweens overwrite only conflicting properties so they never kill another
  hook's tween on the same element.
- Masthead: transparent over the sky, porcelain glass afterwards.

The starfield (`starfield.tsx`) is a canvas that draws at most 30 times a
second, only while visible and the tab is active.

## One example system, one shared state

Unchanged from the first cut: `scenario.ts` holds the upload-and-process
application as real product manifests, priced by `@/lib/cost/pricing` ($22 →
$30, +$8 a month) and diffed by `diffManifests`; `landing-state.ts` holds the
presentation state every chapter and Gimbal read; walkthroughs add emphasis
and never change selections; suggestions follow the session rules (12 s
settled reading, once per chapter, 45 s cooldown, four per session, dismissed
for the session).

## Gimbal

The product renderer, porcelain material, with the personality mood layer
(`idle`, `attentive`, `engaged`, `thinking`, `delighted`, `cautious`,
`pleased`) that changes pace, expression and ring choreography and never the
workflow accent. Home is the bottom-right corner (hidden while the opening is on screen, unless the guide or a walkthrough is in use), 128 px on desktop and 76 px
on phones, floating above the page edge with a soft light and a shadow so it
reads on the sky, on porcelain and on night, and an "Ask Gimbal" label under
it. Hover glances; click opens the guide; walkthrough steps set moods;
warnings are calm. The hero's scroll cue sits bottom-left, the marks row and
the footer end clear of the corner. In the opening, a dismissible invitation
("Let me show you around") starts the system tour.

The guide panel is the design from the earlier Codex work, ported and wired
to this page's curated guide: a liquid-glass card in the ink family (a calm
frosted body; a one-pixel rim lit from the top-left and warmed by Gimbal's
glow at the bottom-right; a brighter lens ring just inside the edge where the
glass bends the light; one broad shadow; a highlight that follows the
pointer) with a serif title ("A little perspective."), the label "Ask Gimbal · Answers from the Zenith team", the
"You're looking at" context line, a conversation log with question bubbles and
answers (each answer may carry a "Show me" walkthrough), suggestion chips for
the chapter and an auto-growing prompt bar; the quiet-mode toggle is the bell
in the header. The panel expands out of the character's corner as a growing
rounded shape (780 ms on a spring-like curve; the content stays sharp and
materialises inside it while a sheen passes once) and collapses back into the
corner in 260 ms; the character settles back a touch while it is open. On phones it is a modal sheet
with a scrim and a focus trap.

The panel's "Looking at" line states the chapter and the selection. Answers
come from a curated guide written against what ships; the label says they are
written by the Zenith team, and asked directly ("Are you a live AI?") Gimbal
says it is not a live model on this page. The rings run quicker on the landing
than in the product (a tempo multiplier on the renderer), quicker still under
the pointer or while the guide is open, with a flourish on every tap.

## Honesty labels on the page

- Facts: only product facts; no customers, downloads or benchmarks.
- Growth: "Concept preview · illustrative"; "How these numbers are made"
  behind a disclosure with "It does not forecast traffic".
- Control: "no workspace setting is changed here", in the description.
- Cloud: registry availability beside each mark; "Zenith-managed · Product
  vision"; "What can I use today?".
- Close: "Roadmap · compliance assistance for human review, not automation".

## Discrepancies found while writing the copy

- The shared autonomy copy says bounded "asks for the rest"; the executor
  refuses medium- and high-risk steps at bounded. The card says so.
- The shared copy says autonomous executes "inside your policies and budgets";
  budgets only warn and autonomous is enforced like approve. The card adds
  that every level starts from Run.
- The dial calls the level a workspace setting; it is stored once per install.
- Azure is "planned" in the registry and "coming later" in older copy. The
  page follows the registry.
- Logs and health are simulated on every provider, not only the sandbox.

## Dependencies added

`gsap` (motion, ScrollTrigger) and `lenis` (smooth scrolling), both used only
by the landing and loaded lazily in the browser. `docs/DESIGN.md` keeps the
product UI on CSS transitions; the landing is the stated exception.

## Verification

`zenith-landing-verification.md` records what was run and what was not.
