# app/_landing — Zenith's marketing surface

`landing.tsx` composes focused chapters. It obtains the runtime-aware CTA once
and shares it, together with one deterministic demonstration state, across `/`.
The server page stays force-static and derives availability from the provider
registry after `ensureEngine()`; Oracle remains an explicit roadmap-only row.

- `landing-header`, `landing-hero`, `provider-chapter`, `landing-close`: authored
  presentation and real navigation. `landing-cta` renders the shared CTA.
- `demo-fixture.ts`: canonical synthetic Atlas manifests and product cost model.
- `use-revision-demo.ts`: explicit review/run/progress/restore/reset state machine.
- `change-demo.tsx`: resource inspection, plan, estimate, approval and audit trail.
- `model-surfaces.tsx`: four accessible views of that same selected fixture.
- `revision-scene.tsx`: progressive renderer lifetime and first-frame fallback.
- `revision-renderer.ts`: native Three geometry, illumination and finite motion.
- `revision-fallback.tsx`: deterministic matching vector projection.
- `gimbal-introduction.tsx`: neutral existing companion, state guide and autonomy
  explanations sourced from Navigator's client-safe vocabulary.
- `landing.css`: scoped editorial tokens and shared chapter layout. Scene/demo/
  model modules own their local rules.

No demo interaction contacts a provider or writes a workspace. All demo outcomes
remain simulated. Restoration retains the demo audit record; it illustrates
configuration restoration, not recovery of deleted data. Product screens must
not import from this folder. Shared corporate paths live in `shell/brand-geometry`.
