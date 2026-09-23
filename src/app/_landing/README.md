# app/_landing — Zenith's marketing surface

`landing.tsx` composes the page over one shared presentation state and keeps
Gimbal in the corner. The server page stays force-static and derives provider
availability from the registry after `ensureEngine()`; Oracle remains an
explicit roadmap-only row.

- `space-hero.tsx`, `starfield.tsx`, `hero-ridges.ts`: the opening sky with
  parallax layers, generated mountain ridges lit along the crest, the brand
  lettering as the headline, the real CTA and the marks row.
- `statement.tsx`: the pinned one-sentence statement and the "Only the real
  facts" strip.
- `before-chapter.tsx` (the system), `scenario-chapter.tsx` (growth),
  `agents-chapter.tsx`, `gimbal-chapter.tsx` (control), `cloud-orbit.tsx`
  (roadmap), `close-chapter.tsx`: the chapters, each a `section[data-chapter]`.
  `feature.module.css` is the two-column pattern with round-icon rows;
  `chapters.module.css` the shared chrome.
- `system-diagram.tsx`: HTML nodes laid out from the manifest, measured and
  connected with routed SVG edges.
- `landing-state.ts` (pure reducer, suggestion policy), `landing-experience.tsx`
  (provider, chapter tracker, engagement), `scenario.ts` (the example system,
  growth sizings, the light's story, agent sequence), `gimbal-guide.ts` (the
  curated guide: autonomy glosses, walkthroughs, suggestions, topics, context).
- `gimbal-companion.tsx`: the persistent character with its light and shadow,
  the suggestion bubble, the walkthrough callout and the liquid-glass question
  panel, which expands out of the corner (a clip-path animation).
- `landing-motion.ts`: GSAP and Lenis, lazy, reduced-motion gated. The only
  animation library use in the app; product UI stays on CSS.
- `landing.css`: the one language: porcelain and ink surfaces (`.zenith-ink`,
  `.zenith-ink-tokens`), the vermilion accent and its text-safe tints, the
  control family, masthead and footer.

No interaction contacts a provider or writes a workspace. Nothing on the page
shows source code, a terminal, JSON, an API request or configuration. Answers
are curated and say so; Navigator's authenticated endpoint is not exposed.
Product screens must not import from this folder. Shared corporate paths live
in `shell/brand-geometry`; cloud marks under `public/cloud-logos` carry their
own notice.
