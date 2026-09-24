# Bento finish pass

Builds on the React Bits-inspired microinteraction work in `landing-microinteractions.md`.
The accepted card layout, color blocks, visible copy, real fixture values and hero are unchanged.

## Art direction

- A thin, cursor-lit rim replaces the white wash across card content. The mask is progressive enhancement; the existing surface remains intact without it.
- Quiet inset edges and grounded shadows give the cards and system nodes a material hierarchy without tilting paragraphs.
- Cloud artwork receives at most ±4px horizontal and ±3px vertical depth. Only the interior illustration moves. The system map's hit targets and connections stay fixed; only its small icons respond.
- The plan's back sheet opens slightly; exports catch a restrained specular highlight. Selection remains immediate.
- Native provider/growth disclosures animate their height where `interpolate-size` is supported. Other browsers retain native details behavior.

## Choreography and constraints

The old entrance moved the entire card, while gliding selectors also measured it. The new controller leaves the card coordinate space fixed. A surface fade, then heading and artwork settling, creates a short sequence. Row-mate delays are capped at 110ms. Each card plays once.

Focus or pointerdown instantly settles the relevant reveal. Leaving the viewport, hiding the document, reduced motion, or forced colors cancels only animations owned by this controller. The existing agent/hosting loops retain their own controls and are not restarted or canceled.

Pointer depth uses the existing single delegated pointer-frame controller. Pointer cancel, scroll, resize, window blur, keyboard focus and cleanup all recenter it. No idle animation loop, new library, backend request or product-state timer.

## Verification

- `tests/landing/bento-reveal.test.tsx`: one-shot lifecycle, bounded DOM-order staggering, stable card coordinates, interaction interruption, independent loops, reduced motion, forced colors, visibility, cleanup and bounded/recentered pointer depth.
- `scripts/landing-polish-browser.ts`: runs a production Next server with the actual application modules, fonts, logos and fixtures; checks six viewport widths, native controls, shared views, disclosure focus, pause controls and reduced motion; saves screenshots and JSON outside the repository.
- `.github/workflows/landing-visual.yml`: read-only PR check using the repo's Node/checkout/setup pins and Chromium already available on the runner. Only screenshots, results and server logs are uploaded; no private environment/data directory is included. No deployment or repository write.

Research references: [Element.animate](https://developer.mozilla.org/en-US/docs/Web/API/Element/animate), [reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion), and the source review in the preceding microinteraction note.
